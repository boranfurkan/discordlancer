// Pure checks run before a command. Stage and project-channel checks arrive in phase 2.

import type { Actor } from '../db/events.js';
import type { Command } from './command.js';

export const OWNER_NAME = 'Furkan';

export function actorFor(userId: string, ownerId: string): Actor {
  return userId === ownerId ? 'owner' : 'client';
}

export type AccessCheck = { ok: true } | { ok: false; reply: string };

export function checkAccess(command: Pick<Command, 'access'>, userId: string, ownerId: string): AccessCheck {
  if (command.access === 'owner' && userId !== ownerId) {
    return { ok: false, reply: `Only ${OWNER_NAME} can do this.` };
  }
  return { ok: true };
}
