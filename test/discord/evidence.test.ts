import { RecordId } from 'surrealdb';
import { describe, expect, it } from 'vitest';
import type { EventRecord } from '../../src/db/events.js';
import type { Payment } from '../../src/db/payments.js';
import type { Project } from '../../src/db/projects.js';
import { londonDayStart } from '../../src/domain/deadline.js';
import { canConfirm } from '../../src/discord/commands/delivery.js';
import { exportSummary, salesReport, touchLine, transcriptMarkdown } from '../../src/discord/evidence.js';

const project = (name: string) => new RecordId('project', name);

function payment(name: string, amountMicro: number, verifiedAt: string, signature = `sig-${name}`): Payment {
  return {
    id: new RecordId('payment', signature),
    project: project(name),
    signature,
    from_wallet: 'ClientWallet',
    to_wallet: 'BoranWallet',
    amount_micro: amountMicro,
    slot: 1,
    verified_at: new Date(verifiedAt),
  };
}

function event(action: string, name: string | undefined, data: Record<string, unknown> = {}, actor: EventRecord['actor'] = 'owner'): EventRecord {
  return { at: new Date('2026-11-10T10:00:00Z'), actor, action, outcome: 'ok', data, ...(name ? { project: project(name) } : {}) };
}

describe('londonDayStart', () => {
  it('is midnight London time, in winter and summer', () => {
    expect(londonDayStart(new Date('2026-11-10T15:00:00Z')).toISOString()).toBe('2026-11-10T00:00:00.000Z');
    expect(londonDayStart(new Date('2027-07-01T15:00:00Z')).toISOString()).toBe('2027-06-30T23:00:00.000Z');
    // 00:30 in London on 1 July is still 30 June in UTC.
    expect(londonDayStart(new Date('2027-06-30T23:30:00Z')).toISOString()).toBe('2027-06-30T23:00:00.000Z');
  });
});

describe('salesReport', () => {
  const since = new Date('2026-11-10T00:00:00Z');
  const now = new Date('2026-11-10T15:00:00Z');

  it("lists today's payments with transaction hashes, and the running total", () => {
    const text = salesReport(
      [payment('atmaca', 250_000_000, '2026-11-09T12:00:00Z', 'old'), payment('atmaca', 100_500_000, '2026-11-10T09:00:00Z', 'new')],
      since,
      'BoranWallet',
      now,
    );
    expect(text).toContain('Tuesday, 10 November 2026');
    expect(text).toContain('- atmaca: 100.50 USDC, transaction new (https://explorer.solana.com/tx/new)');
    expect(text).not.toContain('transaction old');
    expect(text).toContain('Running total: 350.50 USDC from 2 payment(s).');
  });

  it('says so when there were no sales today, and leaves test projects out', () => {
    const text = salesReport([payment('dl-test-gamma', 10_000, '2026-11-10T09:00:00Z')], since, 'BoranWallet', now);
    expect(text).toContain('No sales today.');
    expect(text).toContain('Running total: 0.00 USDC from 0 payment(s).');
    expect(text).not.toContain('Proof:');
  });
});

describe('touchLine', () => {
  it("summarises the owner's own actions once each, leaving out tests, clients and command noise", () => {
    const line = touchLine([
      event('project.created', 'atmaca'),
      event('spec.created', 'atmaca', { version: 1 }),
      event('spec.created', 'atmaca', { version: 1 }),
      event('command.help', undefined),
      event('quote.created', 'atmaca', { version: 2 }),
      event('spec.agreed', 'atmaca', { version: 1 }, 'client'),
      event('project.created', 'dl-test-gamma'),
    ]);
    expect(line).toBe('Discordlancer: set up atmaca; wrote specs v1 for atmaca with Gemini; posted quote v2 for atmaca.');
  });

  it('says when there is nothing to report', () => {
    expect(touchLine([event('project.created', 'dl-test-a')])).toMatch(/No owner actions/);
  });
});

describe('canConfirm', () => {
  const base = { stage: 'in_development' as const, client_id: 'client', delivery_marked_at: new Date() };

  it('lets the client confirm once Boran has marked the delivery', () => {
    expect(canConfirm(base, 'client')).toBeUndefined();
  });

  it('refuses anyone else, an unmarked delivery and the wrong stage', () => {
    expect(canConfirm(base, 'boran')).toMatch(/Only the client/);
    expect(canConfirm({ ...base, delivery_marked_at: undefined }, 'client')).toMatch(/hasn't marked it/);
    expect(canConfirm({ ...base, stage: 'delivered' }, 'client')).toMatch(/isn't waiting/);
  });
});

describe('export', () => {
  const p: Project = {
    id: project('atmaca'),
    name: 'atmaca',
    channel_id: 'c',
    repo: 'owner/atmaca',
    client_id: '9',
    client_wallet: 'ClientWallet',
    stage: 'paid',
    created_at: new Date('2026-11-09T10:00:00Z'),
    updated_at: new Date('2026-11-09T10:00:00Z'),
  };

  it('summarises the project, money and history in one readable file', () => {
    const text = exportSummary({
      project: p,
      specs: [],
      quotes: [],
      agreements: [],
      payments: [payment('atmaca', 250_000_000, '2026-11-10T09:00:00Z', 'sigX')],
      events: [event('project.created', 'atmaca')],
      generatedAt: new Date('2026-11-10T12:00:00Z'),
    });
    expect(text).toContain('# Evidence pack: atmaca');
    expect(text).toContain('- Stage: Paid (`paid`)');
    expect(text).toContain("- Client's declared wallet: ClientWallet");
    expect(text).toContain('250.00 USDC from ClientWallet to BoranWallet');
    expect(text).toContain('https://explorer.solana.com/tx/sigX');
    expect(text).toContain('## Event log (1 events)');
  });

  it('writes the transcript oldest first, marking the bot and attachments', () => {
    const text = transcriptMarkdown('atmaca', [
      { at: new Date('2026-11-09T10:00:00Z'), author: 'Alice', bot: false, text: 'Hi', attachments: ['https://cdn/x.png'] },
      { at: new Date('2026-11-09T10:01:00Z'), author: 'Freelance Manager Bot', bot: true, text: 'Welcome', attachments: [] },
    ]);
    expect(text).toContain('**2026-11-09T10:00:00Z Alice:** Hi\n  - attachment: https://cdn/x.png');
    expect(text).toContain('**2026-11-09T10:01:00Z Freelance Manager Bot (bot):** Welcome');
  });
});
