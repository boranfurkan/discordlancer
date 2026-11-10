// ElevenLabs speech to text (Scribe), for recorded calls. Called over REST with fetch;
// the official SDK would add a dependency for one endpoint. After each transcript is
// received, the bot asks ElevenLabs to delete its copy (zero-retention mode is for
// enterprise plans only, so deleting is the next best thing).

import { z } from 'zod';
import type { Env } from '../env.js';
import { log } from '../log.js';

export const STT_MODEL = 'scribe_v2';
const BASE = 'https://api.elevenlabs.io';
const TIMEOUT_MS = 5 * 60_000;
const ATTEMPTS = 3;

export class ElevenLabsError extends Error {
  override name = 'ElevenLabsError';
}

const Word = z.object({
  text: z.string(),
  type: z.enum(['word', 'spacing', 'audio_event']),
  start: z.number().nullish(),
  end: z.number().nullish(),
});
export type SttWord = z.infer<typeof Word>;

const Transcript = z.object({
  text: z.string(),
  language_code: z.string(),
  words: z.array(Word),
  transcription_id: z.string().nullish(),
});

export interface SttResult {
  text: string;
  languageCode: string;
  words: SttWord[];
}

export interface SpeechToTextApi {
  /** Transcribes one audio file. Throws ElevenLabsError when it can't. */
  transcribe(audio: Buffer, filename: string, mimeType: string): Promise<SttResult>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createElevenLabs(
  env: Pick<Env, 'ELEVENLABS_API_KEY'>,
  options: { fetch?: typeof fetch; baseDelayMs?: number } = {},
): SpeechToTextApi {
  const doFetch = options.fetch ?? fetch;
  const baseDelayMs = options.baseDelayMs ?? 1_000;
  const key = env.ELEVENLABS_API_KEY;
  if (!key) throw new ElevenLabsError('ELEVENLABS_API_KEY is not set');

  async function forget(id: string): Promise<void> {
    try {
      const response = await doFetch(`${BASE}/v1/speech-to-text/transcripts/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { 'xi-api-key': key! },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) log.warn('ElevenLabs did not delete a transcript', { status: response.status });
    } catch (error) {
      log.warn('could not ask ElevenLabs to delete a transcript', { error });
    }
  }

  return {
    async transcribe(audio, filename, mimeType) {
      let lastError: unknown;
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        const form = new FormData();
        form.append('model_id', STT_MODEL);
        form.append('file', new Blob([audio], { type: mimeType }), filename);
        form.append('timestamps_granularity', 'word');
        form.append('no_verbatim', 'true'); // no "um", "uh" or false starts
        form.append('tag_audio_events', 'false');
        form.append('diarize', 'false'); // one speaker per file: Discord already told us who
        let response: Response;
        try {
          response = await doFetch(`${BASE}/v1/speech-to-text`, {
            method: 'POST',
            headers: { 'xi-api-key': key },
            body: form,
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
        } catch (error) {
          lastError = new ElevenLabsError(`ElevenLabs could not be reached (${error instanceof Error ? error.message : String(error)})`);
          if (attempt < ATTEMPTS) await sleep(baseDelayMs * 2 ** (attempt - 1));
          continue;
        }
        if (response.ok) {
          const parsed = Transcript.safeParse(await response.json().catch(() => undefined));
          if (!parsed.success) throw new ElevenLabsError('ElevenLabs returned a transcript in an unexpected shape');
          if (parsed.data.transcription_id) await forget(parsed.data.transcription_id);
          return { text: parsed.data.text, languageCode: parsed.data.language_code, words: parsed.data.words };
        }
        const detail = (await response.text().catch(() => '')).slice(0, 200);
        if (response.status === 401) throw new ElevenLabsError('ElevenLabs refused the API key');
        if (response.status === 402 || /quota|credits|exceeds your/i.test(detail)) throw new ElevenLabsError('ElevenLabs credits have run out');
        if (response.status === 400 || response.status === 422) throw new ElevenLabsError(`ElevenLabs could not read the audio (HTTP ${response.status})`);
        lastError = new ElevenLabsError(`ElevenLabs returned HTTP ${response.status}`);
        if (response.status !== 429 && response.status < 500) break;
        if (attempt < ATTEMPTS) {
          const retryAfter = Number(response.headers.get('retry-after'));
          await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * 2 ** (attempt - 1) + Math.random() * baseDelayMs);
        }
      }
      throw lastError instanceof Error ? lastError : new ElevenLabsError(String(lastError));
    },
  };
}
