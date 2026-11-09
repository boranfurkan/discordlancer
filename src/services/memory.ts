// SurrealDB Agent Memory over its REST API (the SDK is still an alpha). Memory is
// best-effort: the database stays the record of truth, and a failed memory call never
// stops a command. Each project has its own scope, so recall stays within it.

import { z } from 'zod';
import type { Env } from '../env.js';
import { log } from '../log.js';

const TIMEOUT_MS = 30_000;

export function projectScope(projectName: string): string {
  return `discordlancer/project/${projectName}`;
}

export interface MemoryApi {
  remember(scope: string, text: string): Promise<void>;
  /** An LLM-ready context string, or '' when nothing relevant is remembered. */
  recall(scope: string, query: string, k?: number): Promise<string>;
}

const ContextResponse = z.object({ context: z.string().optional() });

export function createMemory(
  env: Pick<Env, 'MEMORY_URL' | 'MEMORY_CONTEXT_ID' | 'MEMORY_API_KEY'>,
  options: { fetch?: typeof fetch } = {},
): MemoryApi {
  const doFetch = options.fetch ?? fetch;
  const base = `${new URL(env.MEMORY_URL).origin}/api/v1/${encodeURIComponent(env.MEMORY_CONTEXT_ID)}`;

  async function post(path: string, body: unknown): Promise<unknown> {
    const response = await doFetch(`${base}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.MEMORY_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      const message = await response.text().catch(() => '');
      throw new Error(`Agent Memory ${path} returned HTTP ${response.status}: ${message.slice(0, 200)}`);
    }
    return response.json();
  }

  // Agent Memory refuses writes to a scope path that isn't registered ("unknown scope
  // node"). Registering is idempotent, so each path chain is registered once per run.
  const registered = new Set<string>();
  async function ensureScope(scope: string): Promise<void> {
    const parts = scope.split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const path = parts.slice(0, i).join('/');
      if (registered.has(path)) continue;
      await post('/scopes', { path });
      registered.add(path);
    }
  }

  return {
    async remember(scope, text) {
      await ensureScope(scope);
      await post('/facts', { text, infer: 'full', scopes: [[scope]] });
    },
    async recall(scope, query, k = 10) {
      await ensureScope(scope);
      const parsed = ContextResponse.safeParse(await post('/context', { query, k, lens: [[scope]] }));
      return parsed.success ? (parsed.data.context ?? '').trim() : '';
    },
  };
}

/** Remembers without ever throwing: memory must not break the work it describes. */
export async function safeRemember(memory: MemoryApi, scope: string, text: string): Promise<void> {
  try {
    await memory.remember(scope, text);
  } catch (error) {
    log.warn('could not write to agent memory', { scope, error });
  }
}

/** Recalls without ever throwing; returns '' on any failure. */
export async function safeRecall(memory: MemoryApi, scope: string, query: string): Promise<string> {
  try {
    return await memory.recall(scope, query);
  } catch (error) {
    log.warn('could not read agent memory', { scope, error });
    return '';
  }
}
