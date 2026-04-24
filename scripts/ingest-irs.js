require('dotenv').config();

const Parser = require('rss-parser');
const Anthropic = require('@anthropic-ai/sdk');

const RSS_URL = 'https://www.irs.gov/newsroom/feed';
const KEYWORDS = [
  'estate tax',
  'gift tax',
  'inheritance',
  'trusts',
  'form 706',
  'form 709',
  'generation-skipping',
  'generation skipping',
];

const parser = new Parser({ timeout: 20000 });

function haystack(item) {
  return [item.title, item.contentSnippet, item.content, item.description]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function matches(item) {
  const s = haystack(item);
  if (!s) return false;
  return KEYWORDS.some((k) => s.includes(k.toLowerCase()));
}

const EXTRACT_SYSTEM = `You extract structured metadata from IRS Newsroom items about U.S. federal estate, gift, trust, and inheritance tax.

Return ONLY a JSON object with these keys:
- "summary": plain-English summary, UNDER 150 words, written for a tax professional. No preamble.
- "impact_level": one of "low", "medium", "high". Routine guidance or reminders are "low"; new procedures or forms affecting many filers are "medium"; changes to exemption amounts, rates, or core compliance obligations are "high".
- "effective_date": ISO date (YYYY-MM-DD) if explicitly stated in the item, otherwise null. Do not guess.
- "category": one of "estate", "gift", "trust", "tax". Pick the single best fit.

No other keys. No markdown. No commentary.`;

function buildUserPrompt(item) {
  return [
    `Title: ${item.title || ''}`,
    `Publication date: ${item.isoDate || item.pubDate || ''}`,
    `URL: ${item.link || ''}`,
    `Categories: ${(item.categories || []).join(', ') || '(none)'}`,
    '',
    'Content:',
    item.contentSnippet || item.content || item.description || '(no content)',
  ].join('\n');
}

function parseExtraction(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`No JSON object in model response: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(match[0]);
  const level = String(parsed.impact_level || '').toLowerCase();
  const cat = String(parsed.category || '').toLowerCase();
  return {
    summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : null,
    impact_level: ['low', 'medium', 'high'].includes(level) ? level : null,
    effective_date: parsed.effective_date || null,
    category: ['estate', 'gift', 'trust', 'tax'].includes(cat) ? cat : null,
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

function toIsoDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

async function main() {
  const apiBase = process.env.FORGEPOINT_API_URL;
  const apiKey = process.env.INGEST_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!apiBase) throw new Error('FORGEPOINT_API_URL is required');
  if (!apiKey) throw new Error('INGEST_API_KEY is required');
  if (!anthropicKey) throw new Error('ANTHROPIC_API_KEY is required');

  const client = new Anthropic({ apiKey: anthropicKey });

  console.log(`Config: apiBase=${apiBase} rss=${RSS_URL}`);
  console.log(`Fetching IRS newsroom feed...`);

  let feed;
  try {
    feed = await parser.parseURL(RSS_URL);
  } catch (err) {
    throw new Error(`RSS fetch failed: ${err.message}`);
  }
  const items = feed.items || [];
  console.log(
    `  fetched ${items.length} items from "${feed.title || 'IRS Newsroom'}" (keywords: ${KEYWORDS.join(', ')})`,
  );
  if (items.length > 0) {
    const first = items[0];
    console.log(
      `  first: "${(first.title || '').slice(0, 70)}" (${first.pubDate || first.isoDate || '?'})`,
    );
  }

  const matched = items.filter(matches);
  console.log(`  ${matched.length}/${items.length} items match keywords.`);

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
      console.log(`  SKIP: missing link or title (guid=${item.guid || 'n/a'})`);
      continue;
    }
    console.log(`\nProcessing: "${item.title.slice(0, 70)}"`);
    try {
      const extracted = await extractWithClaude(client, item);
      console.log(
        `    parsed: category=${extracted.category} impact=${extracted.impact_level} effective=${extracted.effective_date} summary_chars=${extracted.summary?.length ?? 0}`,
      );

      const entry = {
        published_date: toIsoDate(item.isoDate || item.pubDate),
        source: 'IRS',
        jurisdiction: 'federal',
        category: extracted.category,
        title: item.title,
        summary: extracted.summary,
        source_url: item.link,
        effective_date: extracted.effective_date,
        impact_level: extracted.impact_level,
        raw_json: {
          guid: item.guid || null,
          categories: item.categories || [],
          creator: item.creator || null,
          pub_date: item.pubDate || null,
          description: item.contentSnippet || item.description || null,
        },
      };
      await postEntry(apiBase, apiKey, entry);
      created += 1;
    } catch (err) {
      failed += 1;
      console.error(`  FAIL "${item.title?.slice(0, 60)}": ${err.message}`);
    }
  }

  console.log(
    `\nDone. Matched: ${matched.length}. Created/updated: ${created}. Skipped: ${skipped}. Failed: ${failed}.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
