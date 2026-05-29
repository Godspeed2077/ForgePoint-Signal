> **Archived May 2026 under ForgePoint Industries.** This README is preserved as a technical record of the architecture that was built. The active commercial push has been wound down. The MCP endpoint remains live as an architecture demonstration but the project is no longer being actively maintained. The site, source, and writeups stay public as a portfolio piece. Fork freely.

---

# ForgePoint Signal

REST API tracking federal estate tax and gift tax regulatory changes.

## Endpoints

- `GET /health` — liveness probe, returns `{ "status": "ok" }`
- `GET /entries` — gated on session cookie. Active subscribers get the full
  feed; anonymous callers get at most 8 entries (5 visible + 3 teasers).
- `GET /entries/:id` — one entry by UUID
- `POST /entries` — insert or upsert an entry (keyed by `source_url`). Requires
  the `x-api-key` header to match `INGEST_API_KEY`. Used by the ingestion script.
- `POST /webhook` — Stripe webhook. Signed with `STRIPE_WEBHOOK_SECRET`.
  Handles `checkout.session.completed`, `customer.subscription.deleted`,
  `invoice.payment_failed`. Upserts the `subscribers` table.
- `POST /auth/send-link` — `{email}` → triggers a Supabase Auth magic link if
  the email belongs to an active subscriber. Always returns 200 to avoid
  leaking subscription membership.
- `GET /auth/callback` — landing page for the Supabase magic link; hands the
  access token to `/auth/verify` client-side.
- `POST /auth/verify` — `{access_token}` → sets the `forgepoint_session`
  cookie (HMAC-signed with `SESSION_SECRET`, 30-day TTL).
- `GET /auth/me` — returns `{authenticated, email}` based on the cookie.
- `POST /auth/logout` — clears the session cookie.
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
2. In the SQL editor, run the migrations in order:
   - [`supabase/migrations/0001_regulatory_entries.sql`](supabase/migrations/0001_regulatory_entries.sql)
   - [`supabase/migrations/0002_subscribers.sql`](supabase/migrations/0002_subscribers.sql)
3. From Project Settings → API, copy the **Project URL**, **anon public key**, and **service role key**.
4. **Auth**: go to Authentication → Providers → Email and make sure "Email
   provider" is enabled with magic links on. Supabase will send the sign-in
   emails (configure SMTP under Authentication → Emails if you want to send
   from your own domain).

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

## Stripe Checkout and post-payment fulfillment

`GET /checkout` creates a Stripe Checkout Session server-side (subscription
mode, billing address required, promo codes allowed) and 303s the user to
Stripe's hosted checkout. `success_url` and `cancel_url` are hardcoded to
`https://forgepointsignal.com/success` and `https://forgepointsignal.com`.

On any error, the response body includes the structured Stripe error
(`type`, `code`, `param`, `message`, `doc_url`, `request_id`) so failures
are diagnosable from the network tab without grepping logs.

After a successful checkout, Stripe fires `checkout.session.completed` to
`POST /webhook`, which upserts a row into the `subscribers` table with
`status='active'` keyed on email. Later `customer.subscription.deleted` and
`invoice.payment_failed` events flip `status` back to `inactive` by looking
up the row by `stripe_customer_id`.

Subscribers sign in on the dashboard with a magic link: they enter their
email, Supabase Auth emails them a link, clicking it lands them on
`/auth/callback` which exchanges the token for a server-side signed session
cookie. The dashboard calls `/auth/me` on load and — if authenticated — the
`/entries` endpoint returns the full feed instead of the 5+3 paywalled view.

To wire up billing:

1. In the Stripe dashboard, create a **Product** named "ForgePoint Signal"
   with a **recurring price** of $199/month (USD).
2. Copy the **Price ID** (`price_...`) and the **Secret key**
   (`sk_test_...` while testing, `sk_live_...` for production). Both must
   be in the same mode.
3. Create a webhook at Dashboard → Developers → Webhooks pointing at
   `https://forgepointsignal.com/webhook`. Subscribe to:
   `checkout.session.completed`, `customer.subscription.deleted`,
   `invoice.payment_failed`. Copy the **Signing secret** (`whsec_...`).
4. Set `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` in
   Vercel env vars. Also set `SESSION_SECRET` (32+ random bytes — generate
   with `openssl rand -base64 48`). Redeploy.

## Deploy to Vercel

1. Import the GitHub repo in the Vercel dashboard.
2. In Project Settings → Environment Variables, add:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY` (used by the dashboard for reads through `/entries`)
   - `SUPABASE_SERVICE_ROLE_KEY` (required for `/webhook`, `/auth/*`, and `POST /entries`)
   - `INGEST_API_KEY`
   - `STRIPE_SECRET_KEY`
   - `STRIPE_PRICE_ID`
   - `STRIPE_WEBHOOK_SECRET`
   - `SESSION_SECRET` (32+ random bytes)
3. Deploy. `vercel.json` routes `/entries`, `/entries/:id`, `/health`,
   `/checkout`, `/webhook`, `/auth/*`, and `/mcp` to `api/index.js` (the
   Express app); everything else falls through to Vercel's static file
   server, which serves `public/index.html` at `/`.

## Data ingestion

Two scripts run daily via GitHub Actions cron and feed the same
`regulatory_entries` table, keyed uniquely on `source_url`:

- `scripts/ingest.js` pulls the last N days (default 90, configurable via
  `LOOKBACK_DAYS`) of estate-tax and gift-tax documents from the Federal
  Register API.
- `scripts/ingest-irb.js` walks weekly Internal Revenue Bulletin issue
  pages back across the lookback window, parses out Rev. Rul. / Rev. Proc.
  / Notice / Ann. citations from the issue HTML, and Claude-evaluates each
  match against the estate / gift / GST / trust planning lens.

Both scripts apply three layers of relevance filtering before insertion:

1. **API-side filter.** `ingest.js` passes `conditions[term]` against the
   Federal Register full-text search; agency narrowing was removed because
   guessing the canonical agency slug returned zero results.
2. **Keyword pre-filter.** Both scripts share `scripts/keywords.js`. A
   document is only sent to Claude if its title (or, in the IRB script,
   citation + synopsis) contains one of the topical phrases (`estate tax`,
   `gift tax`, `generation-skipping`, `Form 706/709`, `applicable
   exclusion`, `grantor trust`, etc.).
3. **Claude relevance gate.** The extraction prompt asks Claude to set
   `relevant: true|false`. Items where Claude says `false` are skipped
   before the POST to `/entries`, so they never enter the database.

In addition, both scripts run a Supabase pre-check via `scripts/dedup.js`
before every Claude call: if the `source_url` is already in
`regulatory_entries`, Claude is skipped and the row is counted as
`Already-stored`. This keeps re-runs cheap.

For each surviving match, Claude Haiku 4.5 extracts a <150-word summary,
an impact level (where the prompt requests one), and an effective date
when one is stated, then the result is POSTed to `/entries`. Both scripts
are safe to re-run (the endpoint upserts on `source_url`).

### Cleaning up existing off-topic rows

If your `regulatory_entries` table already has rows that pre-date the
relevance filters (e.g. SEC Form PF, FLSA labor rules), run:

```bash
npm run cleanup:off-topic                # dry-run, lists what would go
npm run cleanup:off-topic -- --apply     # actually delete
```

The script reads `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from `.env`
and talks to Supabase directly (bypasses the API). It uses the same
keyword list as the ingest scripts, so anything it would delete is
something the new ingest would also reject.

```bash
# one-time
cp .env.example .env
# fill in FORGEPOINT_API_URL, INGEST_API_KEY, ANTHROPIC_API_KEY

npm install
npm run ingest
```

Run it on a schedule (cron, GitHub Actions, Vercel Cron) to keep the table
fresh.
