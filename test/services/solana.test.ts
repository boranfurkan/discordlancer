import { describe, expect, it } from 'vitest';
import { createSolana, isSolanaAddress, newReference, qrPng, SYSTEM_PROGRAM } from '../../src/services/solana.js';

const env = { SOLANA_RPC_URL: 'https://rpc.example.test/?api-key=test' };

function fakeRpc(answers: Array<{ status?: number; body?: unknown }>) {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  let index = 0;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    calls.push({ method: body.method, params: body.params });
    const answer = answers[Math.min(index++, answers.length - 1)]!;
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('solana rpc', () => {
  it('asks for finalized, jsonParsed transactions with maxSupportedTransactionVersion 1', async () => {
    const { fetchImpl, calls } = fakeRpc([{ body: { result: { slot: 1 } } }]);
    expect(await createSolana(env, { fetch: fetchImpl }).transaction('sig')).toEqual({ slot: 1 });
    expect(calls[0]).toEqual({
      method: 'getTransaction',
      params: ['sig', { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'finalized' }],
    });
  });

  it('returns null for a transaction that is not finalized yet', async () => {
    const { fetchImpl } = fakeRpc([{ body: { result: null } }]);
    expect(await createSolana(env, { fetch: fetchImpl }).transaction('sig')).toBeNull();
  });

  it('lists finalized signatures for a reference', async () => {
    const { fetchImpl, calls } = fakeRpc([{ body: { result: [{ signature: 'a', err: null, slot: 5 }] } }]);
    expect(await createSolana(env, { fetch: fetchImpl }).signaturesFor('ref', 10)).toEqual([{ signature: 'a', err: null }]);
    expect(calls[0]?.params).toEqual(['ref', { limit: 10, commitment: 'finalized' }]);
  });

  it('reads an account owner, or null for an account that does not exist', async () => {
    const owned = fakeRpc([{ body: { result: { value: { owner: SYSTEM_PROGRAM } } } }]);
    expect(await createSolana(env, { fetch: owned.fetchImpl }).accountOwner('x')).toBe(SYSTEM_PROGRAM);
    const missing = fakeRpc([{ body: { result: { value: null } } }]);
    expect(await createSolana(env, { fetch: missing.fetchImpl }).accountOwner('x')).toBeNull();
  });

  it('retries rate limits and server errors, then succeeds', async () => {
    const { fetchImpl, calls } = fakeRpc([{ status: 429 }, { status: 503 }, { body: { result: null } }]);
    expect(await createSolana(env, { fetch: fetchImpl, baseDelayMs: 1 }).transaction('sig')).toBeNull();
    expect(calls).toHaveLength(3);
  });

  it('does not retry an RPC error, and never puts the URL in the message', async () => {
    const { fetchImpl, calls } = fakeRpc([{ body: { error: { message: 'Invalid param' } } }]);
    const error = (await createSolana(env, { fetch: fetchImpl, baseDelayMs: 1 })
      .transaction('sig')
      .catch((e: unknown) => e)) as Error;
    expect(error.message).toBe('RPC getTransaction: Invalid param');
    expect(error.message).not.toContain('api-key');
    expect(calls).toHaveLength(1);
  });
});

describe('references and QR codes', () => {
  it('makes a fresh, valid reference key each time', async () => {
    const [a, b] = [await newReference(), await newReference()];
    expect(isSolanaAddress(a)).toBe(true);
    expect(a).not.toBe(b);
  });

  it('draws a PNG QR code', async () => {
    const png = await qrPng('solana:abc?amount=1');
    expect(png.subarray(1, 4).toString()).toBe('PNG');
  });
});
