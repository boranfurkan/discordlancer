import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { explorerUrl, solanaPayUrl, USDC_MINT, usdcChanges, verifyPayment, ParsedTransaction } from '../../src/domain/payment.js';

// A real mainnet USDC transfer (25.008015 USDC), with every wallet address and the
// signature replaced by made-up values. Fake01 paid Fake05.
const fixture = JSON.parse(readFileSync(new URL('../fixtures/solana/usdc-transfer.json', import.meta.url), 'utf8'));
const SENDER = 'Fake01xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const RECIPIENT = 'Fake05xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const SIGNATURE = fixture.transaction.signatures[0] as string;
const REFERENCE = 'Ref1111111111111111111111111111111111111111';

const clone = () => structuredClone(fixture);
const expected = { signature: SIGNATURE, recipient: RECIPIENT, sender: SENDER, minAmountMicro: 25_000_000 };

describe('usdcChanges', () => {
  it('nets pre and post balances per owner, in micro-USDC', () => {
    const changes = usdcChanges(ParsedTransaction.parse(fixture));
    expect(changes.get(SENDER)).toBe(-25_008_015n);
    expect(changes.get(RECIPIENT)).toBe(25_008_015n);
  });
});

describe('verifyPayment', () => {
  it('accepts a payment of at least the amount due, recording what actually arrived', () => {
    expect(verifyPayment(fixture, expected)).toEqual({
      ok: true,
      signature: SIGNATURE,
      amountMicro: 25_008_015,
      from: SENDER,
      to: RECIPIENT,
      slot: fixture.slot,
      blockTime: new Date(fixture.blockTime * 1000),
    });
  });

  it('refuses too little', () => {
    expect(verifyPayment(fixture, { ...expected, minAmountMicro: 26_000_000 })).toEqual({
      ok: false,
      reason: 'too little: 25.008015 USDC arrived, 26 USDC is due',
    });
  });

  it('refuses a payment from a wallet other than the declared one', () => {
    expect(verifyPayment(fixture, { ...expected, sender: 'SomeoneElse1111111111111111111111111111111' })).toMatchObject({
      ok: false,
      reason: "the USDC didn't come from the declared wallet",
    });
  });

  it('refuses a payment to a different wallet', () => {
    expect(verifyPayment(fixture, { ...expected, recipient: 'NotBoran11111111111111111111111111111111111' })).toMatchObject({
      ok: false,
      reason: 'no USDC reached the receiving wallet',
    });
  });

  it('refuses a token other than USDC', () => {
    const tx = clone();
    for (const balance of [...tx.meta.preTokenBalances, ...tx.meta.postTokenBalances]) balance.mint = 'OtherMint1111111111111111111111111111111111';
    expect(verifyPayment(tx, expected)).toMatchObject({ ok: false, reason: 'no USDC reached the receiving wallet' });
  });

  it('refuses a failed transaction, even if balances moved', () => {
    const tx = clone();
    tx.meta.err = { InstructionError: [2, 'Custom'] };
    expect(verifyPayment(tx, expected)).toEqual({ ok: false, reason: 'the transaction failed on chain' });
  });

  it('refuses a transaction whose signature is not the one asked about', () => {
    expect(verifyPayment(fixture, { ...expected, signature: 'Other' })).toMatchObject({ ok: false, reason: 'the signature does not match' });
  });

  it('requires the reference for Solana Pay requests', () => {
    expect(verifyPayment(fixture, { ...expected, reference: REFERENCE })).toMatchObject({ ok: false, reason: expect.stringContaining('reference') });
    const tx = clone();
    tx.transaction.message.accountKeys.push({ pubkey: REFERENCE, writable: false, signer: false, source: 'transaction' });
    expect(verifyPayment(tx, { ...expected, reference: REFERENCE })).toMatchObject({ ok: true });
  });

  it('counts a brand-new token account (no balance before) as starting from zero', () => {
    const tx = clone();
    tx.meta.preTokenBalances = tx.meta.preTokenBalances.filter((b: { owner: string }) => b.owner !== RECIPIENT);
    expect(verifyPayment(tx, expected)).toMatchObject({ ok: true, amountMicro: 25_008_015 });
  });

  it('refuses USDC balances with unexpected decimals', () => {
    const tx = clone();
    tx.meta.postTokenBalances[0].uiTokenAmount.decimals = 9;
    expect(verifyPayment(tx, expected)).toEqual({ ok: false, reason: 'unexpected USDC decimals' });
  });

  it("refuses something that isn't a transaction", () => {
    expect(verifyPayment({ hello: 'world' }, expected)).toEqual({ ok: false, reason: "the transaction couldn't be read" });
    expect(verifyPayment(null, expected)).toMatchObject({ ok: false });
  });
});

describe('Solana Pay', () => {
  it('builds a USDC transfer request with the reference and encoded text', () => {
    const url = solanaPayUrl({
      recipient: RECIPIENT,
      amountMicro: 250_500_000,
      reference: REFERENCE,
      label: 'Discordlancer',
      message: 'dl-test quote v2',
    });
    expect(url).toBe(
      `solana:${RECIPIENT}?amount=250.5&spl-token=${USDC_MINT}&reference=${REFERENCE}&label=Discordlancer&message=dl-test%20quote%20v2`,
    );
  });

  it('links to the Solana explorer', () => {
    expect(explorerUrl('abc')).toBe('https://explorer.solana.com/tx/abc');
  });
});
