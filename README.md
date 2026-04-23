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

## Deploy to Vercel

1. Import the GitHub repo in the Vercel dashboard.
2. In Project Settings → Environment Variables, add:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY` (required for `POST /entries`)
   - `INGEST_API_KEY`
3. Deploy. The `vercel.json` rewrite sends every path to `api/index.js`, which
   exports the Express app.

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
