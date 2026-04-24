require('dotenv').config();

const Parser = require('rss-parser');
const cheerio = require('cheerio');
const Anthropic = require('@anthropic-ai/sdk');
const { isRelevant: isTopical, CORE_KEYWORDS } = require('./keywords.js');

// RSS candidates tried in order. The first one that parses with >0 items wins.
// If all fail we fall back to HTML scraping of the Newsroom index.
const RSS_CANDIDATES = [
  'https://www.irs.gov/rss/newsroom.xml',
  'https://www.irs.gov/newsroom/feed',
];
const HTML_INDEX = 'https://www.irs.gov/newsroom/news-releases-for-current-month';
const HTML_INDEX_FALLBACK = 'https://www.irs.gov/newsroom';
const UA =
  'Mozilla/5.0 (compatible; ForgePointSignal/1.0; +https://forgepointsignal.com)';

const parser = new Parser({ timeout: 20000, headers: { 'User-Agent': UA } });

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

async function httpGet(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*' },
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`GET ${url} ${res.status}`);
  }
  return res.text();
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
  for (const url of RSS_CANDIDATES) {
    const rss = await tryRss(url);
    if (rss && rss.length > 0) {
      return { sourceKind: 'rss', sourceUrl: url, items: rss };
    }
  }
  console.log('  All RSS candidates failed or empty. Falling back to HTML scrape.');
  for (const indexUrl of [HTML_INDEX, HTML_INDEX_FALLBACK]) {
    try {
      const items = await scrapeIndex(indexUrl);
      if (items.length > 0) {
        return { sourceKind: 'html', sourceUrl: indexUrl, items };
      }
    } catch (err) {
      console.log(`  HTML scrape failed for ${indexUrl}: ${err.message}`);
    }
  }
  throw new Error('No items available from RSS or HTML sources.');
}

const EXTRACT_SYSTEM = `You classify and extract metadata from IRS Newsroom items.

ForgePoint Signal monitors ONLY items that are directly about U.S. federal:
- estate tax, gift tax, generation-skipping transfer tax, or inheritance tax
- Form 706, Form 709
- estate planning, applicable exclusion / unified credit
- trust taxation (grantor trusts, fiduciary income tax to the extent it intersects estate / gift / GST)
- Internal Revenue Code Subtitle B (Chapters 11, 12, 13)

An item is NOT relevant if it is primarily about: income tax (other than trust intersections), payroll/employment tax, excise tax, scam alerts, taxpayer-assistance announcements, identity theft, or any non-tax topic — even if it mentions "estate tax" or "gift tax" in passing.

Return ONLY a JSON object with these keys:
- "relevant": true if the item is directly about the topics above, otherwise false.
- "summary": plain-English summary, UNDER 150 words, written for a tax professional. No preamble. (Null when relevant=false.)
- "impact_level": "low", "medium", or "high". Routine reminders / scam alerts (if those slipped through) = low; new procedures or forms affecting many filers = medium; changes to exemption amounts, rates, or core compliance obligations = high. (Null when relevant=false.)
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

  const { sourceKind, sourceUrl, items } = await loadItems();
  console.log(`Source: kind=${sourceKind} url=${sourceUrl} items=${items.length}`);
  if (items.length > 0) {
    console.log(
      `  first: "${(items[0].title || '').slice(0, 70)}" pub=${items[0].pubDate || '?'}`,
    );
  }

  const matched = items.filter((it) => matches(it.title, it.content));
  console.log(`Matched ${matched.length}/${items.length} by keywords.`);
  if (matched.length === 0) {
    console.log('No matching items. Done.');
    return;
  }

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const item of matched) {
    if (!item.link || !item.title) {
      skipped += 1;
      console.log(`  SKIP: missing link or title`);
      continue;
    }
    console.log(`\nProcessing: "${item.title.slice(0, 70)}"`);

    // For HTML-scraped items we only have the link at this point —
    // fetch the article body so Claude has something to summarize.
    if (!item.content && sourceKind === 'html') {
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
    `\nDone. Source=${sourceKind}. Matched: ${matched.length}. Created/updated: ${created}. Skipped: ${skipped}. Failed: ${failed}.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
