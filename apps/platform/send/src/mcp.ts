/**
 * MCP server for coding agents - stateless Streamable HTTP transport
 * (Traks pattern). One POST endpoint speaking JSON-RPC 2.0. Auth is the same
 * API key as the REST surface; every tool dispatches INTERNALLY to the
 * existing routes, so validation, idempotency, and suppression checks are the
 * ones real sends get. Connect with:
 *
 *   claude mcp add --transport http postey https://<send-worker>/api/mcp \
 *     --header "Authorization: Bearer pk_live_…"
 */
import type { Context } from 'hono';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = Context<any>;

/** Internal dispatcher - index.ts passes app.request bound to the live app. */
export type Dispatch = (path: string, init: RequestInit, c: Ctx) => Promise<Response>;

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  request: (args: Record<string, unknown>) => { method: string; path: string; body?: unknown };
}

const str = (desc: string): object => ({ type: 'string', description: desc });

const TOOLS: ToolDef[] = [
  {
    name: 'send_email',
    description:
      'Send a transactional email. from must use a domain configured on this instance; recipients on the suppression list are blocked automatically. Returns the message id.',
    inputSchema: {
      type: 'object',
      properties: {
        from: str('Sender: "Name <addr@yourdomain>" or bare address'),
        to: { type: 'array', items: { type: 'string' }, description: 'Recipient addresses (max 50)' },
        subject: str('Subject line'),
        html: str('HTML body (at least one of html/text required)'),
        text: str('Plain-text body'),
        reply_to: str('Optional Reply-To address'),
        template_id: str('Optional template id or slug - template supplies subject/body'),
        variables: { type: 'object', description: 'Values for {{placeholders}} in the template' },
        attachments: {
          type: 'array',
          description: 'File attachments (max 10, 4 MiB total decoded)',
          items: {
            type: 'object',
            properties: {
              filename: str('File name shown to the recipient'),
              content: str('File content, base64-encoded'),
              content_type: str('MIME type (default application/octet-stream)'),
              disposition: { type: 'string', enum: ['attachment', 'inline'] },
              content_id: str('For inline images: reference in HTML as cid:<content_id>'),
            },
            required: ['filename', 'content'],
          },
        },
        idempotency_key: str('Optional: retries with the same key send exactly once'),
      },
      required: ['from', 'to'],
    },
    request: a => ({ method: 'POST', path: '/api/emails', body: a }),
  },
  {
    name: 'get_email',
    description: 'Status of a sent email: delivery state, per-recipient status, errors, timestamps.',
    inputSchema: {
      type: 'object',
      properties: { id: str('Message id (msg_…) returned by send_email') },
      required: ['id'],
    },
    request: a => ({ method: 'GET', path: `/api/emails/${a.id}` }),
  },
  {
    name: 'list_emails',
    description: 'Recent emails sent through this instance, newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 20, max 50)' },
        status: {
          type: 'string',
          enum: ['queued', 'scheduled', 'sending', 'sent', 'delivered', 'partial', 'bounced', 'failed', 'suppressed'],
          description:
            "Optional status filter ('sent' = accepted by Cloudflare, 'delivered' = confirmed by the recipient's server)",
        },
      },
    },
    request: a => ({
      method: 'GET',
      path: `/api/emails?limit=${Number(a.limit) || 20}${a.status ? `&status=${a.status}` : ''}`,
    }),
  },
  {
    name: 'list_templates',
    description: 'Templates available on this instance (id, slug, subject, declared variables).',
    inputSchema: { type: 'object', properties: {} },
    request: () => ({ method: 'GET', path: '/api/templates' }),
  },
  {
    name: 'create_template',
    description:
      'Create or replace a reusable email template. Use {{variable}} placeholders in subject/html/text; send with send_email template_id + variables. Same slug replaces the template (version bumps).',
    inputSchema: {
      type: 'object',
      properties: {
        slug: str('Stable handle, e.g. "welcome" (lowercase, digits, dashes)'),
        name: str('Human-readable name'),
        subject: str('Subject line ({{variables}} allowed)'),
        html: str('HTML body - inline styles, email-safe markup ({{variables}} allowed)'),
        text: str('Plain-text body (at least one of html/text required)'),
        variables: {
          type: 'array',
          items: { type: 'string' },
          description: 'Declared placeholder names, for documentation',
        },
      },
      required: ['slug', 'name', 'subject'],
    },
    request: a => ({ method: 'POST', path: '/api/templates', body: a }),
  },
  {
    name: 'list_replies',
    description:
      'Inbound mail received on this instance (replies to sends, and mail to registered inbox addresses), newest first. Each row includes reply_to_message_id when it answers an email you sent.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 20, max 50)' },
        unread: { type: 'boolean', description: 'Only mail not yet read' },
      },
    },
    request: a => ({
      method: 'GET',
      path: `/api/replies?limit=${Number(a.limit) || 20}${a.unread ? '&unread=true' : ''}`,
    }),
  },
  {
    name: 'get_reply',
    description:
      'Full content of one inbound mail (text + html), with sender, subject, attachment metadata (index, filename, type, size - fetch content with get_reply_attachment), and the outbound message id it replies to.',
    inputSchema: {
      type: 'object',
      properties: { id: str('Inbound mail id (inb_…) from list_replies') },
      required: ['id'],
    },
    request: a => ({ method: 'GET', path: `/api/replies/${a.id}` }),
  },
  {
    name: 'get_reply_attachment',
    description:
      'Content of one attachment from an inbound mail, base64-encoded with filename/type/size. Indexes come from get_reply. Inline limit 4 MiB; larger files are fetchable raw via GET /api/replies/{id}/attachments/{index} with the same API key.',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('Inbound mail id (inb_…) from list_replies'),
        index: { type: 'number', description: '0-based attachment index from get_reply' },
      },
      required: ['id', 'index'],
    },
    request: a => ({
      method: 'GET',
      path: `/api/replies/${a.id}/attachments/${Number(a.index)}?format=base64`,
    }),
  },
  {
    name: 'reply_to',
    description:
      'Reply to an inbound mail as the address that received it. The reply threads into the recipient\'s mail client (In-Reply-To) and is recorded in the email log. Plain text; suppressed senders are refused.',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('Inbound mail id (inb_…) from list_replies'),
        text: str('Plain-text reply body'),
      },
      required: ['id', 'text'],
    },
    request: a => ({ method: 'POST', path: `/api/replies/${a.id}/reply`, body: { text: a.text } }),
  },
  {
    name: 'suppress_address',
    description:
      'Add an address to the suppression list - future sends to it are blocked at the API boundary.',
    inputSchema: {
      type: 'object',
      properties: { address: str('Email address to suppress') },
      required: ['address'],
    },
    request: a => ({ method: 'POST', path: '/api/suppressions', body: { address: a.address } }),
  },
  {
    name: 'list_suppressions',
    description: 'Addresses currently on the suppression list, with reasons.',
    inputSchema: {
      type: 'object',
      properties: { q: str('Optional search substring') },
    },
    request: a => ({
      method: 'GET',
      path: `/api/suppressions${a.q ? `?q=${encodeURIComponent(String(a.q))}` : ''}`,
    }),
  },
];

const rpcError = (id: unknown, code: number, message: string): object => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message },
});
const rpcResult = (id: unknown, result: unknown): object => ({ jsonrpc: '2.0', id, result });

export function mcpHandler(dispatch: Dispatch, version: () => string) {
  return async (c: Ctx): Promise<Response> => {
    let msg: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      msg = await c.req.json();
    } catch {
      return c.json(rpcError(null, -32700, 'Parse error'), 400);
    }
    const { id, method, params } = msg;

    if (method?.startsWith('notifications/')) return c.body(null, 202);

    switch (method) {
      case 'initialize': {
        const requested = String(params?.protocolVersion ?? '');
        return c.json(
          rpcResult(id, {
            protocolVersion: PROTOCOL_VERSIONS.includes(requested)
              ? requested
              : PROTOCOL_VERSIONS[0],
            capabilities: { tools: {} },
            serverInfo: { name: 'postey', title: 'Postey Email', version: version() },
          })
        );
      }
      case 'ping':
        return c.json(rpcResult(id, {}));
      case 'tools/list':
        return c.json(
          rpcResult(id, {
            tools: TOOLS.map(t => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          })
        );
      case 'tools/call': {
        const tool = TOOLS.find(t => t.name === params?.name);
        if (!tool) return c.json(rpcError(id, -32602, `Unknown tool: ${String(params?.name)}`));
        const args = (params?.arguments ?? {}) as Record<string, unknown>;
        const required = (tool.inputSchema.required ?? []) as string[];
        const missing = required.filter(k => args[k] === undefined || args[k] === '');
        if (missing.length > 0) {
          return c.json(
            rpcResult(id, {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    error: `Missing required argument(s) for ${tool.name}: ${missing.join(', ')}`,
                  }),
                },
              ],
              isError: true,
            })
          );
        }
        const { method: httpMethod, path, body } = tool.request(args);
        // Same-app dispatch: the API key in the Authorization header flows
        // through, so key auth and domain scoping run as usual.
        const res = await dispatch(
          path,
          {
            method: httpMethod,
            headers: {
              authorization: c.req.header('authorization') ?? '',
              ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          },
          c
        );
        const text = await res.text();
        return c.json(
          rpcResult(id, { content: [{ type: 'text', text }], isError: !res.ok })
        );
      }
      default:
        return c.json(rpcError(id, -32601, `Method not found: ${String(method)}`));
    }
  };
}
