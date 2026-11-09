// Checking a USDC payment on Solana, and building the Solana Pay request. Pure:
// the RPC lives in services/solana.ts. A payment counts only if all of this holds:
// the transaction succeeded; Boran's wallet gained at least the amount due in USDC;
// the client's declared wallet lost at least that much; and, for a Solana Pay
// request, the transaction carries the request's reference key.

import { z } from 'zod';
import { toDecimalString, USDC_DECIMALS } from './money.js';

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const TokenBalance = z.object({
  mint: z.string(),
  owner: z.string().optional(),
  uiTokenAmount: z.object({ amount: z.string().regex(/^\d+$/), decimals: z.number().int() }),
});

/** The parts of a `getTransaction` (jsonParsed) result we rely on. */
export const ParsedTransaction = z.object({
  slot: z.number().int(),
  blockTime: z.number().int().nullable().optional(),
  meta: z
    .object({
      err: z.unknown().nullable(),
      preTokenBalances: z.array(TokenBalance).nullable().optional(),
      postTokenBalances: z.array(TokenBalance).nullable().optional(),
    })
    .nullable(),
  transaction: z.object({
    signatures: z.array(z.string()).min(1),
    message: z.object({ accountKeys: z.array(z.object({ pubkey: z.string() })) }),
  }),
});
export type ParsedTransaction = z.infer<typeof ParsedTransaction>;

/** Net USDC change per owner wallet, in micro-USDC. Missing balances count as zero. */
export function usdcChanges(tx: ParsedTransaction): Map<string, bigint> {
  const changes = new Map<string, bigint>();
  const add = (balances: z.infer<typeof TokenBalance>[] | null | undefined, sign: 1n | -1n) => {
    for (const balance of balances ?? []) {
      if (balance.mint !== USDC_MINT || !balance.owner) continue;
      changes.set(balance.owner, (changes.get(balance.owner) ?? 0n) + sign * BigInt(balance.uiTokenAmount.amount));
    }
  };
  add(tx.meta?.preTokenBalances, -1n);
  add(tx.meta?.postTokenBalances, 1n);
  return changes;
}

export interface Expected {
  signature: string;
  recipient: string;
  sender: string;
  minAmountMicro: number;
  /** Set for Solana Pay requests: the transaction must include this key. */
  reference?: string;
}

export type Verdict =
  | { ok: true; signature: string; amountMicro: number; from: string; to: string; slot: number; blockTime: Date | undefined }
  | { ok: false; reason: string };

export function verifyPayment(raw: unknown, expected: Expected): Verdict {
  const parsed = ParsedTransaction.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "the transaction couldn't be read" };
  const tx = parsed.data;

  if (tx.transaction.signatures[0] !== expected.signature) return { ok: false, reason: 'the signature does not match' };
  if (!tx.meta) return { ok: false, reason: 'the transaction has no result yet' };
  if (tx.meta.err !== null) return { ok: false, reason: 'the transaction failed on chain' };

  const usdc = [...(tx.meta.preTokenBalances ?? []), ...(tx.meta.postTokenBalances ?? [])].filter((b) => b.mint === USDC_MINT);
  if (usdc.some((balance) => balance.uiTokenAmount.decimals !== USDC_DECIMALS)) {
    return { ok: false, reason: 'unexpected USDC decimals' };
  }

  if (expected.reference && !tx.transaction.message.accountKeys.some((key) => key.pubkey === expected.reference)) {
    return { ok: false, reason: "it doesn't carry this payment request's reference" };
  }

  const changes = usdcChanges(tx);
  const due = BigInt(expected.minAmountMicro);
  const received = changes.get(expected.recipient) ?? 0n;
  const sent = -(changes.get(expected.sender) ?? 0n);
  if (received <= 0n) return { ok: false, reason: 'no USDC reached the receiving wallet' };
  if (sent <= 0n) return { ok: false, reason: "the USDC didn't come from the declared wallet" };
  if (received < due) {
    return {
      ok: false,
      reason: `too little: ${toDecimalString(Number(received))} USDC arrived, ${toDecimalString(expected.minAmountMicro)} USDC is due`,
    };
  }
  if (sent < due) return { ok: false, reason: 'the declared wallet sent less than the amount due' };
  if (received > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, reason: 'the amount is too large to record' };

  return {
    ok: true,
    signature: expected.signature,
    amountMicro: Number(received),
    from: expected.sender,
    to: expected.recipient,
    slot: tx.slot,
    blockTime: tx.blockTime ? new Date(tx.blockTime * 1000) : undefined,
  };
}

export interface PayRequest {
  recipient: string;
  amountMicro: number;
  reference: string;
  label: string;
  message: string;
}

/** A Solana Pay transfer request URL for USDC. */
export function solanaPayUrl(request: PayRequest): string {
  const params = [
    `amount=${toDecimalString(request.amountMicro)}`,
    `spl-token=${USDC_MINT}`,
    `reference=${request.reference}`,
    `label=${encodeURIComponent(request.label)}`,
    `message=${encodeURIComponent(request.message)}`,
  ];
  return `solana:${request.recipient}?${params.join('&')}`;
}

export function explorerUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}`;
}
