# ForgePoint Signal

REST API tracking federal estate tax and gift tax regulatory changes.

## Endpoints

- `GET /health` — liveness probe, returns `{ "status": "ok" }`
- `GET /entries` — all entries, newest `published_date` first
- `GET /entries/:id` — one entry by UUID

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
   - `SUPABASE_ANON_KEY`
3. Deploy. The `vercel.json` rewrite sends every path to `api/index.js`, which
   exports the Express app.
