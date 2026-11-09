// recordEvent() is the only way to write to the event log. The schema blocks
// updates and deletes, so a mistake is corrected with a new event, never an edit.

import type { RecordId, Surreal } from 'surrealdb';
import { log } from '../log.js';

export type Actor = 'owner' | 'client' | 'bot';
export type Outcome = 'ok' | 'refused' | 'failed';

export interface EventInput {
  actor: Actor;
  action: string;
  outcome: Outcome;
  project?: RecordId<'project'>;
  actorId?: string;
  data?: Record<string, unknown>;
}

export async function recordEvent(db: Surreal, input: EventInput): Promise<void> {
  // Leave out absent fields rather than sending undefined.
  const content: Record<string, unknown> = {
    actor: input.actor,
    action: input.action,
    outcome: input.outcome,
  };
  if (input.project) content.project = input.project;
  if (input.actorId) content.actor_id = input.actorId;
  if (input.data) content.data = input.data;

  await db.query('CREATE event CONTENT $content RETURN NONE', { content });
  log.info('event', {
    action: input.action,
    actor: input.actor,
    outcome: input.outcome,
    project: input.project?.toString(),
  });
}
