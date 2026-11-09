import type { Surreal } from 'surrealdb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createProject,
  getProjectByChannel,
  getProjectByName,
  listProjectsInStage,
  moveStage,
  StageConflictError,
  updateProject,
} from '../../src/db/projects.js';
import { StageError } from '../../src/domain/stages.js';
import { memoryDb } from '../helpers/db.js';

let db: Surreal;
const owner = { actor: 'owner', actorId: '3', action: 'project.created', outcome: 'ok' } as const;

beforeAll(async () => {
  db = await memoryDb();
});
afterAll(async () => {
  await db.close();
});

async function eventsFor(name: string): Promise<Array<{ action: string; data?: Record<string, unknown> }>> {
  const [rows] = await db.query<[Array<{ action: string; data?: Record<string, unknown> }>]>(
    'SELECT action, data, at FROM event WHERE project = type::record("project", $name) ORDER BY at',
    { name },
  );
  return rows;
}

describe('projects', () => {
  it('creates a project in stage created, with its event', async () => {
    const project = await createProject(db, { name: 'alpha', channelId: 'c-alpha', repo: 'o/alpha', inviteCode: 'inv1' }, owner);
    expect(project).toMatchObject({ name: 'alpha', stage: 'created', invite_code: 'inv1', repo: 'o/alpha' });
    expect(project.created_at).toBeInstanceOf(Date);
    expect(project.client_id).toBeUndefined();
    expect((await eventsFor('alpha')).map((e) => e.action)).toEqual(['project.created']);
  });

  it('refuses a second project with the same name, and leaves no stray event', async () => {
    await expect(
      createProject(db, { name: 'alpha', channelId: 'c-other', repo: 'o/alpha', inviteCode: 'inv2' }, owner),
    ).rejects.toThrow();
    expect(await eventsFor('alpha')).toHaveLength(1);
  });

  it('finds projects by name, channel and stage', async () => {
    expect((await getProjectByName(db, 'alpha'))?.channel_id).toBe('c-alpha');
    expect((await getProjectByChannel(db, 'c-alpha'))?.name).toBe('alpha');
    expect(await getProjectByChannel(db, 'nope')).toBeUndefined();
    expect((await listProjectsInStage(db, 'created')).map((p) => p.name)).toContain('alpha');
  });

  it('moves the stage with its changes and event, in one go', async () => {
    const project = (await getProjectByName(db, 'alpha'))!;
    await moveStage(
      db,
      project,
      'created',
      'joined',
      { actor: 'client', actorId: '9', action: 'project.client_joined', outcome: 'ok' },
      { client_id: '9' },
    );
    const after = (await getProjectByName(db, 'alpha'))!;
    expect(after).toMatchObject({ stage: 'joined', client_id: '9' });
    const events = await eventsFor('alpha');
    expect(events.at(-1)).toMatchObject({ action: 'project.client_joined', data: { from: 'created', to: 'joined' } });
  });

  it('refuses a move from a stage the project has already left, changing nothing', async () => {
    const project = (await getProjectByName(db, 'alpha'))!;
    await expect(
      moveStage(db, project, 'created', 'joined', { actor: 'bot', action: 'x', outcome: 'ok' }, { client_id: 'other' }),
    ).rejects.toThrow(StageConflictError);
    expect((await getProjectByName(db, 'alpha'))?.client_id).toBe('9');
    expect((await eventsFor('alpha')).map((e) => e.action)).not.toContain('x');
  });

  it('refuses a move the stage rules forbid, before touching the database', async () => {
    const project = (await getProjectByName(db, 'alpha'))!;
    await expect(moveStage(db, project, 'joined', 'paid', { actor: 'bot', action: 'x', outcome: 'ok' })).rejects.toThrow(
      StageError,
    );
  });

  it('updates fields with an event, without changing the stage', async () => {
    const project = (await getProjectByName(db, 'alpha'))!;
    await updateProject(db, project, { client_github: 'octocat' }, { actor: 'client', action: 'project.github_added', outcome: 'ok' });
    expect(await getProjectByName(db, 'alpha')).toMatchObject({ stage: 'joined', client_github: 'octocat' });
    expect((await eventsFor('alpha')).at(-1)?.action).toBe('project.github_added');
  });
});
