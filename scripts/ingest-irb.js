require('dotenv').config();

const cheerio = require('cheerio');
const Anthropic = require('@anthropic-ai/sdk');
const { isRelevant, CORE_KEYWORDS } = require('./keywords.js');
const { makeSupabaseClient, entryExists } = require('./dedup.js');

const DEFAULT_LOOKBACK_DAYS = 60;
const LOOKBACK_DAYS = parseInt(process.env.LOOKBACK_DAYS, 10) || DEFAULT_LOOKBACK_DAYS;
const FETCH_TIMEOUT_MS = 8000;
const CLAUDE_TIMEOUT_MS = 25000;
const UA = 'Mozilla/5.0 (compatible; ForgePointSignal/1.0; +https://forgepointsignal.com)';
const CITATION_RE = /\b(Rev\.\s*Rul\.|Rev\.\s*Proc\.|Notice|Ann\.)\s+(\d{4}-\d+)/gi;

function getIssuesInWindow(lookbackDays) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - lookbackDays * 86400000);
  const issues = [];
  function weekOfYear(date) {
    const start = new Date(date.getFullYear(), 0, 1);
    return Math.ceil(((date - start) / 86400000 + 1) / 7);
  }
  let year = now.getFullYear();
  let week = weekOfYear(now);
  while (true) {
    const issueDate = new Date(year, 0, 1 + (week - 1) * 7);
    if (issueDate < cutoff || year < 2020) break;
    issues.push({
      year,
      week,
      url: `https://www.irs.gov/irb/${year}-${String(week).padStart(2, '0')}_IRB`,
    });
    week--;
    if (week < 1) {
      week = 52;
      year--;
    }
  }
  return issues;
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA } });
  } finally {
    clearTimeout(timer);
  }
}

// Heading text that introduces a TOC section listing documents
// PUBLISHED IN this issue. We restrict citation extraction to anchors
// inside these sections, so historical cross-references in supersession
// tables and footnotes elsewhere on the page don't leak into our feed.
//
// Headings are matched as the entire heading text (with flexible
// whitespace + optional trailing punctuation), to avoid false positives
// like "Notices to Practitioners" matching the "Notices" pattern.
const TOC_HEADING_PATTERNS = [
  /^\s*revenue\s+rulings?\s*[.:;]?\s*$/i,
  /^\s*revenue\s+procedures?\s*[.:;]?\s*$/i,
  /^\s*notices?\s*[.:;]?\s*$/i,
  /^\s*announcements?\s*[.:;]?\s*$/i,
  /^\s*treasury\s+decisions?\s*[.:;]?\s*$/i,
  /^\s*proposed\s+regulations?\s*[.:;]?\s*$/i,
];

function isTocHeading(text) {
  if (!text) return false;
  return TOC_HEADING_PATTERNS.some((re) => re.test(text));
}

async function parseIssue(issueUrl) {
  let res;
  try {
    res = await fetchWithTimeout(issueUrl);
  } catch (err) {
    console.log(`  -> fetch failed: ${err.message}`);
    return [];
  }
  if (!res.ok) {
    console.log(`  -> HTTP ${res.status}, skipping`);
    return [];
  }
  const html = await res.text();
  const $ = cheerio.load(html);

  const items = [];
  const seen = new Set();
  let tocSectionsFound = 0;

  // For each heading h1-h4 that names a TOC document-type section, take
  // the contents up to the next heading at the same or higher level
  // (cheerio's nextUntil) and pull citations only from anchor link text
  // inside that bounded region. This filters out historical cross-refs
  // like "supersedes Rev. Rul. 2002-10" that appear in footnotes or
  // tables outside the TOC.
  $('h1, h2, h3, h4').each((_, h) => {
    if (!isTocHeading($(h).text())) return;
    tocSectionsFound++;

    const section = $(h).nextUntil('h1, h2, h3, h4');
    section.find('a').each((_, a) => {
      const text = $(a).text().trim();
      if (!text) return;

      CITATION_RE.lastIndex = 0;
      const match = CITATION_RE.exec(text);
      if (!match) return; // not a citation link (e.g., back-to-top, nav)
      const citation = match[0].replace(/\s+/g, ' ').trim();
      if (seen.has(citation)) return;
      seen.add(citation);

      const href = $(a).attr('href') || '';
      const docUrl = href
        ? href.startsWith('http')
          ? href
          : `https://www.irs.gov${href}`
        : issueUrl;

      // Synopsis: the text of the surrounding list item / row / paragraph
      // — usually richer than the link text alone.
      const wrapper = $(a).closest('li, dt, dd, tr, p');
      const synopsis = wrapper.length
        ? wrapper.text().replace(/\s+/g, ' ').trim().slice(0, 800)
        : text;

      items.push({ citation, synopsis, url: docUrl, issueUrl });
    });
  });

  if (tocSectionsFound === 0) {
    console.log(
      `  -> no TOC sections recognized (looked for headings matching: Revenue Rulings, Revenue Procedures, Notices, Announcements, Treasury Decisions, Proposed Regulations) — skipping page`,
    );
  } else {
    console.log(
      `  -> ${tocSectionsFound} TOC section(s) parsed, ${items.length} citations extracted`,
    );
  }
  return items;
}

async function claudeEval(item, anthropic) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CLAUDE_TIMEOUT_MS);
  try {
    const msg = await anthropic.messages.create(
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [
          {
            role: 'user',
            content: `You monitor estate, gift, generation-skipping, and inheritance tax law for practitioners (attorneys, CPAs, fiduciaries, wealth managers).

IRB document:
Citation: ${item.citation}
Context: ${item.synopsis}

Is this relevant to: estate tax, gift tax, GST tax, trusts, inheritance, IRC 2001-2704, section 7520 rates, asset valuation, or planning vehicles (GRATs, QPRTs, FLPs, CRTs, IDGTs)?

JSON only, no markdown fences:
{"relevant":true/false,"summary":"1-2 sentence practitioner impact or null","impact_date":"YYYY-MM-DD or null","doc_type":"revenue_ruling|revenue_procedure|notice|announcement|other"}`,
          },
        ],
      },
      { signal: ctrl.signal, maxRetries: 0 },
    );
    return JSON.parse(msg.content[0].text.replace(/```json|```/g, '').trim());
  } catch (err) {
    if (err.name === 'AbortError' || /aborted|abort/i.test(err.message || '')) {
      console.log(`    FAIL claude: timed out after ${CLAUDE_TIMEOUT_MS}ms`);
    } else {
      console.log(`    FAIL claude: ${err.message}`);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function postEntryWithTimeout(apiBase, apiKey, entry) {
  const url = `${apiBase.replace(/\/+$/, '')}/entries`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify(entry),
      signal: ctrl.signal,
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`POST ${url} ${res.status}: ${body}`);
    return body ? JSON.parse(body) : null;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`POST ${url} timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const apiBase = process.env.FORGEPOINT_API_URL;
  const apiKey = process.env.INGEST_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!apiBase) throw new Error('FORGEPOINT_API_URL is required');
  if (!apiKey) throw new Error('INGEST_API_KEY is required');
  if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY is required');

  const supabase = makeSupabaseClient();
  console.log(
    `Config: lookback=${LOOKBACK_DAYS}d apiBase=${apiBase} precheck=${supabase ? 'on' : 'off'} keywords=[${CORE_KEYWORDS.slice(0, 4).join(', ')}, ...]`,
  );

  const anthropic = new Anthropic({ apiKey: anthropicKey });
  const issues = getIssuesInWindow(LOOKBACK_DAYS);
  console.log(`Checking ${issues.length} IRB issues within ${LOOKBACK_DAYS}-day window`);

  let totalFetched = 0;
  let keywordPassed = 0;
  let processed = 0;
  let created = 0;
  let alreadyStored = 0;
  let irrelevant = 0;
  let failed = 0;

  for (const issue of issues) {
    console.log(`\nFetching ${issue.url}`);
    const items = await parseIssue(issue.url);
    console.log(`  -> ${items.length} citations found`);
    totalFetched += items.length;

    for (const item of items) {
      const combined = `${item.citation} ${item.synopsis}`;
      if (!isRelevant(combined)) continue;
      keywordPassed++;

      if (await entryExists(supabase, item.url)) {
        console.log(`    SKIP (already stored): ${item.citation}`);
        alreadyStored++;
        continue;
      }

      console.log(`    Processing: ${item.citation}`);
      const ev = await claudeEval(item, anthropic);
      if (!ev) {
        failed++;
        continue;
      }
      if (!ev.relevant) {
        console.log(`    SKIP (irrelevant): ${item.citation}`);
        irrelevant++;
        continue;
      }
      processed++;

      // Map IRB-specific fields to the existing regulatory_entries schema:
      // - doc_type from Claude -> category column (semantic)
      // - raw_text + IRB metadata -> raw_json
      // - jurisdiction explicitly set to 'federal'
      // - impact_level intentionally unset (Claude prompt doesn't request it)
      const entry = {
        source_url: item.url,
        source: 'IRB',
        jurisdiction: 'federal',
        category: ev.doc_type || null,
        title: item.citation,
        summary: ev.summary || null,
        published_date: ev.impact_date || null,
        effective_date: ev.impact_date || null,
        raw_json: {
          irb_year: issue.year,
          irb_week: issue.week,
          irb_issue_url: item.issueUrl,
          synopsis: item.synopsis.slice(0, 2000),
        },
      };

      try {
        const result = await postEntryWithTimeout(apiBase, apiKey, entry);
        console.log(`    POST 201 -> id=${result?.id}`);
        created++;
      } catch (err) {
        console.log(`    FAIL post: ${item.citation} -- ${err.message}`);
        failed++;
      }
    }
  }

  console.log(
    `\nDone. Fetched: ${totalFetched}. Keyword-passed: ${keywordPassed}. Processed: ${processed}. Created/updated: ${created}. Already-stored: ${alreadyStored}. Irrelevant (claude): ${irrelevant}. Failed: ${failed}.`,
  );
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
