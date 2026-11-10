// Keys for Boran's Claude Code sessions. Each project has at most one; it lets a
// session read that project's brief and post progress updates in its channel, nothing
// else. Only the key's SHA-256 is stored, so the database never holds the key itself.

import { createHash, randomBytes } from 'node:crypto';

export const DEV_KEY_PREFIX = 'dlk_';

/** A new random key: 32 bytes, so it can't be guessed. */
export function newDevKey(): string {
  return `${DEV_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function hashDevKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** Pure: the key in an `Authorization: Bearer …` header, if it looks like one of ours. */
export function bearerKey(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  const key = match?.[1];
  return key && key.startsWith(DEV_KEY_PREFIX) && key.length >= 40 && key.length <= 100 ? key : undefined;
}
