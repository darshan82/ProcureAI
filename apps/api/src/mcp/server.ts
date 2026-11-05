/**
 * Model Context Protocol server (Streamable HTTP, stateless) at POST /mcp.
 * Lets Claude Desktop, IDE agents or a customer's own agent use ProcureAI's tools directly.
 * The same JWT, tenant isolation, tenant tool enablement and RBAC apply as in the web app.
 * Mutating tools that need human approval (award_tender) are intentionally not exposed here.
 */
import { Router, type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { HttpError } from '../lib/errors.js';
import { getTenant } from '../services/tenants.js';
import { ALL_TOOLS, TOOL_ROLES } from '../agent/tools.js';
import type { UserContext } from '../agent/state.js';

const EXPOSED: Record<string, { readOnly: boolean }> = {
  search_tenders: { readOnly: true },
  get_tender: { readOnly: true },
  search_documents: { readOnly: true },
  get_contract_terms: { readOnly: true },
  list_bids: { readOnly: true },
  submit_bid: { readOnly: false },
  create_tender_db: { readOnly: false },
};

async function buildServer(user: UserContext) {
  const tenant = await getTenant(user.tenantId);
  const server = new McpServer({ name: 'procureai', version: '2.0.0' });
  for (const t of ALL_TOOLS) {
    const meta = EXPOSED[t.name];
    if (!meta || !TOOL_ROLES[t.name]?.includes(user.role) || !tenant.settings.enabledTools.includes(t.name as never)) continue;
    // create_tender_db over the tenant's approval threshold must go through the web app's HITL flow.
    const shape = (t.schema as z.ZodObject<z.ZodRawShape>).shape;
    server.registerTool(
      t.name,
      { title: t.name, description: t.description, inputSchema: shape, annotations: { readOnlyHint: meta.readOnly } },
      async (args: Record<string, unknown>) => {
        if (t.name === 'create_tender_db' && tenant.settings.approvals.createTenderAbove !== null && Number(args.budget) > tenant.settings.approvals.createTenderAbove) {
          return { isError: true, content: [{ type: 'text' as const, text: 'This tender needs human approval. Create it in the ProcureAI web app.' }] };
        }
        try {
          const out = await (t as any).invoke(args, { configurable: { user, tenantSettings: tenant.settings } });
          return { content: [{ type: 'text' as const, text: String(out) }] };
        } catch (err) {
          return { isError: true, content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }] };
        }
      },
    );
  }
  return server;
}

export const mcpRouter = Router();

mcpRouter.post('/', requireAuth, async (req: Request, res: Response) => {
  if (!req.user || req.user.role === 'ADMIN') throw new HttpError(403, 'MCP requires a tenant user token', 'forbidden');
  const server = await buildServer(req.user);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// Stateless server: no server-initiated streams or sessions.
mcpRouter.get('/', (_req, res) => res.status(405).json({ error: 'method_not_allowed' }));
mcpRouter.delete('/', (_req, res) => res.status(405).json({ error: 'method_not_allowed' }));
