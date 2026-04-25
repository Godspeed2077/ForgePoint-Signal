require('dotenv').config();

const Anthropic = require('@anthropic-ai/sdk');
const { isRelevant, CORE_KEYWORDS } = require('./keywords.js');

const FEDERAL_REGISTER_ENDPOINT = 'https://www.federalregister.gov/api/v1/documents.json';
// Default lookback window. Bumped to 90 days for the initial backfill;
// drop back to 7 once daily incremental ingest is steady-state. Override
// at runtime via the LOOKBACK_DAYS env var (the workflow exposes this as
// a workflow_dispatch input).
const DEFAULT_LOOKBACK_DAYS = 90;
const PER_PAGE = 100;
const SEARCH_TERMS = ['estate tax', 'gift tax'];
// Hard cap so the run finishes inside the workflow timeout. Items are
// pre-sorted newest-first by the FR API; we keep the first MAX_DOCS
// after keyword filtering and skip the rest.
const MAX_DOCS = 25;
// Per-fetch timeout for HTTP calls (FR API + POST /entries). A single
// slow response shouldn't stall the whole run.
const FETCH_TIMEOUT_MS = 5000;
// Hard wall-clock cap on each Claude call. If Claude hasn't responded
// in this many ms we abort the request, log FAIL, and move to the next
// document. maxRetries=0 below ensures one attempt only.
const CLAUDE_TIMEOUT_MS = 10000;

// Agency filter has been removed. With agency slugs like
// 'labor-department' or 'securities-and-exchange-commission' the
// AND between conditions[agencies][] and conditions[term] was
// returning 0 results — likely because at least one slug was
// wrong (FR's canonical slugs come from /api/v1/agencies).
//
// Garbage filtering is now done downstream:
//   1. Keyword pre-filter on title + abstract (scripts/keywords.js,
//      53 phrases — estate tax / gift tax / trust admin / fiduciary /
//      probate / charitable structures / IRA-RMD / opportunity zones /
//      state estate tax, etc.)
//   2. Claude relevance gate in the extraction call.
//
// If we want to re-add an agency filter later, fetch the canonical
// slugs first from https://www.federalregister.gov/api/v1/agencies
// rather than guessing.

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

// fetch wrapper with hard wall-clock timeout. Aborts on the wire if the
// remote takes longer than timeoutMs. Caller still does .json()/.text()
// on the returned Response.
async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`${(options && options.method) || 'GET'} ${url} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
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
  const res = await fetchWithTimeout(url);
  if (!res.ok) {
    throw new Error(`Federal Register API ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  const results = json.results || [];
  console.log(`    term="${term}" -> total_count=${json.count ?? 'n/a'} returned=${results.length}`);
  if (results.length > 0) {
    const sample = results[0];
    console.log(`    first: ${sample.document_number} "${(sample.title || '').slice(0, 70)}" (${sample.publication_date})`);
  }
  return results;
}

// Sanity probe — runs once at startup with no filters except the date
// window. Confirms the API is reachable and returning anything at all.
// If this returns 0 we know it's a connectivity / API issue, not our
// filter logic.
async function broadProbe(since) {
  const params = new URLSearchParams();
  params.set('per_page', '1');
  params.set('order', 'newest');
  params.set('conditions[publication_date][gte]', since);
  const url = `${FEDERAL_REGISTER_ENDPOINT}?${params.toString()}`;
  console.log(`  PROBE ${url}`);
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      console.warn(`    probe failed: HTTP ${res.status}`);
      return;
    }
    const json = await res.json();
    console.log(
      `    probe ok: total_count=${json.count ?? 'n/a'} (this is the unfiltered universe of FR docs since ${since})`,
    );
  } catch (err) {
    console.warn(`    probe error: ${err.message}`);
  }
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

const EXTRACT_SYSTEM = `You classify and extract metadata from U.S. Federal Register documents for an audience of estate planners, trust attorneys, and family-office advisors.

A document IS relevant if it is directly about any of:
- estate tax, gift tax, generation-skipping transfer tax, inheritance tax
- Form 706, Form 709
- estate planning, applicable exclusion / unified credit
- trust taxation and trust administration (grantor trusts, fiduciary income tax)
- Internal Revenue Code Subtitle B (Chapters 11, 12, 13)
- fiduciary duties for trusts, estates, or retirement plans (including ERISA fiduciary rules and SEC investment-adviser fiduciary rules)
- probate
- charitable giving and tax-exempt structures: 501(c)(3) public charities, private foundations, donor-advised funds, charitable remainder trusts, charitable lead trusts, charitable deductions
- basis step-up at death (stepped-up basis)
- qualified opportunity zones
- retirement accounts as estate-planning vehicles: IRAs, required minimum distributions, inherited IRAs
- life insurance and annuities used for wealth transfer
- state-level estate or inheritance tax
- family-office and high-net-worth wealth-transfer rules

A document is NOT relevant if it is primarily about: pure individual or corporate income tax (with no trust/estate intersection), payroll or employment tax, excise tax, banking or securities trading rules unrelated to fiduciary duties, anti-money-laundering or sanctions, or anything that only mentions estate/gift/trust topics in passing.

Return ONLY a JSON object with these keys:
- "relevant": true if the document is directly about the topics above, otherwise false.
- "summary": plain-English summary, UNDER 150 words, written for an estate / trust / wealth-management professional. No preamble. (May be null when relevant=false.)
- "impact_level": one of "low", "medium", "high". Technical correction = low; notice of proposed rulemaking affecting many filers = medium; final rule changing exemption amounts, fiduciary obligations, or core compliance = high. (May be null when relevant=false.)
- "effective_date": ISO date (YYYY-MM-DD) if explicitly stated, otherwise null. Do not guess.

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
  const relevant = parsed.relevant === true;
  return {
    relevant,
    summary: relevant && typeof parsed.summary === 'string' ? parsed.summary.trim() : null,
    impact_level: relevant && ['low', 'medium', 'high'].includes(level) ? level : null,
    effective_date: parsed.effective_date || null,
  };
}

async function extractWithClaude(client, doc) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);
  try {
    const response = await client.messages.create(
      {
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
      },
      { signal: controller.signal, maxRetries: 0 },
    );
    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock) throw new Error('No text block in Claude response');
    console.log(`    claude raw (${textBlock.text.length} chars): ${textBlock.text.replace(/\s+/g, ' ').slice(0, 200)}`);
    return parseExtraction(textBlock.text);
  } catch (err) {
    if (err.name === 'AbortError' || /aborted|abort/i.test(err.message || '')) {
      throw new Error(`Claude call timed out after ${CLAUDE_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function postEntry(apiBase, apiKey, entry) {
  const url = `${apiBase.replace(/\/+$/, '')}/entries`;
  const res = await fetchWithTimeout(url, {
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

  console.log(`Config: apiBase=${apiBase} lookback=${lookback}d since=${since} terms=${JSON.stringify(SEARCH_TERMS)} agencies=none`);
  console.log(`Fetching Federal Register documents since ${since}...`);
  await broadProbe(since);
  const batches = await Promise.all(SEARCH_TERMS.map((term) => fetchFederalRegister(term, since)));
  const fetched = dedupeByDocumentNumber(batches.flat());
  console.log(`Fetched ${fetched.length} unique documents across ${SEARCH_TERMS.length} search terms (agency-filtered).`);

  // Layer 2: post-fetch keyword pre-filter on title+abstract. Cheap; skips
  // the Claude call on docs that obviously aren't about estate / gift /
  // GST / trust tax.
  const docs = fetched.filter((d) => isRelevant(d.title, d.abstract));
  console.log(
    `Keyword-filtered to ${docs.length}/${fetched.length} (kept docs where title or abstract matches one of: ${CORE_KEYWORDS.slice(0, 8).join(', ')}, ...).`,
  );

  if (docs.length === 0) {
    console.log('No documents matched. Done.');
    return;
  }

  // Hard cap so the run finishes inside the workflow timeout. Docs are
  // pre-sorted newest-first by the FR API; we keep the first MAX_DOCS
  // and defer the rest.
  let processList = docs;
  if (docs.length > MAX_DOCS) {
    console.log(
      `Capping at MAX_DOCS=${MAX_DOCS} (matched ${docs.length}); processing newest ${MAX_DOCS}`,
    );
    processList = docs.slice(0, MAX_DOCS);
  }

  let created = 0;
  let failed = 0;
  let skipped = 0;
  let irrelevant = 0;
  for (const doc of processList) {
    if (!doc.html_url || !doc.title) {
      skipped += 1;
      console.log(`  SKIP ${doc.document_number}: missing html_url or title`);
      continue;
    }
    console.log(`\nProcessing ${doc.document_number}: "${doc.title.slice(0, 70)}"`);
    try {
      const extracted = await extractWithClaude(client, doc);
      // Layer 3: Claude relevance gate. If Claude reads the abstract and
      // says it isn't actually about the topics we monitor, skip.
      if (!extracted.relevant) {
        irrelevant += 1;
        console.log(`    SKIP (claude relevant=false)`);
        continue;
      }
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

  console.log(
    `\nDone. Fetched: ${fetched.length}. Keyword-passed: ${docs.length}. Processed: ${processList.length}. Created/updated: ${created}. Irrelevant (claude): ${irrelevant}. Skipped: ${skipped}. Failed: ${failed}.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
