// recordEvent() is the only way to write to the event log. The schema blocks
// updates and deletes, so a mistake is corrected with a new event, never an edit.

import { DateTime, RecordId, type Surreal } from 'surrealdb';
import { z } from 'zod';
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

export const EventRow = z.object({
  at: z.custom<DateTime | Date>((value) => value instanceof DateTime || value instanceof Date).transform((value) =>
    value instanceof DateTime ? value.toDate() : value,
  ),
  project: z.custom<RecordId>((value) => value instanceof RecordId).optional(),
  actor: z.enum(['owner', 'client', 'bot']),
  actor_id: z.string().optional(),
  action: z.string(),
  outcome: z.enum(['ok', 'refused', 'failed']),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type EventRecord = z.infer<typeof EventRow>;

export async function eventsForProject(db: Surreal, project: RecordId<'project'>): Promise<EventRecord[]> {
  const [rows] = await db.query<[unknown[]]>('SELECT * FROM event WHERE project = $p ORDER BY at', { p: project });
  return rows.map((row) => EventRow.parse(row));
}

export async function eventsSince(db: Surreal, since: Date, actor?: Actor): Promise<EventRecord[]> {
  const [rows] = await db.query<[unknown[]]>(
    actor ? 'SELECT * FROM event WHERE at >= $since AND actor = $actor ORDER BY at' : 'SELECT * FROM event WHERE at >= $since ORDER BY at',
    { since, actor },
  );
  return rows.map((row) => EventRow.parse(row));
}
