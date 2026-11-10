import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ChannelType, Collection } from 'discord.js';
import { RecordId, type Surreal } from 'surrealdb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { callsFor } from '../../src/db/calls.js';
import { getProjectByName, type Project } from '../../src/db/projects.js';
import type { BotContext } from '../../src/discord/command.js';
import { CALL_SUMMARY_SYSTEM, TRANSCRIBE_SYSTEM } from '../../src/prompts/calls.js';
import { GeminiError, type GeminiApi, type JsonRequest } from '../../src/services/gemini.js';
import type { MemoryApi } from '../../src/services/memory.js';
import { callNotesText, consentText, createCallManager, type CallManager, type VoiceLink } from '../../src/voice/calls.js';
import { assembleTranscript, assignWords, buildSpeakerTrack, clock, planBatches } from '../../src/voice/transcribe.js';
import type { SpeechToTextApi } from '../../src/services/elevenlabs.js';
import { oggOpusFile } from '../../src/voice/ogg.js';
import { memoryDb } from '../helpers/db.js';
import { buttonInteraction, FakeGuild, type FakeChannel } from '../helpers/fakeDiscord.js';

const OWNER = { id: 'owner-1', name: 'furkanbeyler' };
const CLIENT = { id: 'client-1', name: 'Ayse' };
const STRANGER = { id: 'stranger-1', name: 'Someone' };

let db: Surreal;
let project: Project;
let guild: FakeGuild;
let text: FakeChannel;
const remembered: string[] = [];
let geminiFails = false;
const geminiCalls: string[] = [];

const gemini: GeminiApi = {
  async json<T>(request: JsonRequest<T>): Promise<T> {
    geminiCalls.push(request.system === TRANSCRIBE_SYSTEM ? 'transcribe' : 'summary');
    if (geminiFails) throw new GeminiError('Gemini is having a moment');
    const input = request.input[0]!.type === 'text' ? request.input[0]!.text : '';
    if (request.system === TRANSCRIBE_SYSTEM) {
      expect(request.input.slice(1).every((part) => part.type === 'audio' && part.mime_type === 'audio/ogg')).toBe(true);
      const segments = [...input.matchAll(/Segment (\d+): (\S+)/g)].map(([, n, name]) => ({ n: Number(n), text: `${name} says line ${n}.` }));
      return request.parse.parse({ segments });
    }
    expect(request.system).toBe(CALL_SUMMARY_SYSTEM);
    expect(input).toContain('<transcript>');
    return request.parse.parse({ summary: 'They agreed the booking flow.', decisions: ['Use Stripe for deposits'], action_items: [{ who: 'client', what: 'Send the logo by Friday' }], open_questions: ['Opening hours on holidays?'] });
  },
};
const memory: MemoryApi = {
  async remember(_scope, line) {
    remembered.push(line);
  },
  async recall() {
    return '';
  },
};

/** A fake voice connection: the test plays each person's audio. */
class FakeVoice {
  readonly speaking = Object.assign(new EventEmitter(), { users: new Map<string, number>() });
  readonly streams = new Map<string, PassThrough>();
  readonly subscribed: string[] = [];
  destroyed = false;
  lost?: () => void;
  readonly link: VoiceLink = {
    receiver: {
      speaking: this.speaking,
      subscribe: (userId: string) => {
        this.subscribed.push(userId);
        const stream = new PassThrough({ objectMode: true });
        this.streams.set(userId, stream);
        return stream;
      },
    },
    destroy: () => {
      this.destroyed = true;
    },
    onLost: (handler) => {
      this.lost = handler;
    },
  };

  /** Someone talks for `seconds`, then goes quiet (the stream ends after the silence). */
  talk(userId: string, seconds: number): void {
    this.speaking.emit('start', userId);
    const stream = this.streams.get(userId);
    if (!stream || !this.subscribed.includes(userId) || stream.writableEnded) return;
    for (let i = 0; i < seconds * 50; i++) stream.write(Buffer.concat([Buffer.from([0xfc]), Buffer.alloc(59, i % 200)]));
    stream.end();
    this.streams.delete(userId);
  }
}

const voiceChannel = (members: Array<{ id: string; bot: boolean }>) => ({
  id: 'voice-1',
  members: new Collection(members.map((member) => [member.id, { id: member.id, user: { bot: member.bot } }])),
});

function manager(fake: FakeVoice, members = [{ id: OWNER.id, bot: false }], extra: { emptyGraceMs?: number; stt?: SpeechToTextApi } = {}): CallManager {
  const ctx = {
    env: { DISCORD_OWNER_ID: OWNER.id, DISCORD_GUILD_ID: guild.id },
    db,
    gemini,
    memory,
    ...(extra.stt ? { stt: extra.stt } : {}),
  } as unknown as BotContext;
  return createCallManager(ctx, {
    join: async () => fake.link,
    ensureVoice: (async () => voiceChannel(members)) as never,
    emptyGraceMs: extra.emptyGraceMs ?? 60_000,
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const consentId = (answer: 'yes' | 'no') => text.history.find((message) => message.customIds.length)!.customIds.find((id) => id.includes(`:${answer}:`))!;

beforeAll(async () => {
  db = await memoryDb();
  guild = new FakeGuild('guild-1', 'bot-1');
  text = guild.addChannel('alpha', ChannelType.GuildText);
  await db.query('CREATE $id CONTENT $c', {
    id: new RecordId('project', 'alpha'),
    c: { name: 'alpha', channel_id: text.id, repo: 'o/alpha', stage: 'in_development', client_id: CLIENT.id },
  });
  project = (await getProjectByName(db, 'alpha'))!;
});
afterAll(async () => {
  await db.close();
});
beforeEach(() => {
  text.history.length = 0;
  remembered.length = 0;
  geminiCalls.length = 0;
  geminiFails = false;
});

describe('a recorded call', () => {
  it('records only people who agreed, then posts notes and a transcript and saves the call', async () => {
    const fake = new FakeVoice();
    const calls = manager(fake);
    await calls.start(project, text as never);
    expect(calls.activeProject()).toBe('alpha');
    expect(text.history[0]!.content).toContain('**Only people who press "Record me" are recorded.**');
    expect(text.history[0]!.content).toContain(`<@${CLIENT.id}>: ⏳`);

    fake.talk(OWNER.id, 2);
    fake.talk(CLIENT.id, 3); // before agreeing: never subscribed to
    expect(fake.subscribed).toEqual([OWNER.id]);

    const stranger = buttonInteraction(guild, text, STRANGER, consentId('yes'));
    await expect(calls.onConsent(stranger as never)).rejects.toThrow("this project's client are asked");
    const yes = buttonInteraction(guild, text, CLIENT, consentId('yes'));
    await calls.onConsent(yes as never);
    expect(yes.replies[0]!.content).toContain(`<@${CLIENT.id}>: ✅ being recorded`);

    await tick();
    fake.talk(CLIENT.id, 1);
    fake.talk(OWNER.id, 0.2); // a cough: too short to transcribe
    expect(await calls.stop('other-project', 'test')).toBe(false);
    expect(await calls.stop('alpha', 'Furkan ended it')).toBe(true);
    expect(fake.destroyed).toBe(true);
    expect(calls.activeProject()).toBeUndefined();
    expect(text.history[0]!.content).toContain('The call has ended (Furkan ended it).');
    expect(text.history[0]!.customIds).toEqual([]);
    await calls.idle();

    const notes = text.history.at(-1)!;
    expect(notes.content).toContain('📝 **Call notes**');
    expect(notes.content).toContain('**Decisions**\n- Use Stripe for deposits');
    expect(notes.content).toContain('Client: Send the logo by Friday'); // the fake server has no display names
    expect(notes.content).toContain('AI-written from the call recording');
    expect(notes.files[0]).toMatch(/^call-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-transcript\.md$/);

    const [saved] = await callsFor(db, project);
    expect(saved!.transcript.split('\n')).toEqual([
      expect.stringMatching(/^\[00:00:00\] Furkan \(owner\): Furkan says line 1\.$/),
      expect.stringMatching(/^\[00:00:0\d\] Client \(client\): Client says line 2\.$/),
    ]);
    expect(saved!.participants).toEqual([
      { user_id: OWNER.id, name: 'Furkan', role: 'owner', recorded: true },
      { user_id: CLIENT.id, name: 'Client', role: 'client', recorded: true },
    ]);
    expect(saved!.segments).toBe(2);
    expect(remembered).toContain(`Decided in the call on ${saved!.started_at.toISOString().slice(0, 16).replace('T', ' ')} UTC: Use Stripe for deposits`);

    const [events] = await db.query<[Array<{ action: string; actor: string }>]>('SELECT action, actor FROM event WHERE project = $p ORDER BY at', { p: project.id });
    expect(events.map((event) => `${event.actor} ${event.action}`)).toEqual(['owner call.started', 'client call.consent', 'owner call.ended', 'owner call.recorded']);
  });

  it("drops what someone said once they withdraw, and says so when nothing is left", async () => {
    const fake = new FakeVoice();
    const calls = manager(fake);
    await calls.start(project, text as never);
    await calls.onConsent(buttonInteraction(guild, text, OWNER, consentId('no')) as never);
    fake.talk(OWNER.id, 2);
    await calls.stop('alpha', 'test');
    await calls.idle();
    expect(text.botText().at(-1)).toContain('Nothing was recorded');
    expect(geminiCalls).toEqual([]);
  });

  it('keeps a call that could not be transcribed, tells Furkan, and transcribes it on retry', async () => {
    const fake = new FakeVoice();
    const calls = manager(fake);
    await calls.start(project, text as never);
    fake.talk(OWNER.id, 1);
    geminiFails = true;
    await calls.stop('alpha', 'test');
    await calls.idle();
    expect(text.botText().at(-1)).toContain("couldn't be transcribed just now");
    expect(guild.channelNamed('owner-desk').botText().at(-1)).toContain('/call retry');
    geminiFails = false;
    const before = (await callsFor(db, project)).length;
    expect(calls.retry('alpha')).toBe(true);
    await calls.idle();
    expect(await callsFor(db, project)).toHaveLength(before + 1);
    expect(calls.retry('alpha')).toBe(false);
  });

  it('ends by itself when everyone has left, and allows one call at a time', async () => {
    const fake = new FakeVoice();
    const calls = manager(fake, [], { emptyGraceMs: 20 });
    await calls.start(project, text as never);
    await expect(calls.start(project, text as never)).rejects.toThrow('already being recorded here');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls.activeProject()).toBeUndefined();
    expect(text.history[0]!.content).toContain('everyone left the voice channel');
    await calls.idle();
  });
});

describe('a call transcribed by ElevenLabs', () => {
  /** A fake ElevenLabs: says which file it got, and answers with timed words for one turn. */
  function fakeStt(fail = false) {
    const files: Buffer[] = [];
    const stt: SpeechToTextApi = {
      async transcribe(audio) {
        files.push(audio);
        if (fail) throw new Error('ElevenLabs credits have run out');
        const n = files.length;
        return { text: '', languageCode: 'en', words: [
          { text: `Speaker${n}`, type: 'word', start: 0.1, end: 0.5 },
          { text: ' ', type: 'spacing', start: 0.5, end: 0.6 },
          { text: '(laughs)', type: 'audio_event', start: 0.6, end: 0.9 },
          { text: 'here.', type: 'word', start: 0.9, end: 1.2 },
        ] };
      },
    };
    return { stt, files };
  }

  it('sends one file per speaker, and marks the notes and record as ElevenLabs', async () => {
    const fake = new FakeVoice();
    const { stt, files } = fakeStt();
    const calls = manager(fake, [{ id: OWNER.id, bot: false }], { stt });
    await calls.start(project, text as never);
    await calls.onConsent(buttonInteraction(guild, text, CLIENT, consentId('yes')) as never);
    await tick();
    fake.talk(OWNER.id, 1);
    fake.talk(CLIENT.id, 1);
    fake.talk(OWNER.id, 1);
    await calls.stop('alpha', 'test');
    await calls.idle();
    expect(files).toHaveLength(2);
    expect(files.every((file) => file.subarray(0, 4).toString() === 'OggS')).toBe(true);
    expect(geminiCalls).toEqual(['summary']); // no Gemini transcription
    expect(text.history.at(-1)!.content).toContain('transcribed by ElevenLabs, summarised by Gemini');
    const saved = (await callsFor(db, project)).at(-1)!;
    expect(saved.model).toMatch(/^elevenlabs\/scribe_v2 \+ /);
    expect(saved.transcript).toContain('Speaker1 here.');
    expect(saved.transcript).not.toContain('(laughs)');
  });

  it('falls back to Gemini when ElevenLabs fails, and tells Furkan', async () => {
    const fake = new FakeVoice();
    const { stt } = fakeStt(true);
    const calls = manager(fake, [{ id: OWNER.id, bot: false }], { stt });
    await calls.start(project, text as never);
    fake.talk(OWNER.id, 1);
    await calls.stop('alpha', 'test');
    await calls.idle();
    expect(geminiCalls).toEqual(['transcribe', 'summary']);
    expect(guild.channelNamed('owner-desk').botText().at(-1)).toContain("ElevenLabs couldn't transcribe the call");
    expect(text.history.at(-1)!.content).toContain('transcribed by Gemini');
  });
});

describe('call wording and transcripts', () => {
  it("joins a speaker's turns with a second of silence, and puts each word back in its turn", () => {
    const frame = Buffer.from([0xfc, 1, 2]); // 20 ms
    const track = buildSpeakerTrack([
      { n: 1, packets: Array(100).fill(frame), seconds: 2 },
      { n: 4, packets: Array(50).fill(frame), seconds: 1 },
    ]);
    expect(track.ranges).toEqual([
      { n: 1, start: 0, end: 2 },
      { n: 4, start: 3, end: 4 },
    ]);
    expect(track.packets).toHaveLength(100 + 50 + 50);
    expect(oggOpusFile(track.packets).length).toBeGreaterThan(0);
    const texts = assignWords(
      [
        { text: 'Hello', type: 'word', start: 0.2 },
        { text: ' ', type: 'spacing', start: 0.6 },
        { text: 'there.', type: 'word', start: 1.9 },
        { text: ' ', type: 'spacing', start: 2.4 },
        { text: '(cough)', type: 'audio_event', start: 2.6 },
        { text: 'Second', type: 'word', start: 3.1 },
        { text: ' ', type: 'spacing' },
        { text: 'turn.', type: 'word', start: 3.6 },
      ],
      track.ranges,
    );
    expect(texts).toEqual(new Map([
      [1, 'Hello there.'],
      [4, 'Second turn.'],
    ]));
  });

  it('formats clock times and merges a speaker\'s close turns', () => {
    expect(clock(3725.9)).toBe('01:02:05');
    const speakers = new Map([
      ['o', { name: 'Furkan', role: 'owner' as const }],
      ['c', { name: 'Ayse', role: 'client' as const }],
    ]);
    const transcript = assembleTranscript(
      [
        { n: 1, userId: 'o', offsetSeconds: 1, seconds: 2 },
        { n: 2, userId: 'o', offsetSeconds: 4, seconds: 1 },
        { n: 3, userId: 'c', offsetSeconds: 6, seconds: 2 },
        { n: 4, userId: 'c', offsetSeconds: 20, seconds: 1 },
        { n: 5, userId: 'o', offsetSeconds: 25, seconds: 1 },
      ],
      new Map([
        [1, 'Hello.'],
        [2, 'Can you hear me?'],
        [3, 'Yes.'],
        [4, 'One more thing.'],
        [5, ''],
      ]),
      speakers,
    );
    expect(transcript).toBe('[00:00:01] Furkan (owner): Hello. Can you hear me?\n[00:00:06] Ayse (client): Yes.\n[00:00:20] Ayse (client): One more thing.');
  });

  it('splits turns into requests that fit Gemini', () => {
    const turns = Array.from({ length: 5 }, () => ({ ogg: Buffer.alloc(400) }));
    expect(planBatches(turns, { maxSegments: 2, maxBytes: 10_000 }).map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(planBatches(turns, { maxSegments: 10, maxBytes: 1_000 }).map((batch) => batch.length)).toEqual([2, 2, 1]);
  });

  it('asks for consent plainly and marks notes as AI-written', () => {
    const people = [
      { userId: 'o', name: 'Furkan', role: 'owner' as const },
      { userId: 'c', name: 'Ayse', role: 'client' as const },
    ];
    const asking = consentText('alpha', 'v1', people, new Map([['o', 'yes']]));
    expect(asking).toContain('The audio itself is deleted once it\'s transcribed.');
    expect(asking).toContain('- Furkan: ✅ being recorded\n- <@c>: ⏳');
    const notes = callNotesText(
      { summary: 'Short call.', decisions: [], action_items: [{ who: 'both', what: 'Meet on Monday' }], open_questions: [] },
      { startedAt: new Date('2026-11-12T14:00:00Z'), endedAt: new Date('2026-11-12T14:20:00Z'), clientName: 'Ayse' },
    );
    expect(notes).toContain('20 min');
    expect(notes).not.toContain('**Decisions**');
    expect(notes).toContain('Both: Meet on Monday');
    expect(notes).toMatch(/-# AI-written/);
  });
});
