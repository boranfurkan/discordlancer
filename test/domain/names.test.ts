import { describe, expect, it } from 'vitest';
import { checkProjectName, NAME_PATTERN, toProjectName } from '../../src/domain/names.js';

describe('toProjectName', () => {
  it.each([
    ['atmaca-personal-website', 'atmaca-personal-website'],
    ['Atmaca Personal Website', 'atmaca-personal-website'],
    ['Atmaca Kişisel Site', 'atmaca-kisisel-site'],
    ['IŞIK Çiçekçilik', 'isik-cicekcilik'],
    ['Gölge_Üretim  App!!', 'golge-uretim-app'],
    ['--shop--v2--', 'shop-v2'],
    ['café crème', 'cafe-creme'],
  ])('turns %j into %j', (input, name) => {
    expect(toProjectName(input)).toBe(name);
  });
});

describe('checkProjectName', () => {
  it('accepts a good name and returns its normalised form', () => {
    expect(checkProjectName('Atmaca Personal Website')).toEqual({ ok: true, name: 'atmaca-personal-website' });
  });

  it.each(['', 'ab', '!!', '中文'])('refuses %j as too short once normalised', (input) => {
    expect(checkProjectName(input)).toMatchObject({ ok: false, reason: expect.stringMatching(/at least 3/) });
  });

  it('refuses names over 60 characters', () => {
    expect(checkProjectName('a'.repeat(61))).toMatchObject({ ok: false, reason: expect.stringMatching(/60/) });
  });

  it('only ever returns names valid for Discord and GitHub', () => {
    for (const input of ['Hello World', 'x--y', ' Ünlü Ödeme Ağı ', 'v2.0 launch']) {
      const result = checkProjectName(input);
      if (result.ok) expect(result.name).toMatch(NAME_PATTERN);
    }
  });
});
