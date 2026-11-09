// Project names that work as both a Discord channel name and a GitHub repo name:
// lowercase letters, digits and single hyphens, 3 to 60 characters.

export const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const NAME_MIN = 3;
export const NAME_MAX = 60;

// Letters that don't lose their accent through Unicode decomposition.
const SPECIAL: Record<string, string> = { ı: 'i', İ: 'i', ß: 'ss', æ: 'ae', ø: 'o', œ: 'oe', ł: 'l', đ: 'd' };

/** Turns what Boran typed into a name: "Atmaca Kişisel Site" → "atmaca-kisisel-site". */
export function toProjectName(input: string): string {
  return input
    .replace(/[ıİßæøœłđ]/g, (letter) => SPECIAL[letter] ?? letter)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export type NameCheck = { ok: true; name: string } | { ok: false; reason: string };

export function checkProjectName(input: string): NameCheck {
  const name = toProjectName(input);
  if (name.length < NAME_MIN) return { ok: false, reason: `Use at least ${NAME_MIN} letters or digits` };
  if (name.length > NAME_MAX) return { ok: false, reason: `Keep it to ${NAME_MAX} characters or fewer` };
  if (!NAME_PATTERN.test(name)) return { ok: false, reason: 'Use letters, digits and hyphens only' };
  return { ok: true, name };
}
