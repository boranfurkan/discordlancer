// One long-lived WebSocket connection to SurrealDB Cloud. The SDK signs in again
// and reconnects by itself; we only log what happens.
//
// SurrealDB 4 (Earth) refuses system users on HTTP /signin, but accepts them over
// the WebSocket RPC, which is what the SDK uses here.

import { Surreal } from 'surrealdb';
import type { Env } from '../env.js';
import { log } from '../log.js';

export async function connectDatabase(env: Env): Promise<Surreal> {
  const db = new Surreal();
  db.subscribe('connected', (version) => log.info('database connected', { version }));
  db.subscribe('reconnecting', () => log.warn('database reconnecting'));
  db.subscribe('disconnected', () => log.warn('database disconnected'));
  db.subscribe('error', (error) => log.error('database error', { error }));

  await db.connect(env.SURREAL_URL, {
    namespace: env.SURREAL_NAMESPACE,
    database: env.SURREAL_DATABASE,
    authentication: { username: env.SURREAL_USER, password: env.SURREAL_PASS },
    reconnect: { enabled: true, attempts: -1, retryDelay: 1_000, retryDelayMax: 20_000 },
  });
  return db;
}

/**
 * Closes the connection, but never waits more than `timeoutMs`. Against SurrealDB 4
 * (Earth) the WebSocket close handshake doesn't finish, so an awaited close() hangs.
 * Callers that are exiting call process.exit() after this.
 */
export async function closeDatabase(db: Surreal, timeoutMs = 3_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    const result = await Promise.race([db.close().then(() => 'closed' as const), timeout]);
    if (result === 'timeout') log.warn('database close timed out', { timeoutMs });
  } catch (error) {
    log.warn('database close failed', { error });
  } finally {
    clearTimeout(timer);
  }
}
