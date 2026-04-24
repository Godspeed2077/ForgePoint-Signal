const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');
const { mountMcp } = require('./mcp.js');

const app = express();
app.set('trust proxy', true);

const mcpCors = cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept', 'Mcp-Session-Id', 'X-PAYMENT'],
  exposedHeaders: ['Mcp-Session-Id', 'X-PAYMENT-RESPONSE'],
});
const siteCors = cors({ origin: 'https://forgepointsignal.com' });
app.use((req, res, next) => {
  if (req.path === '/mcp' || req.path.startsWith('/mcp/')) {
    return mcpCors(req, res, next);
  }
  return siteCors(req, res, next);
});
app.use(express.json());

const SUCCESS_URL = 'https://forgepointsignal.com/success';
const CANCEL_URL = 'https://forgepointsignal.com';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
const supabaseKey = serviceRoleKey || anonKey;
const usingServiceRole = Boolean(serviceRoleKey);

if (!supabaseUrl || !supabaseKey) {
  console.warn('Supabase env vars missing: set SUPABASE_URL and SUPABASE_ANON_KEY (or SUPABASE_SERVICE_ROLE_KEY).');
} else {
  console.log(`Supabase client initialized (role=${usingServiceRole ? 'service_role' : 'anon'}, url=${supabaseUrl})`);
  if (!usingServiceRole) {
    console.warn('WARNING: SUPABASE_SERVICE_ROLE_KEY not set. Writes to /entries will be blocked by RLS.');
  }
}

const supabase = createClient(supabaseUrl || '', supabaseKey || '');

const stripeSecret = process.env.STRIPE_SECRET_KEY;
const stripePriceId = process.env.STRIPE_PRICE_ID;
const stripe = stripeSecret ? new Stripe(stripeSecret) : null;

if (!stripe || !stripePriceId) {
  console.warn(
    `Stripe not configured: STRIPE_SECRET_KEY=${stripeSecret ? 'set' : 'missing'} STRIPE_PRICE_ID=${stripePriceId ? 'set' : 'missing'}`,
  );
} else {
  const mode = stripeSecret.startsWith('sk_live_')
    ? 'LIVE'
    : stripeSecret.startsWith('sk_test_')
      ? 'test'
      : 'unknown';
  console.log(`Stripe initialized (key_mode=${mode}, price_id=${stripePriceId})`);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

mountMcp(app, supabase);
console.log('MCP server mounted at /mcp');

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/checkout', async (req, res) => {
  if (!stripe || !stripePriceId) {
    console.error('Checkout request received but Stripe is not configured.');
    return res.status(503).json({
      error: 'Checkout not configured',
      detail: 'Set STRIPE_SECRET_KEY and STRIPE_PRICE_ID env vars and redeploy.',
    });
  }

  const keyMode = stripeSecret.startsWith('sk_live_') ? 'live' : 'test';
  console.log(
    `POST stripe.checkout.sessions.create mode=subscription price=${stripePriceId} key_mode=${keyMode}`,
  );

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: stripePriceId, quantity: 1 }],
      success_url: `${SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: CANCEL_URL,
      billing_address_collection: 'required',
      allow_promotion_codes: true,
      subscription_data: {
        metadata: { product: 'forgepoint-signal' },
      },
    });
    console.log(`Stripe session created: id=${session.id} url=${session.url}`);
    res.redirect(303, session.url);
  } catch (err) {
    console.error('Stripe session create failed:', {
      type: err.type,
      code: err.code,
      param: err.param,
      statusCode: err.statusCode,
      requestId: err.requestId,
      doc_url: err.doc_url,
      message: err.message,
      raw: err.raw,
    });
    res.status(err.statusCode || 500).json({
      error: 'Failed to create checkout session',
      stripe: {
        type: err.type || null,
        code: err.code || null,
        param: err.param || null,
        message: err.message || null,
        doc_url: err.doc_url || null,
        request_id: err.requestId || null,
      },
    });
  }
});

function requireIngestKey(req, res, next) {
  const expected = process.env.INGEST_API_KEY;
  if (!expected) {
    return res.status(503).json({ error: 'Ingestion not configured' });
  }
  if (req.get('x-api-key') !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

const ALLOWED_FIELDS = [
  'published_date',
  'source',
  'jurisdiction',
  'category',
  'title',
  'summary',
  'source_url',
  'effective_date',
  'impact_level',
  'raw_json',
];

app.post('/entries', requireIngestKey, async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Body must be a JSON object' });
  }

  const row = {};
  for (const key of ALLOWED_FIELDS) {
    if (body[key] !== undefined) row[key] = body[key];
  }
  if (!row.title || !row.source_url) {
    return res.status(400).json({ error: 'title and source_url are required' });
  }

  if (!usingServiceRole) {
    return res.status(500).json({
      error: 'Server is using the anon key; writes are blocked by RLS. Set SUPABASE_SERVICE_ROLE_KEY and redeploy.',
    });
  }

  console.log(`POST /entries: source_url=${row.source_url} title="${String(row.title).slice(0, 60)}"`);

  const { data, error } = await supabase
    .from('regulatory_entries')
    .upsert(row, { onConflict: 'source_url' })
    .select()
    .single();

  if (error) {
    console.error(`  supabase error: ${error.code} ${error.message} ${error.details || ''}`);
    return res.status(500).json({ error: error.message, code: error.code, details: error.details });
  }
  console.log(`  upserted id=${data?.id}`);
  res.status(201).json(data);
});

app.get('/entries', async (req, res) => {
  const { data, error } = await supabase
    .from('regulatory_entries')
    .select('*')
    .order('published_date', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({ error: error.message });
  }
  res.json(data);
});

app.get('/entries/:id', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ error: 'Invalid id format' });
  }

  const { data, error } = await supabase
    .from('regulatory_entries')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    return res.status(500).json({ error: error.message });
  }
  if (!data) {
    return res.status(404).json({ error: 'Entry not found' });
  }
  res.json(data);
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

module.exports = app;
