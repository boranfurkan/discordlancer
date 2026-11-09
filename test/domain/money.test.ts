import { describe, expect, it } from 'vitest';
import { formatUsdc, MAX_MICRO, MoneyError, parseUsdc, toDecimalString } from '../../src/domain/money.js';

describe('parseUsdc', () => {
  it.each([
    ['250', 250_000_000],
    ['250.5', 250_500_000],
    ['250.50', 250_500_000],
    ['0.01', 10_000],
    ['0.000001', 1],
    [' 12 ', 12_000_000],
    ['007', 7_000_000],
  ])('reads %j as %d micro-USDC', (input, micro) => {
    expect(parseUsdc(input)).toBe(micro);
  });

  it.each([
    ['1,5', /dot for decimals/],
    ['1,250.50', /dot for decimals/],
    ['abc', /as a number/],
    ['-5', /as a number/],
    ['1e3', /as a number/],
    ['', /as a number/],
    ['0', /more than zero/],
    ['0.000000', /more than zero/],
    ['0.0000001', /at most 6 decimal/],
    ['1000001', /too large/],
    ['99999999999999999999', /too large/],
  ])('refuses %j', (input, message) => {
    expect(() => parseUsdc(input)).toThrow(MoneyError);
    expect(() => parseUsdc(input)).toThrow(message);
  });

  it('accepts exactly the cap', () => {
    expect(parseUsdc('1000000')).toBe(MAX_MICRO);
  });
});

describe('formatting', () => {
  it.each([
    [250_000_000, '250.00', '250'],
    [250_500_000, '250.50', '250.5'],
    [10_000, '0.01', '0.01'],
    [1, '0.000001', '0.000001'],
    [123_456_789, '123.456789', '123.456789'],
  ])('%d micro-USDC shows as %s and pays as %s', (micro, shown, paid) => {
    expect(formatUsdc(micro)).toBe(shown);
    expect(toDecimalString(micro)).toBe(paid);
  });

  it('round-trips through the Solana Pay form', () => {
    for (const micro of [1, 10_000, 250_500_000, 999_999_999]) {
      expect(parseUsdc(toDecimalString(micro))).toBe(micro);
    }
  });

  it('refuses fractional or negative micro amounts', () => {
    expect(() => formatUsdc(1.5)).toThrow(MoneyError);
    expect(() => toDecimalString(-1)).toThrow(MoneyError);
  });
});
