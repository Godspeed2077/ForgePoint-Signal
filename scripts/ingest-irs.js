require('dotenv').config();

const Parser = require('rss-parser');
const cheerio = require('cheerio');
const Anthropic = require('@anthropic-ai/sdk');
const { isRelevant: isTopical, CORE_KEYWORDS } = require('./keywords.js');

// RSS candidates tried in order. The first one that parses with >0 items wins.
// We always *also* scrape the monthly HTML archive pages (below) so a single
// run sees roughly the past IRS_LOOKBACK_DAYS of releases, not just whatever
// the RSS tail covers.
const RSS_CANDIDATES = [
  'https://www.irs.gov/rss/newsroom.xml',
  'https://www.irs.gov/newsroom/feed',
];
// IRS news releases are organized into per-month archive pages; we walk back
// month-by-month across the lookback window. The current-month canonical
// URL is always included as the first candidate.
const IRS_LOOKBACK_DAYS = 90;
const CURRENT_MONTH_URL = 'https://www.irs.gov/newsroom/news-releases-for-current-month';
const NEWSROOM_FALLBACK = 'https://www.irs.gov/newsroom';
const UA =
  'Mozilla/5.0 (compatible; ForgePointSignal/1.0; +https://forgepointsignal.com)';
// Hard cap so a flood of matched items can't blow the workflow timeout.
// Items are pre-sorted newest-first by RSS / index page; we keep the
// first MAX_ARTICLES after keyword filtering and skip the rest.
const MAX_ARTICLES = 10;
// Per-fetch timeout for HTTP retrievals (archive index pages and article
// bodies). A single slow IRS response shouldn't stall the whole run.
const FETCH_TIMEOUT_MS = 5000;

const parser = new Parser({ timeout: 20000, headers: { 'User-Agent': UA } });

// Build the list of monthly archive URLs covering the lookback window.
// Pattern: /newsroom/news-releases-for-{month-name}-{year}, e.g.
// /newsroom/news-releases-for-january-2026. URLs that don't exist 404
// and are skipped with a log line — no error.
function monthlyArchiveUrls(lookbackDays = IRS_LOOKBACK_DAYS) {
  const urls = [CURRENT_MONTH_URL];
  const now = new Date();
  const months = Math.ceil(lookbackDays / 30) + 1;
  for (let i = 0; i < months; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const monthName = d
      .toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })
      .toLowerCase();
    const year = d.getUTCFullYear();
    urls.push(`https://www.irs.gov/newsroom/news-releases-for-${monthName}-${year}`);
  }
  // Last-resort: the newsroom root, in case the per-month URL pattern
  // changes upstream and we'd otherwise return zero items.
  urls.push(NEWSROOM_FALLBACK);
  return [...new Set(urls)];
}

// Topical filter — defers to the shared CORE_KEYWORDS list so the
// Federal Register and IRS pipelines stay in lockstep.
function matches(...texts) {
  return isTopical(...texts);
}

function toIsoDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

async function httpGet(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`GET ${url} ${res.status}`);
    }
    return await res.text();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`GET ${url} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function tryRss(url) {
  console.log(`  RSS try: ${url}`);
  try {
    const feed = await parser.parseURL(url);
    const items = (feed.items || []).map((it) => ({
      title: it.title || '',
      link: it.link || '',
      pubDate: it.isoDate || it.pubDate || null,
      content: it.contentSnippet || it.content || it.description || '',
      guid: it.guid || null,
      categories: it.categories || [],
      creator: it.creator || null,
    }));
    console.log(`    -> ${items.length} items, feed title="${feed.title || ''}"`);
    return items;
  } catch (err) {
    console.log(`    -> fail: ${err.message}`);
    return null;
  }
}

async function scrapeIndex(url) {
  console.log(`  HTML scrape: ${url}`);
  const html = await httpGet(url);
  const $ = cheerio.load(html);
  const seen = new Set();
  const items = [];

  // Pull all anchor tags pointing at /newsroom/<slug> article pages.
  // Exclude the index itself and obvious non-article paths.
  $('a[href^="/newsroom/"], a[href^="https://www.irs.gov/newsroom/"]').each(
    (_, el) => {
      const href = ($(el).attr('href') || '').trim();
      const title = $(el).text().replace(/\s+/g, ' ').trim();
      if (!href || !title) return;

      const abs = new URL(href, 'https://www.irs.gov').toString();
      const path = new URL(abs).pathname.replace(/\/+$/, '');

      // Skip index-y or filter pages
      if (
        path === '/newsroom' ||
        path === '/newsroom/news-releases-for-current-month' ||
        path.startsWith('/newsroom/topic/') ||
        path.startsWith('/newsroom/irs-guidance')
      ) {
        return;
      }
      // Skip short titles that are typically navigation chrome
      if (title.length < 12) return;
      if (seen.has(abs)) return;
      seen.add(abs);

      // Try to pick a date from a nearby element
      const dateText =
        $(el).parent().find('time').first().text() ||
        $(el).closest('li, article, .views-row').find('time').first().text() ||
        '';

      items.push({
        title,
        link: abs,
        pubDate: dateText || null,
        content: '', // filled in by fetchArticleContent later
        guid: null,
        categories: [],
        creator: null,
      });
    },
  );

  console.log(`    -> ${items.length} candidate article links`);
  return items;
}

async function fetchArticleContent(url) {
  const html = await httpGet(url);
  const $ = cheerio.load(html);
  // IRS Drupal site: content tends to live in .field--name-body or <article> / <main>
  const candidates = [
    '.field--name-body',
    'article .content',
    'article',
    'main [role="main"]',
    'main',
    'body',
  ];
  let text = '';
  for (const sel of candidates) {
    const node = $(sel).first();
    if (node.length) {
      text = node.text();
      if (text.trim().length > 100) break;
    }
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, 8000);
}

async function loadItems() {
  const merged = new Map(); // article URL -> item
  let rssWon = null;

  // RSS first — gives content snippets for free; useful for fresh recent items.
  for (const url of RSS_CANDIDATES) {
    const rss = await tryRss(url);
    if (rss && rss.length > 0) {
      rssWon = url;
      for (const it of rss) {
        if (it.link) merged.set(it.link, it);
      }
      break;
    }
  }
  if (!rssWon) {
    console.log('  No RSS feed responded; relying on HTML archive scrape only.');
  }

  // Monthly archive scrape — covers the full IRS_LOOKBACK_DAYS window.
  const archiveUrls = monthlyArchiveUrls();
  console.log(
    `  HTML archive scrape across ${archiveUrls.length} pages (lookback=${IRS_LOOKBACK_DAYS}d)`,
  );
  let archivePagesOk = 0;
  for (const url of archiveUrls) {
    try {
      const items = await scrapeIndex(url);
      archivePagesOk += items.length > 0 ? 1 : 0;
      for (const it of items) {
        if (it.link && !merged.has(it.link)) merged.set(it.link, it);
      }
    } catch (err) {
      console.log(`    archive ${url} failed: ${err.message}`);
    }
  }

  if (merged.size === 0) {
    throw new Error('No items available from RSS or HTML archive sources.');
  }

  return {
    sourceKind: rssWon && archivePagesOk > 0 ? 'rss+html' : rssWon ? 'rss' : 'html',
    sourceUrl: rssWon || archiveUrls[0],
    items: [...merged.values()],
    archivePagesOk,
  };
}

const EXTRACT_SYSTEM = `You classify and extract metadata from IRS Newsroom items for an audience of estate planners, trust attorneys, and family-office advisors.

An item IS relevant if it is directly about any of:
- estate tax, gift tax, generation-skipping transfer tax, inheritance tax
- Form 706, Form 709
- estate planning, applicable exclusion / unified credit
- trust taxation and trust administration (grantor trusts, fiduciary income tax)
- Internal Revenue Code Subtitle B (Chapters 11, 12, 13)
- fiduciary duties for trusts, estates, or retirement plans
- probate
- charitable giving and tax-exempt structures: 501(c)(3) public charities, private foundations, donor-advised funds, charitable remainder / lead trusts, charitable deductions
- basis step-up at death
- qualified opportunity zones
- retirement accounts as estate-planning vehicles: IRAs, required minimum distributions, inherited IRAs
- life insurance and annuities used for wealth transfer
- state-level estate or inheritance tax
- family-office and high-net-worth wealth-transfer rules

An item is NOT relevant if it is primarily about: pure individual or corporate income tax (with no trust/estate intersection), payroll or employment tax, excise tax, scam alerts, identity-theft warnings, taxpayer-assistance announcements, or anything that only mentions estate/gift/trust topics in passing.

Return ONLY a JSON object with these keys:
- "relevant": true if the item is directly about the topics above, otherwise false.
- "summary": plain-English summary, UNDER 150 words, written for an estate / trust / wealth-management professional. No preamble. (Null when relevant=false.)
- "impact_level": "low", "medium", or "high". Routine reminder = low; new procedure or form affecting many filers = medium; change to exemption amounts, rates, fiduciary obligations, or core compliance = high. (Null when relevant=false.)
- "effective_date": ISO date (YYYY-MM-DD) if explicitly stated, otherwise null. Do not guess.
- "category": "estate", "gift", "trust", or "tax". Pick the single best fit. (Null when relevant=false.)

No other keys. No markdown. No commentary.`;

function buildUserPrompt(item) {
  return [
    `Title: ${item.title || ''}`,
    `Publication date: ${item.pubDate || ''}`,
    `URL: ${item.link || ''}`,
    `Categories: ${(item.categories || []).join(', ') || '(none)'}`,
    '',
    'Content:',
    item.content || '(no content)',
  ].join('\n');
}

function parseExtraction(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`No JSON object in model response: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(match[0]);
  const relevant = parsed.relevant === true;
  const level = String(parsed.impact_level || '').toLowerCase();
  const cat = String(parsed.category || '').toLowerCase();
  return {
    relevant,
    summary: relevant && typeof parsed.summary === 'string' ? parsed.summary.trim() : null,
    impact_level: relevant && ['low', 'medium', 'high'].includes(level) ? level : null,
    effective_date: parsed.effective_date || null,
    category: relevant && ['estate', 'gift', 'trust', 'tax'].includes(cat) ? cat : null,
  };
}

async function extractWithClaude(client, item) {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: [
      {
        type: 'text',
        text: EXTRACT_SYSTEM,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: buildUserPrompt(item) }],
  });
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('No text block in Claude response');
  console.log(
    `    claude raw (${textBlock.text.length} chars): ${textBlock.text.replace(/\s+/g, ' ').slice(0, 200)}`,
  );
  return parseExtraction(textBlock.text);
}

async function postEntry(apiBase, apiKey, entry) {
  const url = `${apiBase.replace(/\/+$/, '')}/entries`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify(entry),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`POST ${url} ${res.status}: ${body}`);
  }
  console.log(`    POST ${res.status} -> ${body.slice(0, 120)}`);
  return body ? JSON.parse(body) : null;
}

async function main() {
  const apiBase = process.env.FORGEPOINT_API_URL;
  const apiKey = process.env.INGEST_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!apiBase) throw new Error('FORGEPOINT_API_URL is required');
  if (!apiKey) throw new Error('INGEST_API_KEY is required');
  if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY is required');

  const client = new Anthropic({ apiKey: anthropicKey });

  console.log(`Config: apiBase=${apiBase}`);
  console.log(
    `Loading IRS items (keywords: ${CORE_KEYWORDS.slice(0, 8).join(', ')}, ...)`,
  );

  const { sourceKind, sourceUrl, items, archivePagesOk } = await loadItems();
  console.log(
    `Source: kind=${sourceKind} url=${sourceUrl} items=${items.length} archive_pages_ok=${archivePagesOk ?? 0}`,
  );
  if (items.length > 0) {
    console.log(
      `  first: "${(items[0].title || '').slice(0, 70)}" pub=${items[0].pubDate || '?'}`,
    );
  }

  // Title-only keyword filter, run BEFORE any per-article body fetch so we
  // never spend bandwidth on articles whose title is obviously off-topic.
  // The Claude relevance gate later re-checks against the body for items
  // that pass the title filter.
  const matched = items.filter((it) => matches(it.title));
  console.log(`Title-matched ${matched.length}/${items.length} by keywords.`);
  if (matched.length === 0) {
    console.log('No matching items. Done.');
    return;
  }

  // Hard cap so the run finishes inside the workflow timeout.
  let processList = matched;
  if (matched.length > MAX_ARTICLES) {
    console.log(
      `Capping at MAX_ARTICLES=${MAX_ARTICLES} (matched ${matched.length}); processing the newest ${MAX_ARTICLES} and deferring the rest.`,
    );
    processList = matched.slice(0, MAX_ARTICLES);
  }

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const item of processList) {
    if (!item.link || !item.title) {
      skipped += 1;
      console.log(`  SKIP: missing link or title`);
      continue;
    }
    console.log(`\nProcessing: "${item.title.slice(0, 70)}"`);

    // RSS items already carry a content snippet; HTML-scraped items don't,
    // so fetch the article body for Claude to read. Either way we only do
    // this for items that already passed the title-only keyword filter.
    if (!item.content) {
      try {
        item.content = await fetchArticleContent(item.link);
        console.log(`    fetched article: ${item.content.length} chars`);
      } catch (err) {
        failed += 1;
        console.error(`  FAIL fetch "${item.title.slice(0, 60)}": ${err.message}`);
        continue;
      }
    }

    try {
      const extracted = await extractWithClaude(client, item);
      // Claude relevance gate: even if the item passed the keyword filter,
      // skip if Claude reads the body and decides it isn't actually about
      // estate / gift / GST / trust tax.
      if (!extracted.relevant) {
        skipped += 1;
        console.log(`    SKIP (claude relevant=false)`);
        continue;
      }
      console.log(
        `    parsed: category=${extracted.category} impact=${extracted.impact_level} effective=${extracted.effective_date} summary_chars=${extracted.summary?.length ?? 0}`,
      );

      const entry = {
        published_date: toIsoDate(item.pubDate),
        source: 'IRS',
        jurisdiction: 'federal',
        category: extracted.category,
        title: item.title,
        summary: extracted.summary,
        source_url: item.link,
        effective_date: extracted.effective_date,
        impact_level: extracted.impact_level,
        raw_json: {
          guid: item.guid,
          categories: item.categories,
          creator: item.creator,
          pub_date_raw: item.pubDate,
          source_kind: sourceKind,
          source_url_discovered_from: sourceUrl,
        },
      };
      await postEntry(apiBase, apiKey, entry);
      created += 1;
    } catch (err) {
      failed += 1;
      console.error(`  FAIL "${item.title.slice(0, 60)}": ${err.message}`);
    }
  }

  console.log(
    `\nDone. Source=${sourceKind}. Matched: ${matched.length}. Processed: ${processList.length}. Created/updated: ${created}. Skipped: ${skipped}. Failed: ${failed}.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
