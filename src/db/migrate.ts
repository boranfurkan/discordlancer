// Applies schema.surql. Every definition uses OVERWRITE, so running it again is safe.
// Run by hand with `npm run db:migrate`; the bot also runs it at startup.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Surreal } from 'surrealdb';
import { loadEnv, secretValues } from '../env.js';
import { log, registerSecrets } from '../log.js';
import { closeDatabase, connectDatabase } from './client.js';

export function readSchema(): string {
  // Next to this file in src/ (tsx) and in dist/ (the build copies it there).
  return readFileSync(new URL('./schema.surql', import.meta.url), 'utf8');
}

export async function applySchema(db: Surreal, schema = readSchema()): Promise<void> {
  await db.query(schema);
}

async function main(): Promise<void> {
  const env = loadEnv();
  registerSecrets(secretValues(env));
  const db = await connectDatabase(env);
  try {
    await applySchema(db);
    log.info('schema applied', { namespace: env.SURREAL_NAMESPACE, database: env.SURREAL_DATABASE });
  } finally {
    await closeDatabase(db);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      log.error('migration failed', { error });
      process.exit(1);
    },
  );
}
