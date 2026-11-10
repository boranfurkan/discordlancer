import { RecordId, type Surreal } from 'surrealdb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { latestQuote, saveQuote } from '../src/db/deals.js';
import { createRequest, openRequest, paymentsFor, recordPayment } from '../src/db/payments.js';
import { getProjectByName, type Project } from '../src/db/projects.js';
import { canConfirm } from '../src/discord/commands/delivery.js';
import { quoteTerms } from '../src/discord/texts.js';
import { amountDue, depositFor, paymentPlan } from '../src/domain/deposit.js';
import { memoryDb } from './helpers/db.js';

const USDC = 1_000_000;

describe('deposits', () => {
  it('works out the deposit in whole cents, always less than the price', () => {
    expect(depositFor(1_500 * USDC, 50)).toBe(750 * USDC);
    expect(depositFor(999_990_000, 33)).toBe(330_000_000); // 329.9967 USDC, rounded to the cent
    expect(depositFor(20_000, 90)).toBe(10_000);
    expect(() => depositFor(100 * USDC, 5)).toThrow(RangeError);
    expect(() => depositFor(100 * USDC, 95)).toThrow(RangeError);
  });

  it('asks for the deposit first, then the balance, then nothing', () => {
    const quote = { amount_micro: 1_500 * USDC, deposit_micro: 500 * USDC };
    expect(amountDue(quote, 0)).toEqual({ part: 'deposit', amountMicro: 500 * USDC });
    expect(amountDue(quote, 500 * USDC)).toEqual({ part: 'balance', amountMicro: 1_000 * USDC });
    expect(amountDue(quote, 1_500 * USDC)).toBeUndefined();
    // Paying more than the deposit at once leaves only the rest.
    expect(amountDue(quote, 1_200 * USDC)).toEqual({ part: 'balance', amountMicro: 300 * USDC });
  });

  it('asks for the whole price when there is no deposit', () => {
    expect(amountDue({ amount_micro: 250 * USDC }, 0)).toEqual({ part: 'full', amountMicro: 250 * USDC });
    expect(amountDue({ amount_micro: 250 * USDC }, 250 * USDC)).toBeUndefined();
  });

  it('says how the price is paid, in the terms too', () => {
    expect(paymentPlan({ amount_micro: 1_500 * USDC, deposit_micro: 750 * USDC })).toBe('1500.00 USDC: a 750.00 USDC deposit before work starts, and the remaining 750.00 USDC on delivery');
    const terms = quoteTerms(1, '1500.00', 'Mon 16 Nov', { deposit: '750.00', balance: '750.00' });
    expect(terms[1]).toContain('a 750.00 USDC deposit before work starts, and the remaining 750.00 USDC when the work is delivered, before you confirm the delivery');
    expect(terms[3]).toBe('Ownership: the code is yours once the full price is paid.');
  });

  it('keeps the delivery unconfirmed until the balance is paid', () => {
    const project = { stage: 'in_development' as const, client_id: 'c', client_ids: [], delivery_marked_at: new Date() };
    expect(canConfirm(project, 'c', 750 * USDC)).toMatch(/remaining 750\.00 USDC is due before the delivery is confirmed/);
    expect(canConfirm(project, 'c', 0)).toBeUndefined();
  });
});

let db: Surreal;
let project: Project;
beforeAll(async () => {
  db = await memoryDb();
  await db.query('CREATE $id CONTENT $content', { id: new RecordId('project', 'shop'), content: { name: 'shop', channel_id: 'c', repo: 'me/shop', stage: 'quote_accepted' } });
  project = (await getProjectByName(db, 'shop'))!;
});
afterAll(async () => {
  await db.close();
});

describe('deposits in the database', () => {
  const event = { actor: 'bot' as const, action: 'test', outcome: 'ok' as const };

  it('refuses a deposit that is not less than the price', async () => {
    await expect(saveQuote(db, project, { amountMicro: 100 * USDC, deadline: new Date(), specVersion: 1, terms: 't', depositMicro: 100 * USDC }, 'owner', event)).rejects.toThrow();
  });

  it('pays a deposit (work starts), then the balance on its own request', async () => {
    await saveQuote(db, project, { amountMicro: 1_000 * USDC, deadline: new Date(), specVersion: 1, terms: 't', depositMicro: 400 * USDC }, 'owner', event);
    const quote = (await latestQuote(db, project))!;
    expect(quote.deposit_micro).toBe(400 * USDC);
    await db.query('UPDATE $p SET stage = "quote_accepted"', { p: project.id });

    const deposit = await createRequest(db, project, { quoteVersion: quote.version, amountMicro: 400 * USDC, reference: 'ref-deposit', part: 'deposit' }, event);
    expect(deposit.part).toBe('deposit');
    expect(await openRequest(db, project, quote.version, 'deposit')).toMatchObject({ reference: 'ref-deposit' });
    expect(await openRequest(db, project, quote.version)).toBeUndefined();

    const payment = { fromWallet: 'client', toWallet: 'me', slot: 1, blockTime: undefined };
    expect(await recordPayment(db, project, deposit, { ...payment, signature: 'sig-deposit', amountMicro: 400 * USDC }, event)).toBe('recorded');
    expect((await getProjectByName(db, 'shop'))!.stage).toBe('paid');

    const paid = (await paymentsFor(db, project)).reduce((sum, item) => sum + item.amount_micro, 0);
    expect(amountDue(quote, paid)).toEqual({ part: 'balance', amountMicro: 600 * USDC });
    await db.query('UPDATE $p SET stage = "in_development"', { p: project.id });
    const balance = await createRequest(db, project, { quoteVersion: quote.version, amountMicro: 600 * USDC, reference: 'ref-balance', part: 'balance' }, event);
    expect(await recordPayment(db, project, balance, { ...payment, signature: 'sig-balance', amountMicro: 600 * USDC }, event)).toBe('recorded');
    // The balance doesn't move the stage back: work carries on.
    expect((await getProjectByName(db, 'shop'))!.stage).toBe('in_development');
    expect(amountDue(quote, 1_000 * USDC)).toBeUndefined();
  });

  it('reads older requests, which have no part, as the whole price', async () => {
    await db.query("CREATE payment_request CONTENT { project: $p, quote_version: 9, amount_micro: 5, reference: 'old', status: 'open' }", { p: project.id });
    expect(await openRequest(db, project, 9)).toMatchObject({ reference: 'old', part: 'full' });
  });
});
