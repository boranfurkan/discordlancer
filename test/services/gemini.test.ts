import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createGemini, GeminiError, type InteractionsClient } from '../../src/services/gemini.js';

const Shape = z.object({ ok: z.boolean() });
const request = {
  model: 'gemini-3.8-flash',
  system: 'rules',
  input: [{ type: 'text' as const, text: 'hello' }],
  schema: { type: 'object' },
  parse: Shape,
};

function fakeClient(answers: Array<() => { output_text?: string }>): { client: InteractionsClient; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  let index = 0;
  return {
    calls,
    client: {
      interactions: {
        create: async (params) => {
          calls.push(params);
          const answer = answers[Math.min(index++, answers.length - 1)]!;
          return answer();
        },
      },
    },
  };
}

const fast = { baseDelayMs: 1 };
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

describe('gemini json', () => {
  it('never lets Google keep the conversation, and asks for JSON to a schema', async () => {
    const { client, calls } = fakeClient([() => ({ output_text: '{"ok":true}' })]);
    expect(await createGemini({ GEMINI_API_KEY: 'k' }, client).json(request)).toEqual({ ok: true });
    expect(calls[0]).toMatchObject({
      model: 'gemini-3.8-flash',
      system_instruction: 'rules',
      store: false,
      response_format: { type: 'text', mime_type: 'application/json', schema: { type: 'object' } },
    });
  });

  it('retries bad output, then gives up with a clear error', async () => {
    const { client, calls } = fakeClient([() => ({ output_text: 'not json' }), () => ({ output_text: '{"ok":"yes"}' })]);
    await expect(createGemini({ GEMINI_API_KEY: 'k' }, client, fast).json(request)).rejects.toThrow(GeminiError);
    expect(calls).toHaveLength(3);
  });

  it('recovers when a retry returns good output', async () => {
    const { client } = fakeClient([
      () => {
        throw httpError(503);
      },
      () => ({ output_text: '{"ok":false}' }),
    ]);
    expect(await createGemini({ GEMINI_API_KEY: 'k' }, client, fast).json(request)).toEqual({ ok: false });
  });

  it('explains run-out credits at once, without retrying', async () => {
    const { client, calls } = fakeClient([
      () => {
        throw httpError(402);
      },
    ]);
    await expect(createGemini({ GEMINI_API_KEY: 'k' }, client).json(request)).rejects.toThrow(/credits have run out/);
    expect(calls).toHaveLength(1);
  });

  it('does not retry a request Gemini rejected as invalid', async () => {
    const { client, calls } = fakeClient([
      () => {
        throw httpError(400);
      },
    ]);
    await expect(createGemini({ GEMINI_API_KEY: 'k' }, client).json(request)).rejects.toThrow('HTTP 400');
    expect(calls).toHaveLength(1);
  });
});
