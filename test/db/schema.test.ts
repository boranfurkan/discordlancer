import { RecordId, type Surreal } from 'surrealdb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySchema } from '../../src/db/migrate.js';
import { recordEvent } from '../../src/db/events.js';
import { STAGES } from '../../src/domain/stages.js';
import { memoryDb } from '../helpers/db.js';

let db: Surreal;
const demo = new RecordId('project', 'demo');

beforeAll(async () => {
  db = await memoryDb();
  await db.query('CREATE $id CONTENT $content', {
    id: demo,
    content: { name: 'demo', channel_id: 'c-demo', repo: 'owner/demo', stage: 'created' },
  });
});

afterAll(async () => {
  await db.close();
});

/** The first result row of a single-statement query. */
async function one<T>(sql: string, vars?: Record<string, unknown>): Promise<T> {
  const [rows] = await db.query<[T[]]>(sql, vars);
  return rows[0] as T;
}

describe('schema', () => {
  it('can be applied again without errors', async () => {
    await expect(applySchema(db)).resolves.toBeUndefined();
  });

  it('accepts every stage the code knows and refuses others', async () => {
    for (const [index, stage] of STAGES.entries()) {
      await db.query('CREATE project CONTENT $content', {
        content: { name: `stage-${index}`, channel_id: `c-stage-${index}`, repo: 'owner/x', stage },
      });
    }
    await expect(
      db.query('CREATE project CONTENT $content', {
        content: { name: 'bad-stage', channel_id: 'c-bad', repo: 'owner/x', stage: 'shipped' },
      }),
    ).rejects.toThrow();
  });

  it('refuses a project name Discord or GitHub would not accept', async () => {
    await expect(
      db.query('CREATE project CONTENT $content', {
        content: { name: 'Bad Name', channel_id: 'c-badname', repo: 'owner/x', stage: 'created' },
      }),
    ).rejects.toThrow();
  });

  it('keeps project names and channels unique', async () => {
    await expect(
      db.query('CREATE project CONTENT $content', {
        content: { name: 'demo', channel_id: 'c-other', repo: 'owner/x', stage: 'created' },
      }),
    ).rejects.toThrow(/already/);
    await expect(
      db.query('CREATE project CONTENT $content', {
        content: { name: 'other', channel_id: 'c-demo', repo: 'owner/x', stage: 'created' },
      }),
    ).rejects.toThrow(/already/);
  });

  it('lets a project change, keeping its creation time', async () => {
    const before = await one<{ created_at: unknown }>('SELECT created_at FROM $id', { id: demo });
    await db.query('UPDATE $id SET stage = "joined"', { id: demo });
    const after = await one<{ created_at: unknown; stage: string }>('SELECT created_at, stage FROM $id', { id: demo });
    expect(after.stage).toBe('joined');
    expect(JSON.stringify(after.created_at)).toBe(JSON.stringify(before.created_at));
  });
});

describe('the event log', () => {
  it('records an event, and the database sets the time', async () => {
    await recordEvent(db, { actor: 'owner', actorId: '1', action: 'test.created', outcome: 'ok', project: demo, data: { n: 1 } });
    const event = await one<{ action: string; at: unknown; data: { n: number } }>(
      'SELECT action, at, data FROM event WHERE action = "test.created"',
    );
    expect(event.action).toBe('test.created');
    expect(event.data).toEqual({ n: 1 });
    expect(event.at).toBeTruthy();
  });

  it('ignores a backdated time', async () => {
    await db.query('CREATE event:backdated CONTENT $content', {
      content: { actor: 'bot', action: 'test.backdated', outcome: 'ok', at: new Date('2020-01-01T00:00:00Z') },
    });
    const event = await one<{ at: unknown }>('SELECT at FROM event:backdated');
    expect(JSON.stringify(event.at)).not.toContain('2020-01-01');
  });

  it('refuses an unknown actor or outcome', async () => {
    await expect(recordEvent(db, { actor: 'stranger' as never, action: 'x', outcome: 'ok' })).rejects.toThrow();
    await expect(recordEvent(db, { actor: 'bot', action: 'x', outcome: 'maybe' as never })).rejects.toThrow();
  });

  it.each([
    ['UPDATE', 'UPDATE event:backdated SET action = "changed"'],
    ['UPSERT', 'UPSERT event:backdated SET action = "changed"'],
    ['DELETE', 'DELETE event:backdated'],
    ['DELETE all', 'DELETE event'],
  ])('refuses %s and leaves the record unchanged', async (_label, sql) => {
    await expect(db.query(sql)).rejects.toThrow(/append-only/);
    const event = await one<{ action: string }>('SELECT action FROM event:backdated');
    expect(event.action).toBe('test.backdated');
  });
});

describe('other history tables are append-only too', () => {
  // Each case changes a real field to a new value. Setting a field to the value it
  // already has changes nothing, so SurrealDB doesn't fire the event at all.
  it.each([
    ['spec', 'markdown', '# Spec', { project: demo, version: 1, markdown: '# Spec', changes: [], open_questions: [], message_count: 3, model: 'm', prompt_version: 'p1' }],
    ['quote', 'terms', 't', { project: demo, version: 1, amount_micro: 250_000_000, deadline: new Date('2026-11-17T18:00:00Z'), spec_version: 1, terms: 't' }],
    ['agreement', 'user_id', '4', { project: demo, kind: 'spec', version: 1, party: 'client', user_id: '4' }],
    ['payment', 'from_wallet', 'a', { project: demo, signature: 'sig-1', from_wallet: 'a', to_wallet: 'b', amount_micro: 1, slot: 1 }],
  ])('%s refuses changes to %s and deletion', async (table, field, original, content) => {
    const id = new RecordId(table, 'one');
    await db.query('CREATE $id CONTENT $content', { id, content });
    await expect(db.query(`UPDATE $id SET ${field} = "changed"`, { id })).rejects.toThrow(/append-only/);
    await expect(db.query('DELETE $id', { id })).rejects.toThrow(/append-only/);
    const row = await one<Record<string, unknown>>(`SELECT ${field} FROM $id`, { id });
    expect(row[field]).toBe(original);
  });

  it('allows only one payment per signature', async () => {
    await expect(
      db.query('CREATE payment CONTENT $content', {
        content: { project: demo, signature: 'sig-1', from_wallet: 'a', to_wallet: 'b', amount_micro: 1, slot: 2 },
      }),
    ).rejects.toThrow(/already/);
  });

  it('allows one agreement per party, kind and version', async () => {
    await expect(
      db.query('CREATE agreement CONTENT $content', {
        content: { project: demo, kind: 'spec', version: 1, party: 'client', user_id: '4' },
      }),
    ).rejects.toThrow(/already/);
    await expect(
      db.query('CREATE agreement CONTENT $content', {
        content: { project: demo, kind: 'spec', version: 1, party: 'owner', user_id: '3' },
      }),
    ).resolves.toBeDefined();
  });

  it('refuses a zero or negative amount', async () => {
    await expect(
      db.query('CREATE quote CONTENT $content', {
        content: { project: demo, version: 2, amount_micro: 0, deadline: new Date(), spec_version: 1, terms: 't' },
      }),
    ).rejects.toThrow();
  });
});

describe('project dev key hash', () => {
  it('is optional, and a string when set', async () => {
    await db.query('CREATE project CONTENT $content', {
      content: { name: 'keyed', channel_id: 'c-keyed', repo: 'owner/keyed', stage: 'paid', dev_key_hash: 'a'.repeat(64) },
    });
    const hash = await one<string>('SELECT VALUE dev_key_hash FROM project WHERE name = "keyed"');
    expect(hash).toBe('a'.repeat(64));
    expect(await one<unknown>('SELECT VALUE dev_key_hash FROM $id', { id: demo })).toBeUndefined();
    await expect(
      db.query('CREATE project CONTENT $content', {
        content: { name: 'badkey', channel_id: 'c-badkey', repo: 'owner/x', stage: 'paid', dev_key_hash: 42 },
      }),
    ).rejects.toThrow();
  });
});
