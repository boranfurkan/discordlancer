// Gemini through the interactions API, always with `store: false`, because the
// input is client conversation. Every call asks for JSON matching a schema, and the
// answer is checked again with Zod: a model can return well-formed nonsense.

import { GoogleGenAI } from '@google/genai';
import type { z } from 'zod';
import type { Env } from '../env.js';
import { log } from '../log.js';

export const SPEC_MODEL = 'gemini-3.8-flash';
export const FAST_MODEL = 'gemini-3.5-flash-lite';

/** What the API accepts inline: the whole request must stay under 20 MB. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'] as const;

export type Part =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mime_type: string }
  | { type: 'audio'; data: string; mime_type: string };

export interface JsonRequest<T> {
  model: string;
  system: string;
  input: Part[];
  /** JSON Schema sent to Gemini. */
  schema: Record<string, unknown>;
  /** Zod check on the parsed answer. */
  parse: z.ZodType<T>;
  maxOutputTokens?: number;
  thinking?: 'minimal' | 'low' | 'medium' | 'high';
}

export interface GeminiApi {
  json<T>(request: JsonRequest<T>): Promise<T>;
}

export class GeminiError extends Error {
  override name = 'GeminiError';
}

const TIMEOUT_MS = 180_000;
const ATTEMPTS = 3;

function status(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The client the service needs; a fake in tests. */
export interface InteractionsClient {
  interactions: {
    create(params: Record<string, unknown>, options?: Record<string, unknown>): Promise<{ output_text?: string | undefined }>;
  };
}

export function createGemini(
  env: Pick<Env, 'GEMINI_API_KEY'>,
  client?: InteractionsClient,
  options: { baseDelayMs?: number } = {},
): GeminiApi {
  const baseDelayMs = options.baseDelayMs ?? 1_000;
  const ai: InteractionsClient = client ?? (new GoogleGenAI({ apiKey: env.GEMINI_API_KEY }) as unknown as InteractionsClient);

  return {
    async json<T>(request: JsonRequest<T>): Promise<T> {
      let lastError: unknown;
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        try {
          const interaction = await ai.interactions.create(
            {
              model: request.model,
              system_instruction: request.system,
              input: request.input,
              store: false,
              response_format: { type: 'text', mime_type: 'application/json', schema: request.schema },
              generation_config: {
                ...(request.maxOutputTokens ? { max_output_tokens: request.maxOutputTokens } : {}),
                ...(request.thinking ? { thinking_level: request.thinking } : {}),
              },
            },
            { timeout_ms: TIMEOUT_MS },
          );
          const text = interaction.output_text;
          if (!text) throw new GeminiError('Gemini returned no text');
          let value: unknown;
          try {
            value = JSON.parse(text);
          } catch {
            throw new GeminiError('Gemini returned text that is not JSON');
          }
          const checked = request.parse.safeParse(value);
          if (!checked.success) throw new GeminiError('Gemini returned JSON in the wrong shape');
          return checked.data;
        } catch (error) {
          lastError = error;
          const code = status(error);
          if (code === 402) throw new GeminiError('Gemini credits have run out. Top up in AI Studio, then try again.');
          if (code === 400 || code === 401 || code === 403) throw error;
          // Bad output, rate limits and server errors are worth another try.
          const temporary = error instanceof GeminiError || code === 429 || (code !== undefined && code >= 500);
          if (!temporary || attempt === ATTEMPTS) break;
          log.warn('gemini retry', { attempt, status: code, model: request.model });
          await sleep(baseDelayMs * 2 ** (attempt - 1) + Math.random() * baseDelayMs * 0.5);
        }
      }
      throw lastError instanceof Error ? lastError : new GeminiError(String(lastError));
    },
  };
}
