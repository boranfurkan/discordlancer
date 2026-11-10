// Pure: deposits. A quote can ask for part of the price before work starts and the rest
// on delivery; this works out what is due now from the quote and what has been paid.

import type { PaymentRequest } from '../db/payments.js';
import { formatUsdc } from './money.js';

export type Part = PaymentRequest['part'];

export interface Due {
  part: Part;
  amountMicro: number;
}

/** A cent of USDC, in micro-USDC: deposits are rounded to whole cents. */
const CENT = 10_000;

/** Pure: the deposit for a percentage of the price, in whole cents, always less than the price. */
export function depositFor(amountMicro: number, percent: number): number {
  if (!Number.isInteger(percent) || percent < 10 || percent > 90) throw new RangeError('The deposit is a whole percentage from 10 to 90.');
  const deposit = Math.round((amountMicro * percent) / 100 / CENT) * CENT;
  return Math.min(Math.max(deposit, CENT), amountMicro - CENT);
}

/** Pure: what the client pays next, or undefined when the price is paid in full. */
export function amountDue(quote: { amount_micro: number; deposit_micro?: number | undefined }, paidMicro: number): Due | undefined {
  if (paidMicro >= quote.amount_micro) return undefined;
  if (!quote.deposit_micro) return { part: 'full', amountMicro: quote.amount_micro - paidMicro };
  if (paidMicro === 0) return { part: 'deposit', amountMicro: quote.deposit_micro };
  return { part: 'balance', amountMicro: quote.amount_micro - paidMicro };
}

/** Pure: how the price is paid, in a line. */
export function paymentPlan(quote: { amount_micro: number; deposit_micro?: number | undefined }): string {
  if (!quote.deposit_micro) return `${formatUsdc(quote.amount_micro)} USDC, paid in full before work starts`;
  return `${formatUsdc(quote.amount_micro)} USDC: a ${formatUsdc(quote.deposit_micro)} USDC deposit before work starts, and the remaining ${formatUsdc(quote.amount_micro - quote.deposit_micro)} USDC on delivery`;
}

export const PART_LABEL: Record<Part, string> = { full: 'the payment', deposit: 'the deposit', balance: 'the remaining balance' };
