const express = require('express');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const {
  StreamableHTTPServerTransport,
} = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { paymentMiddleware } = require('x402-express');

const PAY_TO = '0xea8244C9374aD596b2Ac87c9A1c6844edA88521c';
const PRICE = '$0.10';
const NETWORK = 'base';
const FACILITATOR_URL = 'https://facilitator.x402.org';

const PAID_TOOLS = new Set([
  'search_regulations',
  'get_regulation_detail',
  'get_recent_by_impact',
]);

function toText(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

function buildServer(supabase) {
  const server = new McpServer({ name: 'forgepoint-signal', version: '0.1.0' });

  server.tool(
    'preview_regulations',
    "Get a free preview of the 5 most recent US regulatory changes monitored by ForgePoint Signal. Covers estate, trust, gift, and inheritance tax law. Updated daily from the Federal Register and IRS Internal Revenue Bulletin.",
    {},
    async () => {
      const { data, error } = await supabase
        .from('regulatory_entries')
        .select('id,title,published_date,jurisdiction,category,impact_level,summary')
        .order('published_date', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(5);
      if (error) throw new Error(error.message);
      const rows = (data || []).map((r) => ({
        id: r.id,
        title: r.title,
        date: r.published_date,
        jurisdiction: r.jurisdiction,
        category: r.category,
        impact_level: r.impact_level,
        summary: r.summary,
      }));
      return toText(rows);
    },
  );

  server.tool(
    'search_regulations',
    "Search the full ForgePoint Signal regulatory database by keyword, jurisdiction (federal/state), category (estates/trusts/tax/gift), or impact level (low/medium/high). Returns full entries with plain-English summaries and source links. Updated daily from the Federal Register and IRS Internal Revenue Bulletin.",
    {
      query: z.string().optional(),
      jurisdiction: z.string().optional(),
      category: z.string().optional(),
      impact_level: z.enum(['low', 'medium', 'high']).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async (args) => {
      const limit = Math.min(args?.limit ?? 20, 50);
      let q = supabase.from('regulatory_entries').select('*');
      if (args?.jurisdiction) q = q.eq('jurisdiction', args.jurisdiction);
      if (args?.category) q = q.eq('category', args.category);
      if (args?.impact_level) q = q.eq('impact_level', args.impact_level);
      if (args?.query) {
        const escaped = args.query.replace(/[%_,()]/g, ' ').trim();
        if (escaped) {
          const pattern = `%${escaped}%`;
          q = q.or(`title.ilike.${pattern},summary.ilike.${pattern}`);
        }
      }
      q = q
        .order('published_date', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(limit);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return toText(data || []);
    },
  );

  server.tool(
    'get_regulation_detail',
    "Get complete detail for a specific regulation entry including full summary, affected law or code section, effective date, and source document link. Data is sourced from the Federal Register and IRS Internal Revenue Bulletin.",
    { entry_id: z.string() },
    async ({ entry_id }) => {
      const { data, error } = await supabase
        .from('regulatory_entries')
        .select('*')
        .eq('id', entry_id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'not_found', entry_id }) }],
          isError: true,
        };
      }
      return toText(data);
    },
  );

  server.tool(
    'get_recent_by_impact',
    "Get the most recent high-impact regulatory changes sorted by impact level. Ideal for daily briefings or monitoring material changes requiring immediate attention. Updated daily from the Federal Register and IRS Internal Revenue Bulletin.",
    {
      impact_level: z.enum(['low', 'medium', 'high']).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async (args) => {
      const impact = args?.impact_level ?? 'high';
      const limit = Math.min(args?.limit ?? 10, 50);
      const { data, error } = await supabase
        .from('regulatory_entries')
        .select('*')
        .eq('impact_level', impact)
        .order('published_date', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw new Error(error.message);
      return toText(data || []);
    },
  );

  return server;
}

function isPaidToolCall(body) {
  if (!body) return false;
  const messages = Array.isArray(body) ? body : [body];
  return messages.some(
    (m) => m?.method === 'tools/call' && PAID_TOOLS.has(m?.params?.name),
  );
}

function mountMcp(app, supabase) {
  const server = buildServer(supabase);

  const paymentGate = paymentMiddleware(
    PAY_TO,
    {
      'POST /mcp': {
        price: PRICE,
        network: NETWORK,
        config: {
          description: 'ForgePoint Signal — paid MCP tool call',
          mimeType: 'application/json',
          maxTimeoutSeconds: 120,
        },
      },
    },
    { url: FACILITATOR_URL },
  );

  app.post(
    '/mcp',
    async (req, res, next) => {
      if (isPaidToolCall(req.body)) {
        return paymentGate(req, res, next);
      }
      next();
    },
    async (req, res) => {
      try {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        res.on('close', () => {
          transport.close().catch(() => {});
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        console.error('MCP handler error:', err);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Internal server error', detail: err.message });
        }
      }
    },
  );

  app.get('/mcp', (req, res) => {
    res.set('Allow', 'POST, OPTIONS');
    res.status(405).json({
      error: 'Method not allowed',
      detail: 'This MCP server uses stateless Streamable HTTP. POST JSON-RPC messages to /mcp.',
    });
  });
}

module.exports = { mountMcp };
