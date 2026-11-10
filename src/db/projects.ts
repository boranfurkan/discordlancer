// Projects: typed reads, creation, and stage changes. A stage change checks the
// stage it starts from and writes its event in the same transaction, so two
// commands racing each other can't both win.

import { DateTime, RecordId, type Surreal } from 'surrealdb';
import { z } from 'zod';
import { assertMove, STAGES, type Stage } from '../domain/stages.js';
import type { EventInput } from './events.js';

export const toDate = z.custom<DateTime | Date>((value) => value instanceof DateTime || value instanceof Date).transform(
  (value) => (value instanceof DateTime ? value.toDate() : value),
);

export const ProjectRow = z.object({
  id: z.custom<RecordId<'project'>>((value) => value instanceof RecordId),
  name: z.string(),
  channel_id: z.string(),
  repo: z.string(),
  invite_code: z.string().optional(),
  client_id: z.string().optional(),
  client_ids: z.array(z.string()).optional(),
  client_github: z.string().optional(),
  client_wallet: z.string().optional(),
  delivery_marked_at: toDate.optional(),
  delivery_note: z.string().optional(),
  dev_key_hash: z.string().optional(),
  stage: z.enum(STAGES),
  created_at: toDate,
  updated_at: toDate,
});

export type Project = z.infer<typeof ProjectRow>;

/** Everyone on the client's side: the first client, then anyone who joined with a team invite. */
export function clientMembers(project: Pick<Project, 'client_id' | 'client_ids'>): string[] {
  return [...new Set([...(project.client_id ? [project.client_id] : []), ...(project.client_ids ?? [])])];
}

/** Whether this person is on the client's side of the project. Any of them may act for the client. */
export function isClientMember(project: Pick<Project, 'client_id' | 'client_ids'>, userId: string): boolean {
  return clientMembers(project).includes(userId);
}

export function projectId(name: string): RecordId<'project'> {
  return new RecordId('project', name);
}

function parseRows(rows: unknown[]): Project[] {
  return rows.map((row) => ProjectRow.parse(row));
}

export async function getProjectByName(db: Surreal, name: string): Promise<Project | undefined> {
  const [rows] = await db.query<[unknown[]]>('SELECT * FROM $id', { id: projectId(name) });
  return parseRows(rows)[0];
}

export async function getProjectByChannel(db: Surreal, channelId: string): Promise<Project | undefined> {
  const [rows] = await db.query<[unknown[]]>('SELECT * FROM project WHERE channel_id = $channelId LIMIT 1', { channelId });
  return parseRows(rows)[0];
}

/** The project a Claude Code key belongs to, by the key's hash. */
export async function getProjectByDevKeyHash(db: Surreal, hash: string): Promise<Project | undefined> {
  const [rows] = await db.query<[unknown[]]>('SELECT * FROM project WHERE dev_key_hash = $hash LIMIT 1', { hash });
  return parseRows(rows)[0];
}

export async function listProjectsInStage(db: Surreal, stage: Stage): Promise<Project[]> {
  const [rows] = await db.query<[unknown[]]>('SELECT * FROM project WHERE stage = $stage ORDER BY created_at', { stage });
  return parseRows(rows);
}

export function eventContent(event: EventInput, project: RecordId<'project'>): Record<string, unknown> {
  const content: Record<string, unknown> = {
    actor: event.actor,
    action: event.action,
    outcome: event.outcome,
    project,
  };
  if (event.actorId) content.actor_id = event.actorId;
  if (event.data) content.data = event.data;
  return content;
}

export interface NewProject {
  name: string;
  channelId: string;
  repo: string;
  inviteCode: string;
}

/** Creates the project in stage `created`, with its event, in one transaction. */
export async function createProject(db: Surreal, input: NewProject, event: Omit<EventInput, 'project'>): Promise<Project> {
  const id = projectId(input.name);
  await db.query(
    `BEGIN TRANSACTION;
     CREATE ONLY $id CONTENT $content RETURN NONE;
     CREATE event CONTENT $event RETURN NONE;
     COMMIT TRANSACTION;`,
    {
      id,
      content: { name: input.name, channel_id: input.channelId, repo: input.repo, invite_code: input.inviteCode, stage: 'created' },
      event: eventContent({ ...event }, id),
    },
  );
  const project = await getProjectByName(db, input.name);
  if (!project) throw new Error(`Project ${input.name} was not saved`);
  return project;
}

export class StageConflictError extends Error {
  override name = 'StageConflictError';
}

/** Fields a stage change may set at the same time. */
export interface ProjectChanges {
  invite_code?: string;
  client_id?: string;
  client_ids?: string[];
  client_github?: string;
  client_wallet?: string;
  delivery_marked_at?: Date;
  delivery_note?: string;
  dev_key_hash?: string;
}

/**
 * Moves a project from `from` to `to`, applying `changes` and writing `event`, in one
 * transaction. Throws StageConflictError if the project is no longer in `from`.
 */
export async function moveStage(
  db: Surreal,
  project: Pick<Project, 'id'>,
  from: Stage,
  to: Stage,
  event: Omit<EventInput, 'project'>,
  changes: ProjectChanges = {},
): Promise<void> {
  assertMove(from, to);
  try {
    await db.query(
      `BEGIN TRANSACTION;
       LET $current = (SELECT VALUE stage FROM ONLY $id);
       IF $current != $from { THROW "stage_conflict" };
       UPDATE ONLY $id MERGE $changes RETURN NONE;
       CREATE event CONTENT $event RETURN NONE;
       COMMIT TRANSACTION;`,
      {
        id: project.id,
        from,
        changes: { ...changes, stage: to },
        event: eventContent({ ...event, data: { ...event.data, from, to } }, project.id),
      },
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes('stage_conflict')) {
      throw new StageConflictError(`The project is no longer at ${from}; someone may have just changed it`);
    }
    throw error;
  }
}

/** Adds someone to the client's team, with its event, in one transaction. Safe to run twice. */
export async function addClientMember(db: Surreal, project: Pick<Project, 'id'>, userId: string, event: Omit<EventInput, 'project'>): Promise<void> {
  await db.query(
    `BEGIN TRANSACTION;
     UPDATE ONLY $id SET client_ids = array::union(client_ids ?? [], [$userId]) RETURN NONE;
     CREATE event CONTENT $event RETURN NONE;
     COMMIT TRANSACTION;`,
    { id: project.id, userId, event: eventContent(event, project.id) },
  );
}

/** Updates fields without changing the stage, writing `event` in the same transaction. */
export async function updateProject(
  db: Surreal,
  project: Pick<Project, 'id'>,
  changes: ProjectChanges,
  event: Omit<EventInput, 'project'>,
): Promise<void> {
  await db.query(
    `BEGIN TRANSACTION;
     UPDATE ONLY $id MERGE $changes RETURN NONE;
     CREATE event CONTENT $event RETURN NONE;
     COMMIT TRANSACTION;`,
    { id: project.id, changes, event: eventContent(event, project.id) },
  );
}

export async function getProject(db: Surreal, id: RecordId<'project'>): Promise<Project | undefined> {
  const [rows] = await db.query<[unknown[]]>('SELECT * FROM $id', { id });
  return parseRows(rows)[0];
}
