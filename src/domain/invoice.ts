// Pure: the invoice for a paid project, laid out as a one-page PDF. Everything on it
// comes from the project's records; only "billed to" and the note are typed by Boran.

import { formatDeadline } from './deadline.js';
import { formatUsdc } from './money.js';
import { A4, pdfDocument, textWidth, wrap, type Color, type PdfOp } from './pdf.js';

export const SELLER = ['Furkan Boran', 'Freelance software developer'];

export interface InvoicePayment {
  amountMicro: number;
  at: Date;
  from: string;
  to: string;
  signature: string;
  url: string;
}

export interface InvoiceData {
  number: string;
  issuedAt: Date;
  replaces?: string | undefined;
  billedTo: readonly string[];
  project: string;
  specVersion: number;
  quoteVersion: number;
  quoteAcceptedAt?: Date | undefined;
  deadline: Date;
  amountMicro: number;
  payments: readonly InvoicePayment[];
  note?: string | undefined;
}

export function invoiceNumber(year: number, sequence: number): string {
  return `DL-${year}-${String(sequence).padStart(4, '0')}`;
}

/** 1500000000 micro-USDC → "1,500.00". */
export function money(micro: number): string {
  const [whole, fraction] = formatUsdc(micro).split('.');
  return `${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`;
}

const INK: Color = [0.12, 0.13, 0.16];
const MUTED: Color = [0.42, 0.45, 0.5];
const ACCENT: Color = [0.345, 0.396, 0.949];
const GREEN: Color = [0.13, 0.6, 0.33];
const FILL: Color = [0.95, 0.96, 0.98];
const RULE: Color = [0.85, 0.87, 0.9];
const WHITE: Color = [1, 1, 1];

const LEFT = 56;
const RIGHT = A4.width - 56;

const longDate = (date: Date) => new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: 'Europe/London' }).format(date);
const stamp = (date: Date) => `${new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date)} UTC`;

/** Pure: the drawing for one invoice. */
export function invoiceOps(data: InvoiceData): PdfOp[] {
  const ops: PdfOp[] = [];
  const text = (x: number, y: number, value: string, size: number, options: { bold?: boolean; color?: Color } = {}) =>
    ops.push({ kind: 'text', x, y, size, text: value, bold: options.bold, color: options.color ?? INK });
  const right = (x: number, y: number, value: string, size: number, options: { bold?: boolean; color?: Color } = {}) =>
    text(x - textWidth(value, size, options.bold), y, value, size, options);
  const label = (x: number, y: number, value: string) => text(x, y, value.toUpperCase(), 8, { bold: true, color: MUTED });
  const rule = (y: number, from = LEFT, to = RIGHT) => ops.push({ kind: 'line', x1: from, y1: y, x2: to, y2: y, width: 0.6, color: RULE });

  const paid = data.payments.reduce((sum, payment) => sum + payment.amountMicro, 0);
  const due = Math.max(0, data.amountMicro - paid);

  // Header.
  ops.push({ kind: 'rect', x: 0, y: A4.height - 14, w: A4.width, h: 14, color: ACCENT });
  text(LEFT, 772, 'Invoice', 30, { bold: true });
  if (data.replaces) text(LEFT, 752, `Replaces invoice ${data.replaces}`, 9, { color: MUTED });
  right(RIGHT, 782, 'INVOICE NUMBER', 8, { bold: true, color: MUTED });
  right(RIGHT, 768, data.number, 12, { bold: true });
  right(RIGHT, 748, 'ISSUE DATE', 8, { bold: true, color: MUTED });
  right(RIGHT, 734, longDate(data.issuedAt), 11);
  const badge = due === 0 ? 'PAID' : 'PART PAID';
  const badgeWidth = textWidth(badge, 10, true) + 20;
  ops.push({ kind: 'rect', x: RIGHT - badgeWidth, y: 704, w: badgeWidth, h: 20, color: due === 0 ? GREEN : ACCENT });
  text(RIGHT - badgeWidth + 10, 710.5, badge, 10, { bold: true, color: WHITE });

  // From and billed to.
  let y = 668;
  label(LEFT, y, 'From');
  label(310, y, 'Billed to');
  SELLER.forEach((line, index) => text(LEFT, y - 18 - index * 15, line, index === 0 ? 11.5 : 10, { bold: index === 0, color: index === 0 ? INK : MUTED }));
  text(LEFT, y - 18 - SELLER.length * 15, 'Paid in USDC on Solana to:', 9, { color: MUTED });
  text(LEFT, y - 32 - SELLER.length * 15, data.payments[0]?.to ?? '', 8.5);
  const billed = data.billedTo.flatMap((line) => wrap(line, RIGHT - 310, 10.5));
  billed.forEach((line, index) => text(310, y - 18 - index * 15, line, index === 0 ? 11.5 : 10, { bold: index === 0, color: index === 0 ? INK : MUTED }));
  y -= Math.max(60 + SELLER.length * 15, 36 + billed.length * 15);

  // The line item.
  ops.push({ kind: 'rect', x: LEFT, y: y - 8, w: RIGHT - LEFT, h: 24, color: FILL });
  label(LEFT + 10, y, 'Description');
  right(RIGHT - 10, y, 'AMOUNT (USDC)', 8, { bold: true, color: MUTED });
  y -= 32;
  text(LEFT + 10, y, `Software development: ${data.project}`, 11.5, { bold: true });
  right(RIGHT - 10, y, money(data.amountMicro), 11.5, { bold: true });
  const details = [
    `As agreed in spec v${data.specVersion} and quote v${data.quoteVersion}${data.quoteAcceptedAt ? `, accepted on ${longDate(data.quoteAcceptedAt)}` : ''}.`,
    `Delivery by ${formatDeadline(data.deadline)}.`,
  ].flatMap((line) => wrap(line, 330, 9.5));
  details.forEach((line, index) => text(LEFT + 10, y - 16 - index * 13, line, 9.5, { color: MUTED }));
  y -= 24 + details.length * 13;
  rule(y);

  // Totals.
  const totals: Array<[string, string, { bold?: boolean; color?: Color }]> = [
    ['Total', `${money(data.amountMicro)} USDC`, { bold: true }],
    ['Paid', `${money(paid)} USDC`, { color: GREEN }],
    ['Balance due', `${money(due)} USDC`, { bold: true }],
  ];
  y -= 22;
  for (const [name, value, style] of totals) {
    text(330, y, name, 10.5, { bold: style.bold, color: style.color === GREEN ? GREEN : INK });
    right(RIGHT - 10, y, value, 10.5, style);
    y -= 18;
  }
  rule(y + 6, 330);

  // Payments.
  y -= 22;
  label(LEFT, y, data.payments.length === 1 ? 'Payment' : 'Payments');
  y -= 18;
  for (const payment of data.payments.slice(0, 3)) {
    const rows: Array<[string, string]> = [
      ['Received', stamp(payment.at)],
      ['Amount', `${money(payment.amountMicro)} USDC`],
      ['From wallet', payment.from],
      ['To wallet', payment.to],
    ];
    for (const [name, value] of rows) {
      text(LEFT, y, name, 9.5, { color: MUTED });
      text(LEFT + 90, y, value, 9.5);
      y -= 14;
    }
    text(LEFT, y, 'Transaction', 9.5, { color: MUTED });
    text(LEFT + 90, y, payment.signature, 7.5);
    y -= 14;
    const view = 'View this transaction on Solana Explorer';
    text(LEFT + 90, y, view, 9, { color: ACCENT });
    ops.push({ kind: 'link', x: LEFT + 90, y: y - 3, w: textWidth(view, 9), h: 13, url: payment.url });
    y -= 22;
  }
  if (data.payments.length > 3) {
    text(LEFT, y, `And ${data.payments.length - 3} more payment(s), listed in the project's records.`, 9.5, { color: MUTED });
    y -= 20;
  }

  // Note.
  if (data.note) {
    label(LEFT, y, 'Note');
    y -= 16;
    for (const line of wrap(data.note, RIGHT - LEFT, 10)) {
      text(LEFT, y, line, 10);
      y -= 14;
    }
  }

  // Footer.
  rule(78);
  text(LEFT, 62, "Generated by Discordlancer from the project's records. The payment was verified on the Solana blockchain:", 8, { color: MUTED });
  text(LEFT, 51, 'the transaction above is its proof.', 8, { color: MUTED });
  right(RIGHT, 51, data.number, 8, { color: MUTED });
  return ops;
}

export function invoicePdf(data: InvoiceData): Buffer {
  return pdfDocument(invoiceOps(data), { title: `Invoice ${data.number}`, created: data.issuedAt });
}
