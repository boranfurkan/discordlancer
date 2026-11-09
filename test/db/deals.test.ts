import type { Surreal } from 'surrealdb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addAgreement, agreedParties, latestQuote, latestSpec, saveQuote, saveSpec } from '../../src/db/deals.js';
import { createProject, getProjectByName, moveStage, type Project } from '../../src/db/projects.js';
import { memoryDb } from '../helpers/db.js';

let db: Surreal;
const ev = (action: string) => ({ actor: 'owner', actorId: '3', action, outcome: 'ok' }) as const;
const spec = { markdown: '# Spec', changes: [], openQuestions: ['Which colours?'], messageCount: 4, model: 'm', promptVersion: 'specs-v1' };

async function fresh(name: string): Promise<Project> {
  await createProject(db, { name, channelId: `c-${name}`, repo: `o/${name}`, inviteCode: `i-${name}` }, ev('project.created'));
  const project = (await getProjectByName(db, name))!;
  await moveStage(db, project, 'created', 'joined', ev('project.client_joined'), { client_id: '9' });
  return (await getProjectByName(db, name))!;
}

beforeAll(async () => {
  db = await memoryDb();
});
afterAll(async () => {
  await db.close();
});

describe('specs', () => {
  it('numbers versions from 1 and returns the latest', async () => {
    const project = await fresh('specs-a');
    expect(await latestSpec(db, project)).toBeUndefined();
    expect(await saveSpec(db, project, spec, ev('spec.created'))).toBe(1);
    expect(await saveSpec(db, project, { ...spec, markdown: '# Spec 2' }, ev('spec.created'))).toBe(2);
    expect(await latestSpec(db, project)).toMatchObject({ version: 2, markdown: '# Spec 2', open_questions: ['Which colours?'] });
  });

  it('sends an agreed project back to joined when a new version is saved', async () => {
    const project = await fresh('specs-b');
    await saveSpec(db, project, spec, ev('spec.created'));
    await moveStage(db, project, 'joined', 'specs_agreed', ev('specs.agreed_by_both'));
    const agreed = (await getProjectByName(db, 'specs-b'))!;
    await saveSpec(db, agreed, spec, ev('spec.created'));
    expect((await getProjectByName(db, 'specs-b'))?.stage).toBe('joined');
  });
});

describe('agreements', () => {
  it('records each side once per version', async () => {
    const project = await fresh('agree-a');
    expect(await addAgreement(db, project, 'spec', 1, 'client', '9', ev('spec.agreed'))).toBe('recorded');
    expect(await addAgreement(db, project, 'spec', 1, 'client', '9', ev('spec.agreed'))).toBe('already');
    expect(await agreedParties(db, project, 'spec', 1)).toEqual(new Set(['client']));
    await addAgreement(db, project, 'spec', 1, 'owner', '3', ev('spec.agreed'));
    expect(await agreedParties(db, project, 'spec', 1)).toEqual(new Set(['client', 'owner']));
  });

  it('keeps versions apart: agreeing to v1 says nothing about v2', async () => {
    const project = await fresh('agree-b');
    await addAgreement(db, project, 'spec', 1, 'client', '9', ev('spec.agreed'));
    await addAgreement(db, project, 'spec', 1, 'owner', '3', ev('spec.agreed'));
    expect(await agreedParties(db, project, 'spec', 2)).toEqual(new Set());
    expect(await agreedParties(db, project, 'quote', 1)).toEqual(new Set());
  });
});

describe('quotes', () => {
  it("saves the quote with the owner's acceptance in one go", async () => {
    const project = await fresh('quote-a');
    await saveSpec(db, project, spec, ev('spec.created'));
    await moveStage(db, project, 'joined', 'specs_agreed', ev('specs.agreed_by_both'));
    const agreed = (await getProjectByName(db, 'quote-a'))!;
    const deadline = new Date('2026-11-17T18:00:00Z');
    const version = await saveQuote(db, agreed, { amountMicro: 250_000_000, deadline, specVersion: 1, terms: 't' }, '3', ev('quote.created'));
    expect(version).toBe(1);
    expect(await latestQuote(db, agreed)).toMatchObject({ version: 1, amount_micro: 250_000_000, spec_version: 1, deadline });
    expect(await agreedParties(db, agreed, 'quote', 1)).toEqual(new Set(['owner']));
  });

  it('sends an accepted project back to specs_agreed when a new quote replaces the old one', async () => {
    const project = (await getProjectByName(db, 'quote-a'))!;
    await addAgreement(db, project, 'quote', 1, 'client', '9', ev('quote.accepted'));
    await moveStage(db, project, 'specs_agreed', 'quote_accepted', ev('quote.accepted_by_both'));
    const accepted = (await getProjectByName(db, 'quote-a'))!;
    const version = await saveQuote(
      db,
      accepted,
      { amountMicro: 300_000_000, deadline: new Date('2026-11-17T18:00:00Z'), specVersion: 1, terms: 't' },
      '3',
      ev('quote.created'),
    );
    expect(version).toBe(2);
    expect((await getProjectByName(db, 'quote-a'))?.stage).toBe('specs_agreed');
    expect(await agreedParties(db, accepted, 'quote', 2)).toEqual(new Set(['owner']));
  });
});
