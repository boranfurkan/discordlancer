// Turns a recorded call into a transcript and a summary. Each speaker's turn is its
// own Ogg file, so who said what is known from Discord, not guessed by the model.

import { CALL_SUMMARY_PROMPT_VERSION, CALL_SUMMARY_SCHEMA, CALL_SUMMARY_SYSTEM, CallSummary, TRANSCRIBE_PROMPT_VERSION, TRANSCRIBE_SCHEMA, TRANSCRIBE_SYSTEM, TranscribeOutput } from '../prompts/calls.js';
import type { SpeechToTextApi, SttWord } from '../services/elevenlabs.js';
import { SPEC_MODEL, type GeminiApi, type Part } from '../services/gemini.js';
import { oggOpusFile, opusPacketSamples } from './ogg.js';

/** One speaker's turn: Opus packets from when they started talking until a second of silence. */
export interface Segment {
  userId: string;
  startedAt: Date;
  packets: Buffer[];
}

/** Turns shorter than this are coughs and clicks, not speech. */
export const MIN_SEGMENT_SECONDS = 0.6;
/** Per Gemini request: the whole request must stay under 20 MB, and base64 adds a third. */
export const BATCH_LIMITS = { maxSegments: 40, maxBytes: 10 * 1024 * 1024 };
/** Same speaker again within this many seconds: one line in the transcript. */
const MERGE_GAP_SECONDS = 3;

export const segmentSeconds = (segment: Pick<Segment, 'packets'>) =>
  segment.packets.reduce((sum, packet) => sum + opusPacketSamples(packet), 0) / 48_000;

export interface PreparedSegment {
  n: number;
  userId: string;
  offsetSeconds: number;
  seconds: number;
  packets: Buffer[];
  ogg: Buffer;
}

/** Pure: drops noise, orders by time, numbers the turns and wraps each in Ogg. */
export function prepareSegments(segments: readonly Segment[], callStart: Date): PreparedSegment[] {
  return [...segments]
    .filter((segment) => segmentSeconds(segment) >= MIN_SEGMENT_SECONDS)
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
    .map((segment, index) => ({
      n: index + 1,
      userId: segment.userId,
      offsetSeconds: Math.max(0, (segment.startedAt.getTime() - callStart.getTime()) / 1000),
      seconds: segmentSeconds(segment),
      packets: segment.packets,
      ogg: oggOpusFile(segment.packets),
    }));
}

/** Pure: groups segments into requests that fit Gemini's limits. */
export function planBatches<T extends { ogg: Buffer }>(segments: readonly T[], limits = BATCH_LIMITS): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const segment of segments) {
    if (current.length && (current.length >= limits.maxSegments || bytes + segment.ogg.length > limits.maxBytes)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(segment);
    bytes += segment.ogg.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

export function clock(seconds: number): string {
  const whole = Math.floor(seconds);
  return [Math.floor(whole / 3600), Math.floor((whole % 3600) / 60), whole % 60].map((part) => String(part).padStart(2, '0')).join(':');
}

export interface Speaker {
  name: string;
  role: 'owner' | 'client' | 'other';
}

const ROLE = { owner: 'owner', client: 'client', other: 'other' } as const;

/** Pure: the transcript, one line per turn, merging a speaker's turns that follow closely. */
export function assembleTranscript(
  segments: ReadonlyArray<Pick<PreparedSegment, 'n' | 'userId' | 'offsetSeconds' | 'seconds'>>,
  texts: ReadonlyMap<number, string>,
  speakers: ReadonlyMap<string, Speaker>,
): string {
  const lines: Array<{ userId: string; start: number; end: number; text: string }> = [];
  for (const segment of segments) {
    const text = (texts.get(segment.n) ?? '').trim();
    if (!text) continue;
    const last = lines.at(-1);
    if (last && last.userId === segment.userId && segment.offsetSeconds - last.end <= MERGE_GAP_SECONDS) {
      last.text = `${last.text} ${text}`;
      last.end = segment.offsetSeconds + segment.seconds;
    } else {
      lines.push({ userId: segment.userId, start: segment.offsetSeconds, end: segment.offsetSeconds + segment.seconds, text });
    }
  }
  return lines
    .map((line) => {
      const speaker = speakers.get(line.userId);
      return `[${clock(line.start)}] ${speaker?.name ?? 'Unknown'} (${ROLE[speaker?.role ?? 'other']}): ${line.text}`;
    })
    .join('\n');
}

/** Transcribes every turn, batch by batch. Throws GeminiError if Gemini fails. */
export async function transcribeSegments(
  gemini: GeminiApi,
  segments: readonly PreparedSegment[],
  speakers: ReadonlyMap<string, Speaker>,
): Promise<Map<number, string>> {
  const texts = new Map<number, string>();
  for (const batch of planBatches(segments)) {
    const list = batch.map((segment) => {
      const speaker = speakers.get(segment.userId);
      return `Segment ${segment.n}: ${speaker?.name ?? 'Unknown'} (${speaker?.role ?? 'other'}), at ${clock(segment.offsetSeconds)}, ${segment.seconds.toFixed(1)} s.`;
    });
    const input: Part[] = [
      { type: 'text', text: `${list.join('\n')}\nThe ${batch.length} audio parts below are segments ${batch[0]!.n} to ${batch.at(-1)!.n}, in order.` },
      ...batch.map((segment) => ({ type: 'audio' as const, data: segment.ogg.toString('base64'), mime_type: 'audio/ogg' })),
    ];
    const output = await gemini.json({ model: SPEC_MODEL, system: TRANSCRIBE_SYSTEM, input, schema: TRANSCRIBE_SCHEMA, parse: TranscribeOutput, thinking: 'low', maxOutputTokens: 32_000 });
    const wanted = new Set(batch.map((segment) => segment.n));
    for (const item of output.segments) if (wanted.has(item.n)) texts.set(item.n, item.text);
  }
  return texts;
}

export async function summariseCall(gemini: GeminiApi, transcript: string, spec?: string): Promise<CallSummary> {
  const input = [spec ? `<spec>\n${spec}\n</spec>` : 'There is no written spec yet.', `<transcript>\n${transcript}\n</transcript>`].join('\n\n');
  return gemini.json({ model: SPEC_MODEL, system: CALL_SUMMARY_SYSTEM, input: [{ type: 'text', text: input }], schema: CALL_SUMMARY_SCHEMA, parse: CallSummary, thinking: 'medium', maxOutputTokens: 8_000 });
}

export const CALL_PROMPT_VERSION = `${TRANSCRIBE_PROMPT_VERSION}+${CALL_SUMMARY_PROMPT_VERSION}`;

// ---- ElevenLabs: one file per speaker --------------------------------------

/** Discord's own Opus silence frame: 20 ms of nothing. */
const SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);
/** Silence put between a speaker's turns, so words fall clearly into one turn or the next. */
export const TURN_GAP_SECONDS = 1;

export interface SpeakerTrack {
  packets: Buffer[];
  /** Where each turn sits in the track, in seconds. */
  ranges: Array<{ n: number; start: number; end: number }>;
}

/** Pure: one speaker's turns, back to back with a second of silence between them. */
export function buildSpeakerTrack(segments: ReadonlyArray<Pick<PreparedSegment, 'n' | 'packets' | 'seconds'>>): SpeakerTrack {
  const packets: Buffer[] = [];
  const ranges: SpeakerTrack['ranges'] = [];
  let at = 0;
  segments.forEach((segment, index) => {
    if (index > 0) {
      for (let i = 0; i < TURN_GAP_SECONDS * 50; i++) packets.push(SILENCE_FRAME);
      at += TURN_GAP_SECONDS;
    }
    ranges.push({ n: segment.n, start: at, end: at + segment.seconds });
    packets.push(...segment.packets);
    at += segment.seconds;
  });
  return { packets, ranges };
}

/** Pure: puts each transcribed word back into the turn it was said in, by its time. */
export function assignWords(words: readonly SttWord[], ranges: SpeakerTrack['ranges']): Map<number, string> {
  const texts = new Map<number, string>(ranges.map((range) => [range.n, '']));
  const half = TURN_GAP_SECONDS / 2;
  let current = ranges[0]?.n;
  for (const word of words) {
    if (word.type === 'audio_event') continue;
    if (typeof word.start === 'number') {
      const range = ranges.find((candidate) => word.start! >= candidate.start - half && word.start! < candidate.end + half) ?? ranges.findLast((candidate) => word.start! >= candidate.start);
      if (range) current = range.n;
    }
    if (current === undefined) continue;
    texts.set(current, `${texts.get(current)}${word.type === 'spacing' ? ' ' : word.text}`);
  }
  for (const [n, text] of texts) texts.set(n, text.replace(/\s+/g, ' ').trim());
  return texts;
}

/** Transcribes with ElevenLabs: one request per speaker, words mapped back to turns. */
export async function transcribeWithElevenLabs(stt: SpeechToTextApi, segments: readonly PreparedSegment[]): Promise<Map<number, string>> {
  const bySpeaker = new Map<string, PreparedSegment[]>();
  for (const segment of segments) bySpeaker.set(segment.userId, [...(bySpeaker.get(segment.userId) ?? []), segment]);
  const texts = new Map<number, string>();
  const results = await Promise.all(
    [...bySpeaker.values()].map(async (turns) => {
      const track = buildSpeakerTrack(turns);
      const result = await stt.transcribe(oggOpusFile(track.packets), 'speaker.ogg', 'audio/ogg');
      return assignWords(result.words, track.ranges);
    }),
  );
  for (const result of results) for (const [n, text] of result) texts.set(n, text);
  return texts;
}
