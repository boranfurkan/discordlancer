import type { Surreal } from 'surrealdb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createRequest,
  listOpenRequests,
  openRequest,
  paymentBySignature,
  paymentsFor,
  recordPayment,
} from '../../src/db/payments.js';
import { createProject, getProjectByName, moveStage, type Project } from '../../src/db/projects.js';
import { memoryDb } from '../helpers/db.js';

let db: Surreal;
const ev = (action: string) => ({ actor: 'bot', action, outcome: 'ok' }) as const;
const payment = (signature: string, amountMicro = 250_000_000) => ({
  signature,
  fromWallet: 'Client1111',
  toWallet: 'Boran1111',
  amountMicro,
  slot: 1,
  blockTime: new Date('2026-11-10T10:00:00Z'),
});

/** A project at quote_accepted, reached through the normal stage path. */
async function accepted(name: string): Promise<Project> {
  await createProject(db, { name, channelId: `c-${name}`, repo: `o/${name}`, inviteCode: `i-${name}` }, ev('project.created'));
  let project = (await getProjectByName(db, name))!;
  for (const [from, to] of [
    ['created', 'joined'],
    ['joined', 'specs_agreed'],
    ['specs_agreed', 'quote_accepted'],
  ] as const) {
    await moveStage(db, project, from, to, ev('test.move'));
    project = (await getProjectByName(db, name))!;
  }
  return project;
}

beforeAll(async () => {
  db = await memoryDb();
});
afterAll(async () => {
  await db.close();
});

describe('payment requests', () => {
  it('opens a request and finds it again', async () => {
    const project = await accepted('pay-a');
    const request = await createRequest(db, project, { quoteVersion: 1, amountMicro: 250_000_000, reference: 'refA1' }, ev('payment.requested'));
    expect(request).toMatchObject({ status: 'open', amount_micro: 250_000_000, reference: 'refA1', quote_version: 1 });
    expect((await openRequest(db, project, 1))?.reference).toBe('refA1');
    expect((await listOpenRequests(db)).map((r) => r.reference)).toContain('refA1');
  });

  it('expires open requests for an older quote when a new one is opened', async () => {
    const project = (await getProjectByName(db, 'pay-a'))!;
    await createRequest(db, project, { quoteVersion: 2, amountMicro: 300_000_000, reference: 'refA2' }, ev('payment.requested'));
    expect(await openRequest(db, project, 1)).toBeUndefined();
    expect((await openRequest(db, project, 2))?.reference).toBe('refA2');
  });

  it('refuses a second request with the same reference', async () => {
    const project = (await getProjectByName(db, 'pay-a'))!;
    await expect(
      createRequest(db, project, { quoteVersion: 2, amountMicro: 1, reference: 'refA2' }, ev('payment.requested')),
    ).rejects.toThrow();
  });
});

describe('recordPayment', () => {
  it('records the payment, closes the request and marks the project paid, together', async () => {
    const project = await accepted('pay-b');
    const request = await createRequest(db, project, { quoteVersion: 1, amountMicro: 250_000_000, reference: 'refB' }, ev('payment.requested'));
    expect(await recordPayment(db, project, request, payment('sigB'), ev('payment.verified'))).toBe('recorded');
    expect((await getProjectByName(db, 'pay-b'))?.stage).toBe('paid');
    expect(await openRequest(db, project, 1)).toBeUndefined();
    expect(await paymentBySignature(db, 'sigB')).toMatchObject({ amount_micro: 250_000_000, from_wallet: 'Client1111' });
  });

  it('records each signature only once', async () => {
    const project = (await getProjectByName(db, 'pay-b'))!;
    expect(await recordPayment(db, project, undefined, payment('sigB'), ev('payment.verified'))).toBe('duplicate');
    expect(await paymentsFor(db, project)).toHaveLength(1);
  });

  it('refuses to pay a request that is no longer open, and records nothing', async () => {
    const project = await accepted('pay-c');
    const old = await createRequest(db, project, { quoteVersion: 1, amountMicro: 1, reference: 'refC1' }, ev('payment.requested'));
    await createRequest(db, project, { quoteVersion: 2, amountMicro: 2, reference: 'refC2' }, ev('payment.requested'));
    expect(await recordPayment(db, project, old, payment('sigC'), ev('payment.verified'))).toBe('request_closed');
    expect(await paymentBySignature(db, 'sigC')).toBeUndefined();
    expect((await getProjectByName(db, 'pay-c'))?.stage).toBe('quote_accepted');
  });

  it('records a payment without a request (a manual send checked with /paid)', async () => {
    const project = await accepted('pay-d');
    expect(await recordPayment(db, project, undefined, payment('sigD'), ev('payment.verified'))).toBe('recorded');
    expect((await getProjectByName(db, 'pay-d'))?.stage).toBe('paid');
  });

  it('keeps payments append-only', async () => {
    await expect(db.query('UPDATE payment SET amount_micro = 1 WHERE signature = "sigD"')).rejects.toThrow(/append-only/);
  });
});
