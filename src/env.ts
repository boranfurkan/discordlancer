// Parses the environment once, at startup. A bad value is reported by its
// variable name only, never by its value, because logs are kept for the audit.

import { existsSync } from 'node:fs';
import { z } from 'zod';

const required = z.string().trim().min(1, 'is empty');
const discordId = z.string().trim().regex(/^\d{17,20}$/, 'must be a Discord ID of 17 to 20 digits');
const prefixed = (pattern: RegExp, hint: string) => z.string().trim().regex(pattern, hint);
/** Optional: left empty, the feature falls back or stays off. */
const optional = z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? undefined : value), z.string().trim().optional());

export const EnvSchema = z.object({
  DISCORD_TOKEN: required,
  DISCORD_APPLICATION_ID: discordId,
  DISCORD_GUILD_ID: discordId,
  DISCORD_OWNER_ID: discordId,
  GITHUB_TOKEN: required,
  GITHUB_OWNER: required,
  GEMINI_API_KEY: required,
  SURREAL_URL: prefixed(/^wss?:\/\//, 'must start with wss://'),
  SURREAL_NAMESPACE: required,
  SURREAL_DATABASE: required,
  SURREAL_USER: required,
  SURREAL_PASS: required,
  MEMORY_URL: prefixed(/^https:\/\//, 'must start with https://'),
  MEMORY_CONTEXT_ID: required,
  MEMORY_API_KEY: required,
  SOLANA_WALLET_ADDRESS: prefixed(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'must be a Solana address'),
  SOLANA_RPC_URL: prefixed(/^https:\/\//, 'must start with https://'),
  TAVILY_API_KEY: required,
  /** ElevenLabs speech to text, for recorded calls. Without it, Gemini transcribes them. */
  ELEVENLABS_API_KEY: optional,
});

export type Env = z.infer<typeof EnvSchema>;

/** Variables whose values must never appear in a log, a message or an error. */
export const SECRET_NAMES = [
  'DISCORD_TOKEN',
  'GITHUB_TOKEN',
  'GEMINI_API_KEY',
  'SURREAL_USER',
  'SURREAL_PASS',
  'MEMORY_API_KEY',
  'SOLANA_RPC_URL',
  'TAVILY_API_KEY',
  'ELEVENLABS_API_KEY',
] as const satisfies readonly (keyof Env)[];

export class EnvError extends Error {
  override name = 'EnvError';
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = EnvSchema.safeParse(source);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => {
    const name = issue.path.join('.');
    return issue.code === 'invalid_type' ? `${name} is missing` : `${name} ${issue.message}`;
  });
  throw new EnvError(`Fix the environment: ${problems.join('; ')}`);
}

/** Reads `.env` when it exists (local runs). On Replit the values come from Secrets. */
export function loadEnv(file = '.env'): Env {
  if (existsSync(file)) process.loadEnvFile(file);
  return parseEnv(process.env);
}

/** Every secret value, including the API key inside the Solana RPC URL. */
export function secretValues(env: Env): string[] {
  const values: string[] = SECRET_NAMES.map((name) => env[name]).filter((value): value is string => Boolean(value));
  try {
    for (const value of new URL(env.SOLANA_RPC_URL).searchParams.values()) values.push(value);
  } catch {
    // The schema already checked the URL's shape.
  }
  return values;
}
