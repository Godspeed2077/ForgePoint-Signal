const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');
const { mountMcp } = require('./mcp.js');

const app = express();
app.set('trust proxy', true);

// ---------------------------------------------------------------------------
// CORS: wildcard for /mcp, locked to forgepointsignal.com for everything else.
// ---------------------------------------------------------------------------
const mcpCors = cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept', 'Mcp-Session-Id', 'X-PAYMENT'],
  exposedHeaders: ['Mcp-Session-Id', 'X-PAYMENT-RESPONSE'],
});
const siteCors = cors({
  origin: 'https://forgepointsignal.com',
  credentials: true, // allow cookies on cross-origin XHR from the dashboard
});
app.use((req, res, next) => {
  if (req.path === '/mcp' || req.path.startsWith('/mcp/')) {
    return mcpCors(req, res, next);
  }
  return siteCors(req, res, next);
});

// ---------------------------------------------------------------------------
// Supabase + Stripe setup
// ---------------------------------------------------------------------------
const SUCCESS_URL = 'https://forgepointsignal.com/success';
const CANCEL_URL = 'https://forgepointsignal.com';
const APP_BASE_URL = process.env.APP_URL || 'https://forgepointsignal.com';
const FREE_LIMIT = 5;
const TEASER_LIMIT = 3;
const ANON_ENTRIES_LIMIT = FREE_LIMIT + TEASER_LIMIT; // 8
const SESSION_COOKIE_NAME = 'forgepoint_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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
    console.warn('WARNING: SUPABASE_SERVICE_ROLE_KEY not set. Writes to /entries, /webhook, and /auth will fail.');
  }
}
const supabase = createClient(supabaseUrl || '', supabaseKey || '');

const stripeSecret = process.env.STRIPE_SECRET_KEY;
const stripePriceId = process.env.STRIPE_PRICE_ID;
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const stripe = stripeSecret ? new Stripe(stripeSecret) : null;

if (!stripe || !stripePriceId) {
  console.warn(
    `Stripe not configured: STRIPE_SECRET_KEY=${stripeSecret ? 'set' : 'missing'} STRIPE_PRICE_ID=${stripePriceId ? 'set' : 'missing'} STRIPE_WEBHOOK_SECRET=${stripeWebhookSecret ? 'set' : 'missing'}`,
  );
} else {
  const mode = stripeSecret.startsWith('sk_live_') ? 'LIVE' : stripeSecret.startsWith('sk_test_') ? 'test' : 'unknown';
  console.log(`Stripe initialized (key_mode=${mode}, price_id=${stripePriceId}, webhook_secret=${stripeWebhookSecret ? 'set' : 'missing'})`);
}

const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret || sessionSecret.length < 32) {
  console.warn('SESSION_SECRET is missing or shorter than 32 chars. Auth endpoints will fail.');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Session helpers: HMAC-signed cookie carrying {email, expiry}.
// Stateless — no server-side session store; authority re-verifies
// subscribers.status on each request.
// ---------------------------------------------------------------------------
function signSession(email, ttlMs = SESSION_TTL_MS) {
  if (!sessionSecret) throw new Error('SESSION_SECRET not configured');
  const payload = Buffer
    .from(JSON.stringify({ e: email.toLowerCase(), x: Date.now() + ttlMs }))
    .toString('base64url');
  const sig = crypto
    .createHmac('sha256', sessionSecret)
    .update(payload)
    .digest('base64url');
  return `${payload}.${sig}`;
}

function verifySession(token) {
  if (!token || !sessionSecret) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto
    .createHmac('sha256', sessionSecret)
    .update(payload)
    .digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const { e: email, x: expiry } = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    );
    if (typeof expiry !== 'number' || Date.now() > expiry) return null;
    if (typeof email !== 'string' || !email) return null;
    return { email, expiry };
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function setSessionCookie(res, token) {
  const parts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (process.env.NODE_ENV !== 'development') parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (process.env.NODE_ENV !== 'development') parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

async function getActiveSubscriber(email) {
  if (!email) return null;
  const { data, error } = await supabase
    .from('subscribers')
    .select('email, status, stripe_customer_id')
    .eq('email', email.toLowerCase())
    .maybeSingle();
  if (error) {
    console.error(`subscribers lookup error: ${error.message}`);
    return null;
  }
  if (!data || data.status !== 'active') return null;
  return data;
}

// Resolves { session, subscriber } for the caller, or {session: null, subscriber: null}.
async function resolveSubscriberFromCookie(req) {
  const cookies = parseCookies(req.headers.cookie);
  const session = verifySession(cookies[SESSION_COOKIE_NAME]);
  if (!session) return { session: null, subscriber: null };
  const subscriber = await getActiveSubscriber(session.email);
  if (!subscriber) return { session: null, subscriber: null };
  return { session, subscriber };
}

// ===========================================================================
// Stripe webhook — MUST be mounted BEFORE express.json() so signature
// verification sees the raw request body byte-for-byte.
// ===========================================================================
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!stripe || !stripeWebhookSecret) {
      console.error('Webhook received but Stripe or STRIPE_WEBHOOK_SECRET is not configured.');
      return res.status(503).send('webhook not configured');
    }

    const sig = req.get('stripe-signature');
    if (!sig) return res.status(400).send('missing stripe-signature');

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, stripeWebhookSecret);
    } catch (err) {
      console.error(`Webhook signature verify failed: ${err.message}`);
      return res.status(400).send(`signature verification failed: ${err.message}`);
    }

    console.log(`Webhook ${event.id} ${event.type}`);

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;
          if (session.mode !== 'subscription') break;
          const email = (
            session.customer_details?.email ||
            session.customer_email ||
            ''
          ).toLowerCase();
          if (!email) {
            console.warn(`  no email on session ${session.id}; cannot upsert subscriber`);
            break;
          }
          const row = {
            email,
            stripe_customer_id: typeof session.customer === 'string' ? session.customer : session.customer?.id || null,
            stripe_subscription_id: typeof session.subscription === 'string' ? session.subscription : session.subscription?.id || null,
            status: 'active',
          };
          const { error } = await supabase
            .from('subscribers')
            .upsert(row, { onConflict: 'email' });
          if (error) {
            console.error(`  upsert active subscriber failed: ${error.message}`);
            return res.status(500).send('upsert failed');
          }
          console.log(`  marked active: ${email}`);
          break;
        }

        case 'customer.subscription.deleted': {
          const sub = event.data.object;
          const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
          if (!customerId) break;
          const { error } = await supabase
            .from('subscribers')
            .update({ status: 'inactive' })
            .eq('stripe_customer_id', customerId);
          if (error) {
            console.error(`  mark inactive (deleted) failed: ${error.message}`);
            return res.status(500).send('update failed');
          }
          console.log(`  marked inactive via subscription.deleted: customer=${customerId}`);
          break;
        }

        case 'invoice.payment_failed': {
          const invoice = event.data.object;
          const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
          if (!customerId) break;
          const { error } = await supabase
            .from('subscribers')
            .update({ status: 'inactive' })
            .eq('stripe_customer_id', customerId);
          if (error) {
            console.error(`  mark inactive (payment_failed) failed: ${error.message}`);
            return res.status(500).send('update failed');
          }
          console.log(`  marked inactive via invoice.payment_failed: customer=${customerId}`);
          break;
        }

        default:
          console.log(`  (ignored: ${event.type})`);
      }
    } catch (err) {
      console.error(`webhook handler error: ${err.message}`);
      return res.status(500).send(err.message);
    }

    res.json({ received: true });
  },
);

// ---------------------------------------------------------------------------
// Everything below parses JSON.
// ---------------------------------------------------------------------------
app.use(express.json());

mountMcp(app, supabase);
console.log('MCP server mounted at /mcp');

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ---------------------------------------------------------------------------
// Stripe Checkout session
// ---------------------------------------------------------------------------
app.get('/checkout', async (req, res) => {
  if (!stripe || !stripePriceId) {
    console.error('Checkout request received but Stripe is not configured.');
    return res.status(503).json({
      error: 'Checkout not configured',
      detail: 'Set STRIPE_SECRET_KEY and STRIPE_PRICE_ID env vars and redeploy.',
    });
  }
  const keyMode = stripeSecret.startsWith('sk_live_') ? 'live' : 'test';
  console.log(`POST stripe.checkout.sessions.create mode=subscription price=${stripePriceId} key_mode=${keyMode}`);
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: stripePriceId, quantity: 1 }],
      success_url: `${SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: CANCEL_URL,
      billing_address_collection: 'required',
      allow_promotion_codes: true,
      subscription_data: { metadata: { product: 'forgepoint-signal' } },
    });
    console.log(`Stripe session created: id=${session.id}`);
    res.redirect(303, session.url);
  } catch (err) {
    console.error('Stripe session create failed:', {
      type: err.type, code: err.code, param: err.param,
      statusCode: err.statusCode, requestId: err.requestId,
      doc_url: err.doc_url, message: err.message,
    });
    res.status(err.statusCode || 500).json({
      error: 'Failed to create checkout session',
      stripe: {
        type: err.type || null, code: err.code || null, param: err.param || null,
        message: err.message || null, doc_url: err.doc_url || null,
        request_id: err.requestId || null,
      },
    });
  }
});

// ===========================================================================
// Magic-link auth
// ===========================================================================
app.post('/auth/send-link', async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'valid email required' });
  }
  console.log(`POST /auth/send-link email=${email}`);

  // Always return 200 so we don't leak whether an email is a subscriber.
  // Only actually send the magic link if they're an active subscriber.
  const subscriber = await getActiveSubscriber(email);
  if (!subscriber) {
    console.log(`  not an active subscriber; silently skipping send`);
    return res.json({ sent: true });
  }

  try {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
        emailRedirectTo: `${APP_BASE_URL}/auth/callback`,
      },
    });
    if (error) {
      console.error(`  signInWithOtp failed: ${error.message}`);
      // Don't leak; still return 200.
      return res.json({ sent: true });
    }
    console.log(`  magic link sent via Supabase Auth`);
    return res.json({ sent: true });
  } catch (err) {
    console.error(`  send-link error: ${err.message}`);
    return res.json({ sent: true });
  }
});

// Supabase redirects here with tokens in the URL fragment (#access_token=...).
// Fragments never reach the server, so this endpoint serves a tiny HTML page
// whose JS reads the fragment and POSTs the access token to /auth/verify.
app.get('/auth/callback', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Signing in — ForgePoint Signal</title>
  <style>
    body{background:#080c16;color:#e8ebf2;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}
    .card{max-width:420px;background:#11182a;border:1px solid #243049;border-radius:10px;padding:32px;text-align:center}
    h1{font-size:20px;margin:0 0 10px}
    p{color:#8893ae;font-size:14px;margin:0 0 16px}
    .err{color:#ff8f8f}
    a{color:#c9a961}
  </style>
</head>
<body>
  <div class="card">
    <h1 id="title">Signing you in…</h1>
    <p id="msg">Verifying your magic link.</p>
  </div>
  <script>
  (async function(){
    const t = document.getElementById('title');
    const m = document.getElementById('msg');
    function fail(text){ t.textContent = 'Sign-in failed'; t.className = 'err'; m.textContent = text + ' '; const a = document.createElement('a'); a.href='/'; a.textContent='Return home'; m.appendChild(a); }
    try {
      const hash = window.location.hash.replace(/^#/, '');
      const params = new URLSearchParams(hash || window.location.search.replace(/^\\?/, ''));
      const accessToken = params.get('access_token');
      const errDesc = params.get('error_description') || params.get('error');
      if (errDesc) return fail(errDesc);
      if (!accessToken) return fail('No access token in the URL.');
      const r = await fetch('/auth/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ access_token: accessToken }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) return fail(body.error || ('HTTP ' + r.status));
      window.location.replace('/');
    } catch (e) { fail(e.message || 'Unknown error'); }
  })();
  </script>
</body>
</html>`);
});

// Receives access_token from /auth/callback, validates it with Supabase,
// double-checks subscriber is active, sets the session cookie.
app.post('/auth/verify', async (req, res) => {
  const accessToken = req.body?.access_token;
  if (!accessToken || typeof accessToken !== 'string') {
    return res.status(400).json({ error: 'access_token required' });
  }
  try {
    const { data, error } = await supabase.auth.getUser(accessToken);
    if (error || !data?.user?.email) {
      console.log(`  /auth/verify rejected: ${error?.message || 'no user'}`);
      return res.status(401).json({ error: 'invalid token' });
    }
    const email = data.user.email.toLowerCase();
    const subscriber = await getActiveSubscriber(email);
    if (!subscriber) {
      return res.status(403).json({ error: 'no active subscription on file' });
    }
    setSessionCookie(res, signSession(email));
    console.log(`  session issued: ${email}`);
    res.json({ ok: true, email });
  } catch (err) {
    console.error(`  /auth/verify error: ${err.message}`);
    res.status(500).json({ error: 'verification failed' });
  }
});

app.get('/auth/me', async (req, res) => {
  const { session, subscriber } = await resolveSubscriberFromCookie(req);
  if (!session || !subscriber) return res.json({ authenticated: false });
  res.json({ authenticated: true, email: subscriber.email });
});

app.post('/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ===========================================================================
// Ingest POST (unchanged shape, still gated by INGEST_API_KEY)
// ===========================================================================
function requireIngestKey(req, res, next) {
  const expected = process.env.INGEST_API_KEY;
  if (!expected) return res.status(503).json({ error: 'Ingestion not configured' });
  if (req.get('x-api-key') !== expected) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

const ALLOWED_FIELDS = [
  'published_date', 'source', 'jurisdiction', 'category',
  'title', 'summary', 'source_url', 'effective_date',
  'impact_level', 'raw_json',
];

app.post('/entries', requireIngestKey, async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Body must be a JSON object' });
  const row = {};
  for (const key of ALLOWED_FIELDS) {
    if (body[key] !== undefined) row[key] = body[key];
  }
  if (!row.title || !row.source_url) return res.status(400).json({ error: 'title and source_url are required' });
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

// ===========================================================================
// GET /entries — gated on session cookie
//   active subscriber: full list
//   anon/expired/canceled: ANON_ENTRIES_LIMIT (8) entries
// ===========================================================================
app.get('/entries', async (req, res) => {
  const { subscriber } = await resolveSubscriberFromCookie(req);
  let q = supabase
    .from('regulatory_entries')
    .select('*')
    .order('published_date', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false });
  if (!subscriber) q = q.limit(ANON_ENTRIES_LIMIT);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/entries/:id', async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid id format' });
  const { data, error } = await supabase
    .from('regulatory_entries')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Entry not found' });
  res.json(data);
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

module.exports = app;
