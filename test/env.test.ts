import { describe, expect, it } from 'vitest';
import { EnvError, parseEnv, secretValues } from '../src/env.js';

// Made-up values in the right shapes. None of these are real.
const valid = {
  DISCORD_TOKEN: 'discord-token-for-tests',
  DISCORD_APPLICATION_ID: '123456789012345678',
  DISCORD_GUILD_ID: '223456789012345678',
  DISCORD_OWNER_ID: '323456789012345678',
  GITHUB_TOKEN: 'github-token-for-tests',
  GITHUB_OWNER: 'example-owner',
  GEMINI_API_KEY: 'gemini-key-for-tests',
  SURREAL_URL: 'wss://example.surrealdb.test/rpc',
  SURREAL_NAMESPACE: 'freelance',
  SURREAL_DATABASE: 'bot',
  SURREAL_USER: 'test-user',
  SURREAL_PASS: 'test-password-123',
  MEMORY_URL: 'https://memory.example.test',
  MEMORY_CONTEXT_ID: 'ctx',
  MEMORY_API_KEY: 'memory-key-for-tests',
  SOLANA_WALLET_ADDRESS: 'So11111111111111111111111111111111111111112',
  SOLANA_RPC_URL: 'https://rpc.example.test/?api-key=rpc-key-for-tests',
  TAVILY_API_KEY: 'tavily-key-for-tests',
};

describe('parseEnv', () => {
  it('accepts a complete environment and trims values', () => {
    const env = parseEnv({ ...valid, GITHUB_OWNER: '  example-owner  ' });
    expect(env.GITHUB_OWNER).toBe('example-owner');
  });

  it('names every missing or malformed variable, and never shows a value', () => {
    const bad = { ...valid, DISCORD_TOKEN: undefined, DISCORD_OWNER_ID: 'not-an-id-secretish', SURREAL_URL: 'https://wrong-scheme-secretish' };
    let message = '';
    try {
      parseEnv(bad);
    } catch (error) {
      expect(error).toBeInstanceOf(EnvError);
      message = (error as Error).message;
    }
    expect(message).toContain('DISCORD_TOKEN is missing');
    expect(message).toContain('DISCORD_OWNER_ID must be a Discord ID');
    expect(message).toContain('SURREAL_URL must start with wss://');
    expect(message).not.toContain('secretish');
  });

  it('refuses an empty value', () => {
    expect(() => parseEnv({ ...valid, GEMINI_API_KEY: '   ' })).toThrow(/GEMINI_API_KEY is empty/);
  });
});

describe('secretValues', () => {
  it('includes every secret and the API key inside the RPC URL, but not public values', () => {
    const secrets = secretValues(parseEnv(valid));
    expect(secrets).toEqual(expect.arrayContaining(['discord-token-for-tests', 'test-password-123', 'rpc-key-for-tests']));
    expect(secrets).not.toContain(valid.SOLANA_WALLET_ADDRESS);
    expect(secrets).not.toContain(valid.DISCORD_OWNER_ID);
  });
});
