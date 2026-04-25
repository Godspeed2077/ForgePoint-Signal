require('dotenv').config();

const cheerio = require('cheerio');
const Anthropic = require('@anthropic-ai/sdk');
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

// Real IRB pages have a synopsis list at the very top (citations + 1-2
// sentence summaries — this is what we want to ingest), followed by this
// disclaimer, followed by the full document text for each item. The full
// text is where the historical cross-references live: "Effects on Other
// Documents" tables, supersession lists, footnotes citing decades-old
// guidance. We anchor on the disclaimer phrase and parse only the HTML
// that precedes it, so historical citations in the document bodies can't
// leak into our feed.
const SYNOPSIS_DISCLAIMER = 'These synopses are intended only as aids';

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

  // Slice the raw HTML at the disclaimer phrase so we never see the
  // post-disclaimer document bodies. If the phrase isn't on the page we
  // skip the issue rather than falling back to a whole-page scan —
  // silent fallback would re-introduce the historical cross-reference
  // bug the user just fixed.
  const cutoff = html.indexOf(SYNOPSIS_DISCLAIMER);
  if (cutoff === -1) {
    console.log(
      `  -> "${SYNOPSIS_DISCLAIMER}" disclaimer not found on page; skipping (synopsis section couldn't be bounded)`,
    );
    return [];
  }
  const synopsisHtml = html.slice(0, cutoff);
  const $ = cheerio.load(synopsisHtml);

  const items = [];
  const seen = new Set();

  // Scan the synopsis-only DOM for citation patterns. Same regex-based
  // approach the script used originally — the bug was the scope, not the
  // regex. We walk a small set of element types because the synopsis
  // entries are typically paragraphs / list items / anchor links.
  $('h2,h3,h4,p,li,a,td').each((_, el) => {
    const tag = el.tagName.toLowerCase();
    const text = $(el).text();
    CITATION_RE.lastIndex = 0;
    let m;
    while ((m = CITATION_RE.exec(text)) !== null) {
      const citation = m[0].replace(/\s+/g, ' ').trim();
      if (seen.has(citation)) continue;
      seen.add(citation);

      const wrapper = $(el).closest('li, p, dt, dd, tr, section, div');
      let synopsis = wrapper.length
        ? wrapper.text().replace(/\s+/g, ' ').trim()
        : text.replace(/\s+/g, ' ').trim();

      // IRB synopsis sections often place the citation in one block and
      // its 1-2 sentence description in the next block (typical pattern:
      // <p>Rev. Rul. 2026-08</p><p>Announces interest rates for Q2 2026.</p>).
      // If we only captured the citation block itself, walk forward to
      // pick up the description so Claude has enough context to evaluate.
      // Stop walking if the next block starts a new citation — otherwise
      // we'd pollute this entry's synopsis with the next item's text.
      const NEXT_CITATION = /\b(Rev\.\s*Rul\.|Rev\.\s*Proc\.|Notice|Ann\.)\s+\d{4}-\d+/i;
      if (synopsis.length < 100 && wrapper.length) {
        let cursor = wrapper.next();
        let hops = 0;
        while (cursor.length && synopsis.length < 400 && hops < 3) {
          const extra = cursor.text().replace(/\s+/g, ' ').trim();
          if (extra) {
            if (NEXT_CITATION.test(extra)) break;
            synopsis = `${synopsis} ${extra}`.trim();
          }
          cursor = cursor.next();
          hops++;
        }
      }
      synopsis = synopsis.slice(0, 800);

      const anc = tag === 'a' ? $(el) : $(el).find('a').first();
      const href = anc.attr('href') || '';
      const docUrl = href
        ? href.startsWith('http')
          ? href
          : `https://www.irs.gov${href}`
        : issueUrl;

      items.push({ citation, synopsis, url: docUrl, issueUrl });
    }
  });

  console.log(
    `  -> synopsis section: ${synopsisHtml.length} bytes, ${items.length} citations extracted (page total: ${html.length} bytes)`,
  );
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
    // Extract the first JSON object out of the raw response. Claude
    // sometimes appends an explanatory sentence after a valid JSON
    // object (e.g. `{"relevant":true,...}\n\nThis appears to be...`),
    // which trips JSON.parse with "Unexpected non-whitespace character
    // after JSON". The regex grabs from the first { to the last } so
    // a single complete object is parsed and trailing prose ignored.
    const raw = msg.content[0].text.replace(/```json|```/g, '').trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error(`no JSON object in claude response: ${raw.slice(0, 200)}`);
    }
    return JSON.parse(jsonMatch[0]);
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
    `Config: lookback=${LOOKBACK_DAYS}d apiBase=${apiBase} precheck=${supabase ? 'on' : 'off'}`,
  );

  const anthropic = new Anthropic({ apiKey: anthropicKey });
  const issues = getIssuesInWindow(LOOKBACK_DAYS);
  console.log(`Checking ${issues.length} IRB issues within ${LOOKBACK_DAYS}-day window`);

  let totalFetched = 0;
  let processed = 0;
  let created = 0;
  let alreadyStored = 0;
  let noSynopsis = 0;
  let irrelevant = 0;
  let failed = 0;

  for (const issue of issues) {
    console.log(`\nFetching ${issue.url}`);
    const items = await parseIssue(issue.url);
    console.log(`  -> ${items.length} citations found`);
    totalFetched += items.length;

    // No keyword pre-filter on IRB. The synopsis section produces ~125
    // clean citations across a 365-day backfill; cheap enough to send
    // every one to Claude after the entryExists() dedup check.
    for (const item of items) {
      if (await entryExists(supabase, item.url)) {
        console.log(`    SKIP (already stored): ${item.citation}`);
        alreadyStored++;
        continue;
      }

      // Sending Claude a near-empty synopsis (just "Rev. Rul. 2026-08"
      // and nothing else) returns an "I don't have enough context"
      // refusal, which fails our JSON parse and lands as FAIL claude.
      // Skip those locally rather than burning a Claude call.
      // 40-char threshold: bare-citation synopses like "Rev. Rul. 2025-11"
      // (18 chars) cleared the previous 20-char gate but still left Claude
      // with no context, producing "I don't have" refusals. 40 chars
      // requires at least the citation plus a sentence fragment.
      const synopsisLen = (item.synopsis || '').trim().length;
      if (synopsisLen < 40) {
        console.log(
          `    SKIP (no synopsis, ${synopsisLen} chars): ${item.citation}`,
        );
        noSynopsis++;
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
    `\nDone. Fetched: ${totalFetched}. Processed: ${processed}. Created/updated: ${created}. Already-stored: ${alreadyStored}. No-synopsis: ${noSynopsis}. Irrelevant (claude): ${irrelevant}. Failed: ${failed}.`,
  );
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
