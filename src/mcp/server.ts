// A small MCP server (Streamable HTTP, stateless, JSON replies) at /mcp, for Boran's
// Claude Code sessions. Each request carries one project's key, and can only read that
// project's brief and post progress updates in that project's channel.
//
// Written by hand rather than with the MCP SDK: two tools need only a few JSON-RPC
// methods, and the SDK would add a web framework and a dozen packages to a bot that
// holds payment and Discord secrets.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Surreal } from 'surrealdb';
import { changeRequestsFor } from '../db/changes.js';
import { agreedParties, latestQuote, latestSpec } from '../db/deals.js';
import { countEventsSince, eventsForProject, recordEvent } from '../db/events.js';
import { paymentsFor } from '../db/payments.js';
import { getProjectByDevKeyHash, type Project } from '../db/projects.js';
import { londonDayStart } from '../domain/deadline.js';
import { bearerKey, hashDevKey } from '../domain/devKey.js';
import { log } from '../log.js';
import { projectScope, safeRemember, type MemoryApi } from '../services/memory.js';
import {
  findSecret,
  formatUpdate,
  MAX_UPDATE_CHARS,
  memoryLine,
  renderBrief,
  SERVER_INSTRUCTIONS,
  UPDATE_ACTION,
  UPDATE_INPUT_SCHEMA,
  UPDATE_STAGES,
  UpdateInput,
  UPDATES_PER_DAY,
} from './updates.js';

export const MCP_PATH = '/mcp';
export const MAX_BODY_BYTES = 64 * 1024;
/** Newest first. The client's version is used when we know it, otherwise our newest. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
const SERVER_INFO = { name: 'discordlancer', version: '0.1.0' };

export interface McpDeps {
  db: Surreal;
  memory: MemoryApi;
  ownerId: string;
  /** Posts in the project's 📈 Progress updates thread without pinging anyone; returns the message link. */
  post(project: Project, content: string): Promise<{ url: string }>;
  now?: () => Date;
}

export type RequestHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

type Id = string | number | null;
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const TOOLS = [
  {
    name: 'get_project_brief',
    title: 'Read the project brief',
    description:
      "This project's current state from Discordlancer: stage, the latest spec and whether it is agreed, the quote's deadline, payments, change requests, and the progress updates already posted (with how many are left today). Read-only.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'post_update',
    title: "Post a progress update to the client's channel",
    description: `Posts a progress update in the client's private Discord channel, marked as written by the developer's AI coding assistant. The client reads it: write plainly, report only what is done, never promise dates, prices or features beyond the agreed spec, and never include secrets. At most ${UPDATES_PER_DAY} a day.`,
    inputSchema: UPDATE_INPUT_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
] as const;

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  response.end(JSON.stringify(body));
}

const rpcError = (id: Id, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
const text = (value: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError } : {}) });

async function readBody(request: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Pure: the protocol version to answer `initialize` with. */
export function chooseProtocolVersion(requested: unknown): string {
  return typeof requested === 'string' && (PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : PROTOCOL_VERSIONS[0];
}

async function brief(deps: McpDeps, project: Project, now: Date): Promise<ToolResult> {
  const [spec, quote, payments, changes, events, updatesToday] = await Promise.all([
    latestSpec(deps.db, project),
    latestQuote(deps.db, project),
    paymentsFor(deps.db, project),
    changeRequestsFor(deps.db, project),
    eventsForProject(deps.db, project.id),
    countEventsSince(deps.db, project.id, UPDATE_ACTION, londonDayStart(now)),
  ]);
  const specAgreed = spec ? [...(await agreedParties(deps.db, project, 'spec', spec.version))] : [];
  const quoteAgreed = quote ? [...(await agreedParties(deps.db, project, 'quote', quote.version))] : [];
  const updates = events
    .filter((event) => event.action === UPDATE_ACTION && event.outcome === 'ok' && typeof event.data?.summary === 'string')
    .slice(-5)
    .map((event) => ({ at: event.at, summary: String(event.data?.summary) }));
  return text(
    renderBrief({
      project,
      spec: spec ? { spec, agreedBy: specAgreed } : undefined,
      quote: quote ? { quote, agreedBy: quoteAgreed } : undefined,
      payments,
      changes,
      updates,
      updatesToday,
    }),
  );
}

async function postUpdate(deps: McpDeps, project: Project, args: unknown, now: Date): Promise<ToolResult> {
  if (!UPDATE_STAGES.includes(project.stage)) {
    return text(`Updates can't be posted while the project is at "${project.stage}"${project.stage === 'created' ? ': the client has not joined yet' : ''}.`, true);
  }
  const parsed = UpdateInput.safeParse(args ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ');
    return text(`The update wasn't posted: ${issues}.`, true);
  }
  const message = formatUpdate(parsed.data);
  const secret = findSecret(message);
  if (secret) return text(`The update wasn't posted: it seems to contain ${secret}. Remove it and try again.`, true);
  if (message.length > MAX_UPDATE_CHARS) {
    return text(`The update wasn't posted: it is ${message.length} characters and must fit in ${MAX_UPDATE_CHARS}. Make it shorter.`, true);
  }
  const today = await countEventsSince(deps.db, project.id, UPDATE_ACTION, londonDayStart(now));
  if (today >= UPDATES_PER_DAY) {
    return text(`The update wasn't posted: this project already had ${UPDATES_PER_DAY} updates today. Save it for tomorrow.`, true);
  }

  const { url } = await deps.post(project, message);
  try {
    await recordEvent(deps.db, {
      actor: 'owner',
      actorId: deps.ownerId,
      action: UPDATE_ACTION,
      outcome: 'ok',
      project: project.id,
      data: {
        via: 'claude-code',
        summary: parsed.data.summary,
        done: parsed.data.done.length,
        next: parsed.data.next.length,
        asks_client: Boolean(parsed.data.needs_from_client),
        url,
      },
    });
  } catch (error) {
    log.error('could not record a progress update', { project: project.name, error });
  }
  // Memory can take a while; the update is already posted, so don't keep the session waiting.
  void safeRemember(deps.memory, projectScope(project.name), memoryLine(parsed.data, now));
  return text(`Posted in the client's channel (its Progress updates thread): ${url}\nUpdates left today: ${Math.max(0, UPDATES_PER_DAY - today - 1)}.`);
}

async function callTool(deps: McpDeps, project: Project, params: Record<string, unknown>): Promise<ToolResult> {
  const now = (deps.now ?? (() => new Date()))();
  const name = params.name;
  try {
    if (name === 'get_project_brief') return await brief(deps, project, now);
    if (name === 'post_update') return await postUpdate(deps, project, params.arguments, now);
  } catch (error) {
    log.error('an MCP tool failed', { project: project.name, tool: name, error });
    return text("Something went wrong on the bot's side. It has been logged; try again in a minute.", true);
  }
  throw new RpcError(-32602, `Unknown tool: ${String(name)}`);
}

async function dispatch(deps: McpDeps, project: Project, method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: chooseProtocolVersion(params.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: SERVER_INSTRUCTIONS,
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call':
      return callTool(deps, project, params);
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

export function createMcpHandler(deps: McpDeps): RequestHandler {
  return async (request, response) => {
    // Claude Code sends no Origin. A browser does, and has no business here.
    if (request.headers.origin) return sendJson(response, 403, { error: 'forbidden' });
    if (request.method !== 'POST') return sendJson(response, 405, { error: 'method not allowed' }, { allow: 'POST' });

    const key = bearerKey(request.headers.authorization);
    const project = key ? await getProjectByDevKeyHash(deps.db, hashDevKey(key)) : undefined;
    if (!project) {
      log.warn('MCP request with a missing or unknown key', { address: request.socket.remoteAddress });
      return sendJson(response, 401, rpcError(null, -32001, 'Unknown or missing project key'), { 'www-authenticate': 'Bearer error="invalid_token"' });
    }

    const body = await readBody(request);
    if (body === undefined) return sendJson(response, 413, rpcError(null, -32600, 'Request too large'));
    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      return sendJson(response, 400, rpcError(null, -32700, 'Parse error'));
    }
    if (Array.isArray(message)) return sendJson(response, 400, rpcError(null, -32600, 'Batches are not supported'));
    if (typeof message !== 'object' || message === null || (message as { jsonrpc?: unknown }).jsonrpc !== '2.0') {
      return sendJson(response, 400, rpcError(null, -32600, 'Invalid request'));
    }
    const { id, method, params } = message as { id?: Id; method?: unknown; params?: unknown };

    // Notifications and replies to us need no answer.
    if (typeof method !== 'string' || id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const safeParams = typeof params === 'object' && params !== null && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
    log.info('mcp request', { project: project.name, method, tool: method === 'tools/call' ? safeParams.name : undefined });
    try {
      const result = await dispatch(deps, project, method, safeParams);
      sendJson(response, 200, { jsonrpc: '2.0', id, result });
    } catch (error) {
      if (error instanceof RpcError) return sendJson(response, 200, rpcError(id, error.code, error.message));
      log.error('MCP request failed', { project: project.name, method, error });
      sendJson(response, 200, rpcError(id, -32603, 'Internal error'));
    }
  };
}
