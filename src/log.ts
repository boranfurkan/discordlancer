// JSON-line logging to stdout, which Replit keeps. Every line is scrubbed of
// registered secrets before it is written.

type Level = 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

let secrets: string[] = [];

/** Registers values that must never be written. Short values are ignored to avoid hiding ordinary words. */
export function registerSecrets(values: Iterable<string>): void {
  const all = new Set([...secrets, ...values]);
  // Longest first, so a secret that contains another is hidden whole.
  secrets = [...all].filter((value) => value.length >= 6).sort((a, b) => b.length - a.length);
}

export function scrub(text: string): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join('[hidden]');
  return out;
}

function toJson(_key: string, value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function write(level: Level, message: string, fields: Fields = {}): void {
  const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...fields }, toJson);
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(`${scrub(line)}\n`);
}

export const log = {
  info: (message: string, fields?: Fields) => write('info', message, fields),
  warn: (message: string, fields?: Fields) => write('warn', message, fields),
  error: (message: string, fields?: Fields) => write('error', message, fields),
};
