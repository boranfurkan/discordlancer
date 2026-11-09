// An in-memory SurrealDB 4 for tests, with the real schema applied.

import { createNodeEngines } from '@surrealdb/node';
import { createRemoteEngines, Surreal } from 'surrealdb';
import { applySchema } from '../../src/db/migrate.js';

export async function memoryDb(): Promise<Surreal> {
  const db = new Surreal({ engines: { ...createRemoteEngines(), ...createNodeEngines() } });
  await db.connect('mem://');
  await db.use({ namespace: 'test', database: 'test' });
  await applySchema(db);
  return db;
}
