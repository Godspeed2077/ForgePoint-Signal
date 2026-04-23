const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');

const app = express();
app.set('trust proxy', true);

app.use(cors());
app.use(express.json());

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
  console.warn('Stripe not configured: set STRIPE_SECRET_KEY and STRIPE_PRICE_ID.');
} else {
  const mode = stripeSecret.startsWith('sk_live_') ? 'LIVE' : 'test';
  console.log(`Stripe initialized in ${mode} mode (price=${stripePriceId})`);
}

function appBaseUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, '');
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return `${req.protocol}://${req.get('host')}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/checkout', async (req, res) => {
  if (!stripe || !stripePriceId) {
    return res.status(503).json({
      error: 'Checkout not configured. Set STRIPE_SECRET_KEY and STRIPE_PRICE_ID.',
    });
  }

  try {
    const baseUrl = appBaseUrl(req);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: stripePriceId, quantity: 1 }],
      success_url: `${baseUrl}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/?checkout=canceled`,
      billing_address_collection: 'required',
      allow_promotion_codes: true,
      customer_creation: 'always',
      subscription_data: {
        metadata: { product: 'forgepoint-signal' },
      },
    });
    console.log(`Stripe session created: ${session.id}`);
    res.redirect(303, session.url);
  } catch (err) {
    console.error(`Stripe checkout error: ${err.message}`);
    res.status(500).json({ error: 'Failed to create checkout session' });
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
