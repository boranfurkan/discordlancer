// Payment requests and payments. A payment is recorded once: its signature is unique,
// and the request, the payment, the stage change and the event are written in one
// transaction.

import { RecordId, type Surreal } from 'surrealdb';
import { z } from 'zod';
import type { EventInput } from './events.js';
import { eventContent, toDate, type Project } from './projects.js';

const recordId = <T extends string>() => z.custom<RecordId<T>>((value) => value instanceof RecordId);

export const PaymentRequestRow = z.object({
  id: recordId<'payment_request'>(),
  project: recordId<'project'>(),
  quote_version: z.number().int(),
  amount_micro: z.number().int(),
  reference: z.string(),
  /** The whole price, a deposit, or the balance after one. Older requests have none: the whole price. */
  part: z.enum(['full', 'deposit', 'balance']).optional().transform((value) => value ?? 'full'),
  status: z.enum(['open', 'paid', 'expired']),
  created_at: toDate,
});
export type PaymentRequest = z.infer<typeof PaymentRequestRow>;

export const PaymentRow = z.object({
  id: recordId<'payment'>(),
  project: recordId<'project'>(),
  request: recordId<'payment_request'>().optional(),
  signature: z.string(),
  from_wallet: z.string(),
  to_wallet: z.string(),
  amount_micro: z.number().int(),
  slot: z.number().int(),
  block_time: toDate.optional(),
  verified_at: toDate,
});
export type Payment = z.infer<typeof PaymentRow>;

type ProjectRef = Pick<Project, 'id'>;

/** The open request for this quote version and part (the whole price unless a part is given). */
export async function openRequest(db: Surreal, project: ProjectRef, quoteVersion: number, part: PaymentRequest['part'] = 'full'): Promise<PaymentRequest | undefined> {
  const [rows] = await db.query<[unknown[]]>(
    'SELECT * FROM payment_request WHERE project = $p AND quote_version = $v AND status = "open" ORDER BY created_at DESC',
    { p: project.id, v: quoteVersion },
  );
  return rows.map((row) => PaymentRequestRow.parse(row)).find((request) => request.part === part);
}

export async function listOpenRequests(db: Surreal): Promise<PaymentRequest[]> {
  const [rows] = await db.query<[unknown[]]>('SELECT * FROM payment_request WHERE status = "open" ORDER BY created_at');
  return rows.map((row) => PaymentRequestRow.parse(row));
}

/**
 * Opens a request for this quote version. Older open requests for other quote
 * versions are expired in the same transaction, so a superseded amount can't be paid.
 */
export async function createRequest(
  db: Surreal,
  project: ProjectRef,
  request: { quoteVersion: number; amountMicro: number; reference: string; part?: PaymentRequest['part'] },
  event: Omit<EventInput, 'project'>,
): Promise<PaymentRequest> {
  const id = new RecordId('payment_request', request.reference);
  await db.query(
    `BEGIN TRANSACTION;
     UPDATE payment_request SET status = "expired" WHERE project = $p AND status = "open" AND (quote_version != $v OR (part ?? "full") != $part) RETURN NONE;
     CREATE ONLY $id CONTENT $content RETURN NONE;
     CREATE event CONTENT $event RETURN NONE;
     COMMIT TRANSACTION;`,
    {
      p: project.id,
      v: request.quoteVersion,
      part: request.part ?? 'full',
      id,
      content: {
        project: project.id,
        quote_version: request.quoteVersion,
        amount_micro: request.amountMicro,
        reference: request.reference,
        ...(request.part && request.part !== 'full' ? { part: request.part } : {}),
        status: 'open',
      },
      event: eventContent({ ...event, data: { ...event.data, quote_version: request.quoteVersion, reference: request.reference, ...(request.part && request.part !== 'full' ? { part: request.part } : {}) } }, project.id),
    },
  );
  const [rows] = await db.query<[unknown[]]>('SELECT * FROM $id', { id });
  return PaymentRequestRow.parse(rows[0]);
}

export interface NewPayment {
  signature: string;
  fromWallet: string;
  toWallet: string;
  amountMicro: number;
  slot: number;
  blockTime: Date | undefined;
}

export type RecordResult = 'recorded' | 'duplicate' | 'request_closed';

/**
 * Records a verified payment once. Marks its request paid (if any) and moves the
 * project from quote_accepted to paid, all in one transaction.
 */
export async function recordPayment(
  db: Surreal,
  project: ProjectRef,
  request: Pick<PaymentRequest, 'id'> | undefined,
  payment: NewPayment,
  event: Omit<EventInput, 'project'>,
): Promise<RecordResult> {
  const content: Record<string, unknown> = {
    project: project.id,
    signature: payment.signature,
    from_wallet: payment.fromWallet,
    to_wallet: payment.toWallet,
    amount_micro: payment.amountMicro,
    slot: payment.slot,
  };
  if (request) content.request = request.id;
  if (payment.blockTime) content.block_time = payment.blockTime;

  try {
    await db.query(
      `BEGIN TRANSACTION;
       IF $request != NONE AND (SELECT VALUE status FROM ONLY $request) != "open" { THROW "request_closed" };
       CREATE payment CONTENT $payment RETURN NONE;
       IF $request != NONE { UPDATE $request SET status = "paid" RETURN NONE };
       UPDATE $p SET stage = "paid" WHERE stage = "quote_accepted" RETURN NONE;
       CREATE event CONTENT $event RETURN NONE;
       COMMIT TRANSACTION;`,
      {
        p: project.id,
        request: request?.id,
        payment: content,
        event: eventContent(
          {
            ...event,
            data: { ...event.data, signature: payment.signature, amount_micro: payment.amountMicro, from: payment.fromWallet },
          },
          project.id,
        ),
      },
    );
    return 'recorded';
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('request_closed')) return 'request_closed';
    if (/already/i.test(message)) return 'duplicate';
    throw error;
  }
}

export async function paymentsFor(db: Surreal, project: ProjectRef): Promise<Payment[]> {
  const [rows] = await db.query<[unknown[]]>('SELECT * FROM payment WHERE project = $p ORDER BY verified_at', { p: project.id });
  return rows.map((row) => PaymentRow.parse(row));
}

export async function paymentBySignature(db: Surreal, signature: string): Promise<Payment | undefined> {
  const [rows] = await db.query<[unknown[]]>('SELECT * FROM payment WHERE signature = $s LIMIT 1', { s: signature });
  return rows[0] === undefined ? undefined : PaymentRow.parse(rows[0]);
}

export async function allPayments(db: Surreal): Promise<Payment[]> {
  const [rows] = await db.query<[unknown[]]>('SELECT * FROM payment ORDER BY verified_at');
  return rows.map((row) => PaymentRow.parse(row));
}
