import { describe, expect, it } from 'vitest';
import { DeadlineError, formatDeadline, FREEZE, isAfterFreeze, londonToUtc, parseDeadline } from '../../src/domain/deadline.js';

const now = new Date('2026-11-09T12:00:00Z');

describe('parseDeadline', () => {
  it('reads a date as 18:00 London time', () => {
    expect(parseDeadline('2026-11-17', now).toISOString()).toBe('2026-11-17T18:00:00.000Z');
  });

  it('reads a date and time in winter (GMT, same as UTC)', () => {
    expect(parseDeadline('2026-11-17 14:30', now).toISOString()).toBe('2026-11-17T14:30:00.000Z');
  });

  it('reads summer times as BST, an hour ahead of UTC', () => {
    expect(parseDeadline('2027-07-01 18:00', now).toISOString()).toBe('2027-07-01T17:00:00.000Z');
  });

  it('handles the clock change days', () => {
    expect(londonToUtc(2027, 3, 28, 12, 0).toISOString()).toBe('2027-03-28T11:00:00.000Z');
    expect(londonToUtc(2027, 10, 31, 12, 0).toISOString()).toBe('2027-10-31T12:00:00.000Z');
  });

  it.each([
    ['17/11/2026', /YYYY-MM-DD/],
    ['2026-11-31', /does not exist/],
    ['2026-02-29', /does not exist/],
    ['2026-13-01', /does not exist/],
    ['2026-11-17 24:00', /time does not exist/],
    ['2026-11-01', /in the future/],
  ])('refuses %j', (input, message) => {
    expect(() => parseDeadline(input, now)).toThrow(DeadlineError);
    expect(() => parseDeadline(input, now)).toThrow(message);
  });
});

describe('freeze and formatting', () => {
  it('flags deadlines after the freeze, Wed 18 Nov 2026 at 6pm', () => {
    expect(FREEZE.toISOString()).toBe('2026-11-18T18:00:00.000Z');
    expect(isAfterFreeze(parseDeadline('2026-11-18', now))).toBe(false);
    expect(isAfterFreeze(parseDeadline('2026-11-18 18:01', now))).toBe(true);
  });

  it('shows deadlines in London time', () => {
    expect(formatDeadline(new Date('2026-11-17T18:00:00Z'))).toBe('Tue 17 Nov 2026, 18:00 (London)');
    expect(formatDeadline(new Date('2027-07-01T17:00:00Z'))).toBe('Thu 1 Jul 2027, 18:00 (London)');
  });
});
