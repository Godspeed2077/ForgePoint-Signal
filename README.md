# ForgePoint Signal

REST API tracking federal estate tax and gift tax regulatory changes.

## Endpoints

- `GET /health` — liveness probe, returns `{ "status": "ok" }`
- `GET /entries` — all entries, newest `published_date` first
- `GET /entries/:id` — one entry by UUID
- `POST /entries` — insert or upsert an entry (keyed by `source_url`). Requires
  the `x-api-key` header to match `INGEST_API_KEY`. Used by the ingestion script.

## Stack

- Node.js + Express
- Supabase (Postgres) via `@supabase/supabase-js`
- Deployed as Vercel serverless functions (`api/index.js`)

## Supabase setup

1. Create a project at <https://supabase.com/dashboard>.
2. In the SQL editor, run [`supabase/migrations/0001_regulatory_entries.sql`](supabase/migrations/0001_regulatory_entries.sql).
3. From Project Settings → API, copy the **Project URL** and **anon public key**.

### Schema: `regulatory_entries`

| column          | type          |
| --------------- | ------------- |
| id              | uuid (pk)     |
| created_at      | timestamptz   |
| published_date  | date          |
| source          | text          |
| jurisdiction    | text          |
| category        | text          |
| title           | text          |
| summary         | text          |
| source_url      | text          |
| effective_date  | date          |
| impact_level    | text          |
| raw_json        | jsonb         |

## Local development

```bash
cp .env.example .env
# fill in SUPABASE_URL and SUPABASE_ANON_KEY
npm install
npm run dev
# -> http://localhost:3000/health
```

## Public dashboard

`public/index.html` is a single-file dark-theme dashboard served at `/` on
Vercel. It fetches `/entries`, renders the 5 most recent cards in full, and
blurs the next 3 behind a paywall CTA that links to `/checkout`.

## Stripe Checkout

`GET /checkout` creates a Stripe Checkout Session server-side (subscription
mode, billing address required, promo codes allowed) and 303s the user to
Stripe's hosted checkout. On completion Stripe redirects back to
`/?checkout=success` or `/?checkout=canceled`; the dashboard shows a banner
in either case.

To wire up billing:

1. In the Stripe dashboard, create a **Product** named "ForgePoint Signal"
   with a **recurring price** of $199/month (USD).
2. Copy the **Price ID** (starts with `price_...`) and the **Secret key**
   (starts with `sk_test_...` or `sk_live_...`) from Stripe.
3. Set `STRIPE_SECRET_KEY` and `STRIPE_PRICE_ID` in Vercel env vars.
4. Optional: set `APP_URL` to your production URL so success/cancel redirects
   go to the apex domain instead of the Vercel preview URL.

Webhooks (for provisioning access, handling `invoice.payment_failed`, etc.)
are not wired up yet — add a `POST /webhook` handler with
`stripe.webhooks.constructEvent` if you need them.

## Deploy to Vercel

1. Import the GitHub repo in the Vercel dashboard.
2. In Project Settings → Environment Variables, add:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY` (used by the dashboard for reads through `/entries`)
   - `SUPABASE_SERVICE_ROLE_KEY` (required for `POST /entries`)
   - `INGEST_API_KEY`
   - `STRIPE_SECRET_KEY`
   - `STRIPE_PRICE_ID`
   - `APP_URL` (optional — your apex domain, e.g. `https://forgepoint.com`)
3. Deploy. `vercel.json` routes `/entries`, `/entries/:id`, `/health`, and
   `/checkout` to `api/index.js` (the Express app); everything else falls
   through to Vercel's static file server, which serves `public/index.html`
   at `/`.

## Data ingestion

`scripts/ingest.js` pulls the last 30 days of estate-tax and gift-tax documents
from the Federal Register API, asks Claude (`claude-opus-4-7`) to extract a
<150-word summary, an impact level (`low`/`medium`/`high`), and an effective
date when one is stated, then POSTs each one to `/entries`. The endpoint
upserts on `source_url`, so the script is safe to re-run.

```bash
# one-time
cp .env.example .env
# fill in FORGEPOINT_API_URL, INGEST_API_KEY, ANTHROPIC_API_KEY

npm install
npm run ingest
```

Run it on a schedule (cron, GitHub Actions, Vercel Cron) to keep the table
fresh.
