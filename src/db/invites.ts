// Team invites: extra single-use invites for the rest of a client's team. Mutable
// (open, then used), so each change is written with its event in one transaction.

import { RecordId, type Surreal } from 'surrealdb';
import { z } from 'zod';
import type { EventInput } from './events.js';
import { eventContent, toDate, type Project } from './projects.js';

export const InviteRow = z.object({
  id: z.custom<RecordId<'invite'>>((value) => value instanceof RecordId),
  code: z.string(),
  project: z.custom<RecordId<'project'>>((value) => value instanceof RecordId),
  status: z.enum(['open', 'used']),
  used_by: z.string().optional(),
  created_at: toDate,
});
export type Invite = z.infer<typeof InviteRow>;

export async function saveInvite(db: Surreal, project: Pick<Project, 'id'>, code: string, event: Omit<EventInput, 'project'>): Promise<void> {
  await db.query(
    `BEGIN TRANSACTION;
     CREATE invite CONTENT $content RETURN NONE;
     CREATE event CONTENT $event RETURN NONE;
     COMMIT TRANSACTION;`,
    { content: { code, project: project.id, status: 'open' }, event: eventContent(event, project.id) },
  );
}

/** Every team invite not used yet, for join matching. */
export async function openInvites(db: Surreal): Promise<Invite[]> {
  const [rows] = await db.query<[unknown[]]>('SELECT * FROM invite WHERE status = "open" ORDER BY created_at');
  return rows.map((row) => InviteRow.parse(row));
}

export async function markInviteUsed(db: Surreal, invite: Pick<Invite, 'id'>, userId: string): Promise<void> {
  await db.query('UPDATE $id MERGE { status: "used", used_by: $userId } RETURN NONE', { id: invite.id, userId });
}
