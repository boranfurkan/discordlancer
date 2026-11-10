import { RecordId, type Surreal } from 'surrealdb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callLabel, callsFor, saveCall } from '../src/db/calls.js';
import { memoryDb } from './helpers/db.js';

let db: Surreal;
const project = { id: new RecordId('project', 'alpha') };

beforeAll(async () => {
  db = await memoryDb();
  await db.query('CREATE $id CONTENT $c', { id: project.id, c: { name: 'alpha', channel_id: 'c1', repo: 'o/alpha', stage: 'in_development' } });
});
afterAll(async () => {
  await db.close();
});

const call = {
  startedAt: new Date('2026-11-12T14:00:30Z'),
  endedAt: new Date('2026-11-12T14:31:00Z'),
  participants: [
    { user_id: 'o1', name: 'Furkan', role: 'owner', recorded: true },
    { user_id: 'c1', name: 'Ayse', role: 'client', recorded: true },
  ],
  transcript: '[00:00:05] Furkan: Hello.\n[00:00:09] Ayse: Hi.',
  summary: { summary: 'Kick-off call.', decisions: ['Use Stripe'], action_items: [{ who: 'client', what: 'Send the logo' }], open_questions: [] },
  speechSeconds: 612.4,
  segments: 2,
  model: 'test-model',
  promptVersion: 'transcribe-v1+call-summary-v1',
} as const;

describe('calls', () => {
  it('are saved with their participants, transcript, summary and event', async () => {
    const saved = await saveCall(db, project, { ...call, participants: [...call.participants] , summary: { ...call.summary, decisions: [...call.summary.decisions], action_items: [...call.summary.action_items], open_questions: [] } }, { actor: 'owner', actorId: 'o1', action: 'call.recorded', outcome: 'ok' });
    expect(saved.participants).toEqual(call.participants);
    expect(saved.summary.action_items).toEqual([{ who: 'client', what: 'Send the logo' }]);
    expect(saved.speech_seconds).toBe(612);
    expect(callLabel(saved)).toBe('2026-11-12 14:00');
    expect((await callsFor(db, project)).map((c) => c.transcript)).toEqual([call.transcript]);
    const [events] = await db.query<[Array<{ action: string; data: { call: string } }>]>('SELECT action, data FROM event WHERE project = $p', { p: project.id });
    expect(events).toEqual([{ action: 'call.recorded', data: { call: saved.id.toString() } }]);
  });

  it('are append-only', async () => {
    const [first] = await callsFor(db, project);
    await expect(db.query('UPDATE $id SET transcript = "changed"', { id: first!.id })).rejects.toThrow(/append-only/);
    await expect(db.query('DELETE $id', { id: first!.id })).rejects.toThrow(/append-only/);
  });

  it('refuse a participant role the code does not know', async () => {
    await expect(
      db.query('CREATE call CONTENT $c', { c: { project: project.id, started_at: new Date(), ended_at: new Date(), participants: [{ user_id: 'x', name: 'x', role: 'guest', recorded: true }], transcript: '', summary: {}, speech_seconds: 0, segments: 0, model: 'm', prompt_version: 'p' } }),
    ).rejects.toThrow();
  });
});
