import { RecordId, type Surreal } from 'surrealdb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issueInvoice, latestInvoice } from '../src/db/issuedInvoices.js';
import { billedToLines } from '../src/discord/commands/invoice.js';
import { invoiceNumber, invoicePdf, money } from '../src/domain/invoice.js';
import { pdfDocument, textWidth, winAnsi, wrap } from '../src/domain/pdf.js';
import { memoryDb } from './helpers/db.js';

/** Checks the cross-reference table points at every object, as a PDF reader needs. */
function checkStructure(pdf: Buffer) {
  const text = pdf.toString('latin1');
  expect(text.startsWith('%PDF-1.4\n')).toBe(true);
  expect(text.endsWith('%%EOF\n')).toBe(true);
  const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)![1]);
  expect(text.slice(startxref, startxref + 4)).toBe('xref');
  const offsets = [...text.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((match) => Number(match[1]));
  expect(offsets).toHaveLength(7);
  offsets.forEach((offset, index) => expect(text.slice(offset, offset + `${index + 1} 0 obj`.length)).toBe(`${index + 1} 0 obj`));
  const length = Number(/<< \/Length (\d+) >>\nstream\n/.exec(text)![1]);
  const start = text.indexOf('stream\n') + 'stream\n'.length;
  expect(text.slice(start + length, start + length + '\nendstream'.length)).toBe('\nendstream');
  return text;
}

describe('PDF writer', () => {
  it('writes a valid one-page file, escaping text, with links only to https addresses', () => {
    const text = checkStructure(
      pdfDocument(
        [
          { kind: 'text', x: 10, y: 10, size: 12, text: 'Price (USDC): 1,950.00 \\ é' },
          { kind: 'link', x: 10, y: 10, w: 50, h: 12, url: 'https://explorer.solana.com/tx/abc' },
          { kind: 'link', x: 10, y: 10, w: 50, h: 12, url: 'javascript:alert(1)' },
        ],
        { title: 'Test (1)', created: new Date('2026-11-12T10:00:00Z') },
      ),
    );
    expect(text).toContain('(Price \\(USDC\\): 1,950.00 \\\\ \\351) Tj');
    expect(text).toContain('/URI (https://explorer.solana.com/tx/abc)');
    expect(text).not.toContain('javascript');
    expect(text).toContain('/Title (Test \\(1\\))');
  });

  it('keeps Latin letters, simplifies others, and measures text', () => {
    expect(winAnsi('é€Ç')).toEqual([0xe9, 0x80, 0xc7]);
    expect(String.fromCharCode(...winAnsi('Ayşe Yılmaz Ağaoğlu İzmir'))).toBe('Ayse Yilmaz Agaoglu Izmir');
    expect(winAnsi('🎉')).toEqual([63]);
    expect(textWidth('1,950.00', 10)).toBeCloseTo(5.56 * 6 + 2.78 * 2);
    expect(wrap('one two three four five', textWidth('one two three', 10), 10)).toEqual(['one two three', 'four five']);
  });
});

describe('invoices', () => {
  it('format amounts and numbers the usual way', () => {
    expect(money(1_950_000_000)).toBe('1,950.00');
    expect(money(10_000)).toBe('0.01');
    expect(money(1_000_000_000_000)).toBe('1,000,000.00');
    expect(invoiceNumber(2026, 7)).toBe('DL-2026-0007');
    expect(billedToLines(' Acme  Ltd | 1 High St, London ||')).toEqual(['Acme Ltd', '1 High St, London']);
  });

  it('put the number, amounts, billed-to and the transaction in the PDF', () => {
    const signature = '5h8K'.padEnd(88, 'x');
    const base = {
      number: 'DL-2026-0001',
      issuedAt: new Date('2026-11-12T15:30:00Z'),
      billedTo: ['Acme Ltd', '1 High St, London'],
      project: 'acme-app',
      specVersion: 2,
      quoteVersion: 1,
      deadline: new Date('2026-11-17T18:00:00Z'),
      amountMicro: 1_950_000_000,
      payments: [{ amountMicro: 1_950_000_000, at: new Date('2026-11-12T14:03:00Z'), from: 'From1', to: 'To1', signature, url: `https://explorer.solana.com/tx/${signature}` }],
    };
    const text = checkStructure(invoicePdf(base));
    for (const expected of ['(DL-2026-0001)', '(Acme Ltd)', '(Software development: acme-app)', '(1,950.00 USDC)', '(PAID)', `(${signature})`, '(0.00 USDC)']) expect(text).toContain(expected);
    const part = invoicePdf({ ...base, payments: [{ ...base.payments[0]!, amountMicro: 1_000_000_000 }], replaces: 'DL-2026-0000' }).toString('latin1');
    expect(part).toContain('(PART PAID)');
    expect(part).toContain('(950.00 USDC)');
    expect(part).toContain('(Replaces invoice DL-2026-0000)');
  });

  describe('records', () => {
    let db: Surreal;
    const alpha = { id: new RecordId('project', 'alpha') };
    const beta = { id: new RecordId('project', 'beta') };
    beforeAll(async () => {
      db = await memoryDb();
    });
    afterAll(async () => {
      await db.close();
    });
    const sample = { billedTo: ['Acme'], amountMicro: 5_000_000, quoteVersion: 1, specVersion: 1, payments: ['sig'] };
    const event = { actor: 'owner', action: 'invoice.issued', outcome: 'ok' } as const;

    it('number invoices in one sequence across projects, and never change them', async () => {
      const first = await issueInvoice(db, alpha, sample, event, new Date('2026-11-12T00:00:00Z'));
      const second = await issueInvoice(db, beta, sample, event, new Date('2026-11-12T00:00:00Z'));
      const third = await issueInvoice(db, alpha, { ...sample, replaces: first.number }, event, new Date('2026-11-13T00:00:00Z'));
      expect([first.number, second.number, third.number]).toEqual(['DL-2026-0001', 'DL-2026-0002', 'DL-2026-0003']);
      expect((await latestInvoice(db, alpha))?.replaces).toBe('DL-2026-0001');
      await expect(db.query('UPDATE $id SET billed_to = ["Someone else"]', { id: first.id })).rejects.toThrow(/append-only/);
      const [events] = await db.query<[Array<{ data: { number: string } }>]>('SELECT data FROM event WHERE action = "invoice.issued" ORDER BY at');
      expect(events.map((item) => item.data.number)).toEqual(['DL-2026-0001', 'DL-2026-0002', 'DL-2026-0003']);
    });
  });
});
