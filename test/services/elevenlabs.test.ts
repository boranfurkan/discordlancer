import { describe, expect, it } from 'vitest';
import { createElevenLabs, ElevenLabsError, STT_MODEL } from '../../src/services/elevenlabs.js';

const env = { ELEVENLABS_API_KEY: 'el-key-for-tests' };
const transcript = {
  language_code: 'en',
  language_probability: 0.99,
  text: 'Hello there',
  transcription_id: 'tr_123',
  words: [
    { text: 'Hello', type: 'word', start: 0.1, end: 0.4, logprob: -0.1 },
    { text: ' ', type: 'spacing', start: 0.4, end: 0.45, logprob: 0 },
    { text: 'there', type: 'word', start: 0.45, end: 0.8, logprob: -0.1 },
  ],
};

type Seen = { method: string; url: string; key: string | null; form?: FormData };

function fakeFetch(answers: Array<{ status: number; json?: unknown; headers?: Record<string, string> }>) {
  const seen: Seen[] = [];
  let index = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    seen.push({ method: init?.method ?? 'GET', url, key: headers.get('xi-api-key'), ...(init?.body instanceof FormData ? { form: init.body } : {}) });
    if ((init?.method ?? 'GET') === 'DELETE') return new Response(null, { status: 200 });
    const answer = answers[Math.min(index++, answers.length - 1)]!;
    return new Response(answer.json === undefined ? 'error' : JSON.stringify(answer.json), { status: answer.status, headers: answer.headers });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

describe('ElevenLabs speech to text', () => {
  it('sends the audio with our options, returns the words, then deletes its copy', async () => {
    const { fetchImpl, seen } = fakeFetch([{ status: 200, json: transcript }]);
    const result = await createElevenLabs(env, { fetch: fetchImpl }).transcribe(Buffer.from('OggS...'), 'speaker.ogg', 'audio/ogg');
    expect(result).toEqual({ text: 'Hello there', languageCode: 'en', words: transcript.words.map(({ logprob: _, ...word }) => word) });
    const [post, remove] = seen;
    expect(post!.url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect(post!.key).toBe('el-key-for-tests');
    const form = post!.form!;
    expect(form.get('model_id')).toBe(STT_MODEL);
    expect(form.get('timestamps_granularity')).toBe('word');
    expect(form.get('no_verbatim')).toBe('true');
    expect(form.get('diarize')).toBe('false');
    expect((form.get('file') as File).name).toBe('speaker.ogg');
    expect((form.get('file') as File).type).toBe('audio/ogg');
    expect(remove).toMatchObject({ method: 'DELETE', url: 'https://api.elevenlabs.io/v1/speech-to-text/transcripts/tr_123' });
  });

  it('retries a rate limit or server error, but not a refused key or empty credits', async () => {
    const retried = fakeFetch([{ status: 429 }, { status: 503 }, { status: 200, json: transcript }]);
    await expect(createElevenLabs(env, { fetch: retried.fetchImpl, baseDelayMs: 1 }).transcribe(Buffer.alloc(1), 'a.ogg', 'audio/ogg')).resolves.toMatchObject({ text: 'Hello there' });
    expect(retried.seen.filter((call) => call.method === 'POST')).toHaveLength(3);

    const refused = fakeFetch([{ status: 401 }]);
    await expect(createElevenLabs(env, { fetch: refused.fetchImpl, baseDelayMs: 1 }).transcribe(Buffer.alloc(1), 'a.ogg', 'audio/ogg')).rejects.toThrow('refused the API key');
    expect(refused.seen).toHaveLength(1);

    const broke = fakeFetch([{ status: 402 }]);
    await expect(createElevenLabs(env, { fetch: broke.fetchImpl, baseDelayMs: 1 }).transcribe(Buffer.alloc(1), 'a.ogg', 'audio/ogg')).rejects.toThrow('credits have run out');
  });

  it('refuses an answer in the wrong shape, and needs a key', async () => {
    const odd = fakeFetch([{ status: 200, json: { text: 'x' } }]);
    await expect(createElevenLabs(env, { fetch: odd.fetchImpl }).transcribe(Buffer.alloc(1), 'a.ogg', 'audio/ogg')).rejects.toThrow(ElevenLabsError);
    expect(() => createElevenLabs({ ELEVENLABS_API_KEY: undefined })).toThrow('ELEVENLABS_API_KEY is not set');
  });
});
