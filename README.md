# ForgePoint Signal

REST API tracking federal estate tax and gift tax regulatory changes.

## Endpoints

- `GET /health` — liveness probe, returns `{ "status": "ok" }`
- `GET /entries` — all entries, newest `published_date` first
- `GET /entries/:id` — one entry by UUID
- `POST /entries` — insert or upsert an entry (keyed by `source_url`). Requires
  the `x-api-key` header to match `INGEST_API_KEY`. Used by the ingestion script.
- `POST /mcp` — Model Context Protocol endpoint (Streamable HTTP transport,
  stateless). See `## MCP server` below.

## MCP server

`POST /mcp` hosts a remote MCP server over HTTP with SSE-streamed responses
(MCP Streamable HTTP transport, stateless mode — no session state, every
request is independent). Tools:

| Tool | Cost | Description |
| --- | --- | --- |
| `preview_regulations` | **Free** | 5 most recent entries (id, title, date, jurisdiction, category, impact_level, summary) |
| `search_regulations` | **$0.10 USDC** | Filter by `query`, `jurisdiction`, `category`, `impact_level`, `limit` (max 50) |
| `get_regulation_detail` | **$0.10 USDC** | Full row for a given `entry_id` |
| `get_recent_by_impact` | **$0.10 USDC** | Most recent entries at a given `impact_level` (default `high`) |

Paid tools are gated with **x402** on Base mainnet. Calling a paid tool without
a valid `X-PAYMENT` header returns **HTTP 402** with the payment requirements:

- `payTo`: `0xea8244C9374aD596b2Ac87c9A1c6844edA88521c`
- `asset`: USDC on Base (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)
- `maxAmountRequired`: `100000` (0.10 USDC, 6 decimals)
- Facilitator: `https://facilitator.x402.org`

Clients generate the payment payload (typically via an x402 client library
like `x402-fetch` or `x402-axios`), resend the tool call with the encoded
payload in `X-PAYMENT`, and the server verifies it with the facilitator
before executing the tool. After success, the response includes an
`X-PAYMENT-RESPONSE` header with the settlement receipt.

CORS on `/mcp` is `Access-Control-Allow-Origin: *` so any MCP client can
connect (the rest of the API is scoped to `https://forgepointsignal.com`).

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

`GET /checkout` creates a Stripe Checkout Session server-side
(subscription mode, billing address required, promo codes allowed) and
303s the user to Stripe's hosted checkout. `success_url` and `cancel_url`
are hardcoded to `https://forgepointsignal.com/success` and
`https://forgepointsignal.com`.

On any error, the response body includes the structured Stripe error
(`type`, `code`, `param`, `message`, `doc_url`, `request_id`) so failures
are diagnosable from the network tab without grepping logs.

To wire up billing:

1. In the Stripe dashboard, create a **Product** named "ForgePoint Signal"
   with a **recurring price** of $199/month (USD).
2. Copy the **Price ID** (starts with `price_...`) and the **Secret key**
   (`sk_test_...` while testing, `sk_live_...` for production). Both must
   be in the same mode — a live secret with a test price (or vice versa)
   returns `resource_missing`.
3. Set `STRIPE_SECRET_KEY` and `STRIPE_PRICE_ID` in Vercel env vars and
   redeploy.

## Deploy to Vercel

1. Import the GitHub repo in the Vercel dashboard.
2. In Project Settings → Environment Variables, add:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY` (used by the dashboard for reads through `/entries`)
   - `SUPABASE_SERVICE_ROLE_KEY` (required for `POST /entries`)
   - `INGEST_API_KEY`
   - `STRIPE_SECRET_KEY`
   - `STRIPE_PRICE_ID`
3. Deploy. `vercel.json` routes `/entries`, `/entries/:id`, `/health`, and
   `/checkout` to `api/index.js` (the Express app); everything else falls
   through to Vercel's static file server, which serves `public/index.html`
   at `/`.

## Data ingestion

Two scripts run daily via GitHub Actions cron and feed the same
`regulatory_entries` table, keyed uniquely on `source_url`:

- `scripts/ingest.js` pulls the last 30 days of estate-tax and gift-tax
  documents from the Federal Register API.
- `scripts/ingest-irs.js` pulls the IRS Newsroom (RSS when available, with
  HTML scrape fallback) and filters for estate, gift, trust, inheritance,
  Form 706 / 709, and generation-skipping items.

For each match, Claude Haiku 4.5 extracts a <150-word summary, an impact
level (`low`/`medium`/`high`), and an effective date when one is stated,
then the result is POSTed to `/entries`. Both scripts are safe to re-run
(the endpoint upserts on `source_url`).

```bash
# one-time
cp .env.example .env
# fill in FORGEPOINT_API_URL, INGEST_API_KEY, ANTHROPIC_API_KEY

npm install
npm run ingest
```

Run it on a schedule (cron, GitHub Actions, Vercel Cron) to keep the table
fresh.
