// The bot's web port. A tiny status page, so hosts that check a web port (Replit's
// Reserved VM) can see the bot is up. It is public, so it says only "ok" or "degraded",
// and whether Discord and the database are connected: no project names, counts or settings.
// It answers 200 even while the database is down: the bot reconnects by itself, and a
// failing check could make the host restart it in a loop during a database outage. Extra routes, such as
// /mcp for Claude Code, do their own checks; until one is ready it answers 503.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { log } from './log.js';

export type RouteHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;
/** Path to a getter, so a route can be added before the database is connected. */
export type Routes = Record<string, () => RouteHandler | undefined>;

export const DEFAULT_HEALTH_PORT = 8080;

/** The port to listen on: $PORT when it is a valid port number, otherwise 8080. */
export function healthPort(value: string | undefined): number {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_HEALTH_PORT;
}

export function startHealthServer(
  port: number,
  isReady: () => boolean,
  routes: Routes = {},
  databaseStatus?: () => string | undefined,
): Server {
  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    if (Object.hasOwn(routes, path)) {
      const handle = routes[path]?.();
      if (!handle) {
        response.writeHead(503, { 'content-type': 'application/json', 'retry-after': '10' });
        response.end(JSON.stringify({ error: 'starting' }));
        return;
      }
      handle(request, response).catch((error: unknown) => {
        log.error('web request failed', { path, error });
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
        if (!response.writableEnded) response.end(JSON.stringify({ error: 'internal error' }));
      });
      return;
    }
    if ((request.method === 'GET' || request.method === 'HEAD') && (path === '/' || path === '/health')) {
      const database = databaseStatus ? (databaseStatus() ?? 'starting') : undefined;
      const body = JSON.stringify({
        status: database === undefined || database === 'connected' ? 'ok' : 'degraded',
        discord: isReady() ? 'connected' : 'starting',
        ...(database === undefined ? {} : { database }),
      });
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : body);
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('Not found');
  });
  // A busy port (another app on this machine) must never stop the bot itself.
  server.on('error', (error) => log.warn('status page could not start', { port, error }));
  server.listen(port, '0.0.0.0', () => log.info('status page listening', { port }));
  return server;
}
