// Read-only Solana RPC (plain JSON-RPC over fetch), fresh reference keys, and QR codes.
// The bot never holds a private key, signs or sends anything. The RPC URL carries an
// API key, so it is registered as a secret and never logged.

import { generateKeyPairSigner, isAddress } from '@solana/kit';
import QRCode from 'qrcode';
import { z } from 'zod';
import type { Env } from '../env.js';
import { log } from '../log.js';

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TIMEOUT_MS = 20_000;
const ATTEMPTS = 3;

export class SolanaError extends Error {
  override name = 'SolanaError';
}

export interface SignatureInfo {
  signature: string;
  err: unknown;
}

export interface SolanaApi {
  /** Finalized signatures that mention this address, newest first. */
  signaturesFor(address: string, limit?: number): Promise<SignatureInfo[]>;
  /** A finalized transaction in jsonParsed form, or null if it isn't finalized (or doesn't exist). */
  transaction(signature: string): Promise<unknown>;
  /** The program that owns an account, or null if the account doesn't exist yet. */
  accountOwner(address: string): Promise<string | null>;
}

const Signatures = z.array(z.object({ signature: z.string(), err: z.unknown() }));
const AccountInfo = z.object({ value: z.object({ owner: z.string() }).nullable() });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createSolana(
  env: Pick<Env, 'SOLANA_RPC_URL'>,
  options: { fetch?: typeof fetch; baseDelayMs?: number } = {},
): SolanaApi {
  const doFetch = options.fetch ?? fetch;
  const baseDelayMs = options.baseDelayMs ?? 500;

  async function rpc(method: string, params: unknown[]): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const response = await doFetch(env.SOLANA_RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (response.status === 429 || response.status >= 500) throw new SolanaError(`RPC ${method} returned HTTP ${response.status}`);
        if (!response.ok) throw Object.assign(new SolanaError(`RPC ${method} returned HTTP ${response.status}`), { final: true });
        const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
        if (body.error) throw Object.assign(new SolanaError(`RPC ${method}: ${body.error.message ?? 'error'}`), { final: true });
        return body.result;
      } catch (error) {
        lastError = error;
        if ((error as { final?: boolean }).final || attempt === ATTEMPTS) break;
        log.warn('solana rpc retry', { method, attempt });
        await sleep(baseDelayMs * 2 ** (attempt - 1));
      }
    }
    throw lastError instanceof Error ? lastError : new SolanaError(String(lastError));
  }

  return {
    async signaturesFor(address, limit = 20) {
      return Signatures.parse(await rpc('getSignaturesForAddress', [address, { limit, commitment: 'finalized' }]));
    },
    async transaction(signature) {
      // maxSupportedTransactionVersion must be 1: without it, versioned transactions fail to load.
      return (
        (await rpc('getTransaction', [
          signature,
          { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'finalized' },
        ])) ?? null
      );
    },
    async accountOwner(address) {
      const info = AccountInfo.parse(await rpc('getAccountInfo', [address, { encoding: 'base64', commitment: 'finalized' }]));
      return info.value?.owner ?? null;
    },
  };
}

/** A fresh, unique reference key for a Solana Pay request. Its private key is thrown away. */
export async function newReference(): Promise<string> {
  return (await generateKeyPairSigner()).address;
}

export function isSolanaAddress(value: string): boolean {
  return isAddress(value);
}

export function qrPng(text: string): Promise<Buffer> {
  return QRCode.toBuffer(text, { width: 512, margin: 2, errorCorrectionLevel: 'M' });
}
