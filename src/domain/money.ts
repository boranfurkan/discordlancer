// USDC amounts as whole micro-units (USDC has 6 decimals), never floats.
// 250 USDC is 250_000_000 micro-USDC.

export const USDC_DECIMALS = 6;
const UNIT = 10 ** USDC_DECIMALS;

/** A sanity cap on any single amount: one million USDC. */
export const MAX_MICRO = 1_000_000 * UNIT;

export class MoneyError extends Error {
  override name = 'MoneyError';
}

/**
 * Parses what Boran types, such as "250", "250.5" or "0.01", into micro-USDC.
 * Commas are refused, because "1,5" means 1.5 in Turkish and 15 in English.
 */
export function parseUsdc(input: string): number {
  const text = input.trim();
  if (text.includes(',')) throw new MoneyError('Use a dot for decimals and no thousands separators, like 1250.50');
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new MoneyError('Write the amount as a number, like 250 or 250.50');
  const [, whole = '', fraction = ''] = match;
  if (fraction.length > USDC_DECIMALS) throw new MoneyError(`USDC has at most ${USDC_DECIMALS} decimal places`);
  const micro = Number(whole) * UNIT + Number(fraction.padEnd(USDC_DECIMALS, '0'));
  if (!Number.isSafeInteger(micro) || micro > MAX_MICRO) throw new MoneyError('That amount is too large');
  if (micro <= 0) throw new MoneyError('The amount must be more than zero');
  return micro;
}

function assertMicro(micro: number): void {
  if (!Number.isSafeInteger(micro) || micro < 0) throw new MoneyError(`Not a valid micro-USDC amount: ${micro}`);
}

function split(micro: number): { whole: string; fraction: string } {
  assertMicro(micro);
  return {
    whole: Math.floor(micro / UNIT).toString(),
    fraction: (micro % UNIT).toString().padStart(USDC_DECIMALS, '0'),
  };
}

/** For people: at least two decimals, more only when needed. 250_000_000 → "250.00". */
export function formatUsdc(micro: number): string {
  const { whole, fraction } = split(micro);
  const trimmed = fraction.replace(/0+$/, '').padEnd(2, '0');
  return `${whole}.${trimmed}`;
}

/** For a Solana Pay URL: no trailing zeros. 250_000_000 → "250", 10_000 → "0.01". */
export function toDecimalString(micro: number): string {
  const { whole, fraction } = split(micro);
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}` : whole;
}
