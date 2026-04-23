require('dotenv').config();

const Anthropic = require('@anthropic-ai/sdk');

const FEDERAL_REGISTER_ENDPOINT = 'https://www.federalregister.gov/api/v1/documents.json';
const DEFAULT_LOOKBACK_DAYS = 30;
const PER_PAGE = 100;
const SEARCH_TERMS = ['estate tax', 'gift tax'];

const FIELDS = [
  'document_number',
  'title',
  'abstract',
  'publication_date',
  'effective_on',
  'html_url',
  'type',
  'agencies',
  'topics',
  'citation',
];

function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

async function fetchFederalRegister(term, since) {
  const params = new URLSearchParams();
  params.set('per_page', String(PER_PAGE));
  params.set('order', 'newest');
  params.set('conditions[term]', term);
  params.set('conditions[publication_date][gte]', since);
  for (const f of FIELDS) params.append('fields[]', f);

  const url = `${FEDERAL_REGISTER_ENDPOINT}?${params.toString()}`;
  console.log(`  GET ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Federal Register API ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  const results = json.results || [];
  console.log(`    term="${term}" -> count=${json.count ?? 'n/a'} results=${results.length}`);
  if (results.length > 0) {
    const sample = results[0];
    console.log(`    first: ${sample.document_number} "${(sample.title || '').slice(0, 70)}" (${sample.publication_date})`);
  }
  return results;
}

function dedupeByDocumentNumber(docs) {
  const seen = new Map();
  for (const d of docs) {
    if (d.document_number && !seen.has(d.document_number)) {
      seen.set(d.document_number, d);
    }
  }
  return [...seen.values()];
}

const EXTRACT_SYSTEM = `You extract structured metadata from U.S. Federal Register documents about federal estate and gift tax regulations.

Return ONLY a JSON object with these keys:
- "summary": plain-English summary, UNDER 150 words, written for a tax professional. No preamble.
- "impact_level": one of "low", "medium", "high". Judge by scope: a technical correction is "low"; a notice of proposed rulemaking affecting many filers is "medium"; a final rule changing exemption amounts or core compliance obligations is "high".
- "effective_date": ISO date (YYYY-MM-DD) if explicitly stated in the document, otherwise null. Do not guess.

No other keys. No markdown. No commentary.`;

function buildUserPrompt(doc) {
  const agencies = (doc.agencies || []).map((a) => a.name).filter(Boolean).join(', ');
  const topics = (doc.topics || []).join(', ');
  return [
    `Title: ${doc.title || ''}`,
    `Type: ${doc.type || ''}`,
    `Publication date: ${doc.publication_date || ''}`,
    `Stated effective date: ${doc.effective_on || '(none)'}`,
    `Agencies: ${agencies || '(none)'}`,
    `Topics: ${topics || '(none)'}`,
    `Citation: ${doc.citation || ''}`,
    '',
    'Abstract:',
    doc.abstract || '(no abstract provided)',
  ].join('\n');
}

function parseExtraction(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`No JSON object in model response: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(match[0]);
  const level = String(parsed.impact_level || '').toLowerCase();
  return {
    summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : null,
    impact_level: ['low', 'medium', 'high'].includes(level) ? level : null,
    effective_date: parsed.effective_date || null,
  };
}

async function extractWithClaude(client, doc) {
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
    messages: [{ role: 'user', content: buildUserPrompt(doc) }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('No text block in Claude response');
  console.log(`    claude raw (${textBlock.text.length} chars): ${textBlock.text.replace(/\s+/g, ' ').slice(0, 200)}`);
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

  const lookback = Number.parseInt(process.env.LOOKBACK_DAYS || '', 10) || DEFAULT_LOOKBACK_DAYS;
  const since = daysAgo(lookback);

  const client = new Anthropic({ apiKey: anthropicKey });

  console.log(`Config: apiBase=${apiBase} lookback=${lookback}d since=${since} terms=${JSON.stringify(SEARCH_TERMS)}`);
  console.log(`Fetching Federal Register documents since ${since}...`);
  const batches = await Promise.all(SEARCH_TERMS.map((term) => fetchFederalRegister(term, since)));
  const docs = dedupeByDocumentNumber(batches.flat());
  console.log(`Found ${docs.length} unique documents across ${SEARCH_TERMS.length} search terms (before filtering).`);

  if (docs.length === 0) {
    console.log('No documents matched. Done.');
    return;
  }

  let created = 0;
  let failed = 0;

  let skipped = 0;
  for (const doc of docs) {
    if (!doc.html_url || !doc.title) {
      skipped += 1;
      console.log(`  SKIP ${doc.document_number}: missing html_url or title`);
      continue;
    }
    console.log(`\nProcessing ${doc.document_number}: "${doc.title.slice(0, 70)}"`);
    try {
      const extracted = await extractWithClaude(client, doc);
      console.log(`    parsed: impact=${extracted.impact_level} effective=${extracted.effective_date} summary_chars=${extracted.summary?.length ?? 0}`);
      const agencyNames = (doc.agencies || []).map((a) => a.name).filter(Boolean);
      const entry = {
        published_date: doc.publication_date || null,
        source: 'Federal Register',
        jurisdiction: 'US Federal',
        category: doc.type || null,
        title: doc.title,
        summary: extracted.summary,
        source_url: doc.html_url,
        effective_date: extracted.effective_date || doc.effective_on || null,
        impact_level: extracted.impact_level,
        raw_json: {
          document_number: doc.document_number,
          citation: doc.citation,
          agencies: agencyNames,
          topics: doc.topics || [],
          abstract: doc.abstract,
        },
      };
      await postEntry(apiBase, apiKey, entry);
      created += 1;
    } catch (err) {
      failed += 1;
      console.error(`  FAIL ${doc.document_number}: ${err.message}`);
    }
  }

  console.log(`\nDone. Fetched: ${docs.length}. Created/updated: ${created}. Skipped: ${skipped}. Failed: ${failed}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
