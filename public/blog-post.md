# How I Built a Regulatory Monitoring MCP Server with x402 Micropayments

## The Problem

The Federal Register publishes hundreds of regulatory changes every day. For estate attorneys, that firehose is mostly noise — a Treasury technical correction on valuation discounts matters; a routine notice of meeting does not. And for AI agents trying to answer "what changed in federal estate tax law this week," there's no clean API. You're stuck scraping PDFs, parsing dense legal prose, or paying for walled-garden legal research platforms that cost more than they're worth for a single question.

I built **ForgePoint Signal** to fix that. It monitors federal estate, gift, trust, and inheritance tax changes, parses them into structured summaries, and exposes everything over MCP so agents can query it directly. Some tools are free, the rest cost 10¢ per call in USDC — no signup.

## What I Built

The pipeline is simple:

- **Ingest** — A GitHub Actions cron runs daily at 13:15 UTC. It pulls the last 30 days of estate-tax and gift-tax documents from the Federal Register API and the latest IRS Newsroom items (RSS with an HTML-scrape fallback), filters for estate/gift/trust/inheritance/Form 706/Form 709/generation-skipping keywords, and dedupes by source URL.
- **Parse** — For each new doc, Claude Haiku 4.5 extracts a <150-word plain-English summary, an impact level (low/medium/high), and a stated effective date when the document specifies one.
- **Store** — Results go into a `regulatory_entries` table in Supabase, keyed uniquely on source URL so the cron is idempotent.
- **Serve** — A single Vercel serverless function hosts both a human-facing dashboard and the MCP server. Paid MCP tools are gated with x402 — a $0.10 USDC micropayment on Base mainnet, verified against the public x402 facilitator.

Total code: four files under `api/`, one HTML dashboard, one cron workflow. The whole thing runs for pocket change.

## The MCP Server

Four tools. One is free, three are paid. Here's the paid one agents hit most:

```json
{
  "name": "search_regulations",
  "description": "Search the full ForgePoint Signal regulatory database by keyword, jurisdiction (federal/state), category (estates/trusts/tax/gift), or impact level (low/medium/high). Returns full entries with plain-English summaries and source links. Updated daily.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": { "type": "string" },
      "jurisdiction": { "type": "string" },
      "category": { "type": "string" },
      "impact_level": { "type": "string", "enum": ["low", "medium", "high"] },
      "limit": { "type": "number" }
    }
  }
}
```

Behind the handler it's a Supabase query: optional `ilike` on title/summary, equality filters on the classifier fields, ordered by publication date descending, capped at 50 rows. No magic.

The transport is MCP Streamable HTTP in stateless mode. Every POST to `/mcp` is independent — no sticky sessions, no long-lived SSE connections to coordinate across function invocations, which is exactly what serverless wants.

## How x402 Works

The flow is almost embarrassingly clean:

1. Agent calls `search_regulations`. No payment attached.
2. Server returns `402 Payment Required` with a payload: pay $0.10 USDC on Base to `0xea82...521c`, here's the facilitator, here's the asset address, you have 120 seconds.
3. The x402 client library signs a USDC transfer, base64-encodes it, and retries the same tool call with an `X-PAYMENT` header.
4. Server hands the payment to the x402 facilitator to verify, executes the tool, settles on-chain, and returns the data with an `X-PAYMENT-RESPONSE` receipt header.

No API keys to issue. No accounts to manage. No Stripe webhooks to reconcile against subscription state. The payment **is** the auth. If you paid, you get the data. If you didn't, you get a 402 with instructions on how to pay. That's it.

For an AI agent with a wallet, this is the first monetization pattern that actually matches how agents want to transact: stateless, atomic, per-request.

## How to Connect It

Drop this into your MCP client config — Claude Desktop, Cursor, Cline, whatever speaks the protocol:

```json
{"mcpServers":{"forgepoint-signal":{"url":"https://forgepointsignal.com/mcp"}}}
```

`preview_regulations` returns the five most recent entries for free; everything else is metered.

## What's Next

- A richer human dashboard at forgepointsignal.com — full-text search, high-impact alerts, maybe an email digest.
- A traditional **$199/month Stripe tier** for humans who don't want to think in USDC micropayments.
- More data sources beyond Federal Register and IRS Newsroom: state-level revenue departments, Tax Court opinions. The parsing pipeline is source-agnostic — adding a source is a ~50-line diff.

## Try It

The free preview tool is live right now at [forgepointsignal.com](https://forgepointsignal.com/). Point any MCP client at the endpoint above and call `preview_regulations` — no wallet, no key, no sign-up. If you want the full firehose, the paid tools are one x402-fetch call away.
