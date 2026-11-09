// Change requests after delivery. Mutable (their status moves on), so each change is
// written with its event in one transaction.

import { RecordId, type Surreal } from 'surrealdb';
import { z } from 'zod';
import type { EventInput } from './events.js';
import { eventContent, toDate, type Project } from './projects.js';

export const CHANGE_STATUSES = ['triaged', 'needs_info', 'approved', 'declined', 'issue_opened', 'pr_open', 'merged', 'closed'] as const;
export type ChangeStatus = (typeof CHANGE_STATUSES)[number];

export const ChangeRequestRow = z.object({
  id: z.custom<RecordId<'change_request'>>((value) => value instanceof RecordId),
  project: z.custom<RecordId<'project'>>((value) => value instanceof RecordId),
  text: z.string(),
  triage: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(CHANGE_STATUSES),
  issue_number: z.number().int().optional(),
  pr_number: z.number().int().optional(),
  created_at: toDate,
});
export type ChangeRequest = z.infer<typeof ChangeRequestRow>;

export async function createChangeRequest(
  db: Surreal,
  project: Pick<Project, 'id'>,
  request: { text: string; triage: Record<string, unknown>; status: ChangeStatus },
  event: Omit<EventInput, 'project'>,
): Promise<ChangeRequest> {
  const id = new RecordId('change_request', crypto.randomUUID());
  await db.query(
    `BEGIN TRANSACTION;
     CREATE ONLY $id CONTENT $content RETURN NONE;
     CREATE event CONTENT $event RETURN NONE;
     COMMIT TRANSACTION;`,
    {
      id,
      content: { project: project.id, text: request.text, triage: request.triage, status: request.status },
      event: eventContent({ ...event, data: { ...event.data, change_request: String(id.id), status: request.status } }, project.id),
    },
  );
  return (await getChangeRequest(db, String(id.id)))!;
}

export async function getChangeRequest(db: Surreal, key: string): Promise<ChangeRequest | undefined> {
  const [rows] = await db.query<[unknown[]]>('SELECT * FROM $id', { id: new RecordId('change_request', key) });
  return rows[0] === undefined ? undefined : ChangeRequestRow.parse(rows[0]);
}

/** Moves a request on from `from`; refuses if someone else already moved it. */
export async function updateChangeRequest(
  db: Surreal,
  request: Pick<ChangeRequest, 'id' | 'project'>,
  from: ChangeStatus,
  changes: { status: ChangeStatus; issue_number?: number },
  event: Omit<EventInput, 'project'>,
): Promise<boolean> {
  try {
    await db.query(
      `BEGIN TRANSACTION;
       IF (SELECT VALUE status FROM ONLY $id) != $from { THROW "change_conflict" };
       UPDATE ONLY $id MERGE $changes RETURN NONE;
       CREATE event CONTENT $event RETURN NONE;
       COMMIT TRANSACTION;`,
      {
        id: request.id,
        from,
        changes,
        event: eventContent({ ...event, data: { ...event.data, change_request: String(request.id.id), from, to: changes.status } }, request.project),
      },
    );
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('change_conflict')) return false;
    throw error;
  }
}

/** How many change requests this project made since `since`, for the monthly limit. */
export async function countChangeRequestsSince(db: Surreal, project: Pick<Project, 'id'>, since: Date): Promise<number> {
  const [rows] = await db.query<[number[]]>(
    'SELECT VALUE count() FROM change_request WHERE project = $p AND created_at >= $since GROUP ALL',
    { p: project.id, since },
  );
  return rows[0] ?? 0;
}
