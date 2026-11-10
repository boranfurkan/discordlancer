// Invoices issued with /invoice (append-only). Numbers run in one sequence across all
// projects (DL-2026-0001, ...); the unique index makes two at once impossible.

import { RecordId, type Surreal } from 'surrealdb';
import { z } from 'zod';
import { invoiceNumber } from '../domain/invoice.js';
import type { EventInput } from './events.js';
import { eventContent, toDate, type Project } from './projects.js';

export const IssuedInvoiceRow = z.object({
  id: z.custom<RecordId<'issued_invoice'>>((value) => value instanceof RecordId),
  number: z.string(),
  sequence: z.number().int(),
  project: z.custom<RecordId<'project'>>((value) => value instanceof RecordId),
  billed_to: z.array(z.string()),
  amount_micro: z.number().int(),
  quote_version: z.number().int(),
  spec_version: z.number().int(),
  payments: z.array(z.string()),
  note: z.string().optional(),
  replaces: z.string().optional(),
  issued_at: toDate,
});
export type IssuedInvoice = z.infer<typeof IssuedInvoiceRow>;

export interface NewInvoice {
  billedTo: string[];
  amountMicro: number;
  quoteVersion: number;
  specVersion: number;
  payments: string[];
  note?: string | undefined;
  replaces?: string | undefined;
}

/** The project's latest invoice, if it has one. */
export async function latestInvoice(db: Surreal, project: Pick<Project, 'id'>): Promise<IssuedInvoice | undefined> {
  const [rows] = await db.query<[unknown[]]>('SELECT * FROM issued_invoice WHERE project = $p ORDER BY sequence DESC LIMIT 1', { p: project.id });
  return rows[0] === undefined ? undefined : IssuedInvoiceRow.parse(rows[0]);
}

/** Issues the next invoice number for this project, with its event, in one transaction. */
export async function issueInvoice(db: Surreal, project: Pick<Project, 'id'>, invoice: NewInvoice, event: Omit<EventInput, 'project'>, now = new Date()): Promise<IssuedInvoice> {
  for (let attempt = 1; ; attempt++) {
    // Not math::max: on an empty table SurrealDB 4 gives -Infinity.
    const [rows] = await db.query<[number[]]>('SELECT VALUE sequence FROM issued_invoice ORDER BY sequence DESC LIMIT 1');
    const sequence = (rows[0] ?? 0) + 1;
    const number = invoiceNumber(now.getUTCFullYear(), sequence);
    const content: Record<string, unknown> = {
      number,
      sequence,
      project: project.id,
      billed_to: invoice.billedTo,
      amount_micro: invoice.amountMicro,
      quote_version: invoice.quoteVersion,
      spec_version: invoice.specVersion,
      payments: invoice.payments,
    };
    if (invoice.note) content.note = invoice.note;
    if (invoice.replaces) content.replaces = invoice.replaces;
    try {
      await db.query(
        `BEGIN TRANSACTION;
         CREATE issued_invoice CONTENT $content RETURN NONE;
         CREATE event CONTENT $event RETURN NONE;
         COMMIT TRANSACTION;`,
        { content, event: eventContent({ ...event, data: { ...event.data, number } }, project.id) },
      );
      const [saved] = await db.query<[unknown[]]>('SELECT * FROM issued_invoice WHERE number = $number', { number });
      return IssuedInvoiceRow.parse(saved[0]);
    } catch (error) {
      // Someone else took this number at the same moment: take the next one.
      if (attempt < 3 && error instanceof Error && error.message.includes('already')) continue;
      throw error;
    }
  }
}
