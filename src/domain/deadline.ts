// Quote deadlines are typed in London time: "2026-11-17" (meaning 18:00 that day)
// or "2026-11-17 14:30". London moves between GMT and BST, so the offset is worked
// out for that date rather than assumed.

export const TIME_ZONE = 'Europe/London';
export const DEFAULT_TIME = '18:00';

/** The hackathon freeze: Wed 18 Nov 2026, 6pm London time (GMT, so 18:00 UTC). */
export const FREEZE = new Date('2026-11-18T18:00:00Z');

export class DeadlineError extends Error {
  override name = 'DeadlineError';
}

/** Minutes London is ahead of UTC at this instant (0 in winter, 60 in summer). */
function londonOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

export function londonToUtc(year: number, month: number, day: number, hour: number, minute: number): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  return new Date(guess.getTime() - londonOffsetMinutes(guess) * 60_000);
}

export function parseDeadline(input: string, now: Date = new Date()): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(input.trim());
  if (!match) throw new DeadlineError('Write the deadline as YYYY-MM-DD, or YYYY-MM-DD HH:MM in London time, like 2026-11-17 18:00');
  const [, y, mo, d, h = DEFAULT_TIME.slice(0, 2), mi = DEFAULT_TIME.slice(3)] = match;
  const [year, month, day, hour, minute] = [y, mo, d, h, mi].map(Number) as [number, number, number, number, number];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (month < 1 || month > 12 || check.getUTCDate() !== day || check.getUTCMonth() !== month - 1) {
    throw new DeadlineError('That date does not exist');
  }
  if (hour > 23 || minute > 59) throw new DeadlineError('That time does not exist');
  const deadline = londonToUtc(year, month, day, hour, minute);
  if (deadline.getTime() <= now.getTime()) throw new DeadlineError('The deadline must be in the future');
  return deadline;
}

/** For people: "Tue 17 Nov 2026, 18:00 (London)". */
export function formatDeadline(deadline: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(deadline);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('weekday')} ${get('day')} ${get('month')} ${get('year')}, ${get('hour')}:${get('minute')} (London)`;
}

export function isAfterFreeze(deadline: Date): boolean {
  return deadline.getTime() > FREEZE.getTime();
}
