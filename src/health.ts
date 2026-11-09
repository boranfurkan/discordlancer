// A tiny status page so hosts that check a web port (Replit's Reserved VM) can see the
// bot is up. It is public, so it says only "ok" and whether Discord is connected:
// no project names, counts or settings.

import { createServer, type Server } from 'node:http';
import { log } from './log.js';

export const DEFAULT_HEALTH_PORT = 8080;

/** The port to listen on: $PORT when it is a valid port number, otherwise 8080. */
export function healthPort(value: string | undefined): number {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_HEALTH_PORT;
}

export function startHealthServer(port: number, isReady: () => boolean): Server {
  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0];
    if ((request.method === 'GET' || request.method === 'HEAD') && (path === '/' || path === '/health')) {
      const body = JSON.stringify({ status: 'ok', discord: isReady() ? 'connected' : 'starting' });
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
