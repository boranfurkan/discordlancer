// Recorded project calls: Boran starts one with /call start, the bot joins the project's
// voice channel and asks each person to agree to be recorded, and when the call ends
// it transcribes it, saves it, and posts the notes and transcript in the channel.
//
// The bot can be in one voice channel per server, so there is at most one call at a time.

import { entersState, joinVoiceChannel, VoiceConnectionStatus } from '@discordjs/voice';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction,
  type Guild,
  type Message,
  type TextChannel,
  type VoiceChannel,
  type VoiceState,
} from 'discord.js';
import { callLabel, saveCall, type Call, type Participant } from '../db/calls.js';
import { latestSpec } from '../db/deals.js';
import { recordEvent } from '../db/events.js';
import type { Project } from '../db/projects.js';
import { log } from '../log.js';
import type { CallSummary } from '../prompts/calls.js';
import { GeminiError, SPEC_MODEL } from '../services/gemini.js';
import { projectScope, safeRemember } from '../services/memory.js';
import { ensureOwnerChannel, ensureProjectVoice } from '../discord/channels.js';
import { safeRecord } from '../discord/client.js';
import { UserError, type BotContext } from '../discord/command.js';
import { OWNER_NAME } from '../discord/guards.js';
import { fitMessage } from '../discord/texts.js';
import { CallRecorder, type ReceiverLike } from './recorder.js';
import { assembleTranscript, CALL_PROMPT_VERSION, prepareSegments, summariseCall, transcribeSegments, type Segment, type Speaker } from './transcribe.js';

export const CONSENT_PREFIX = 'call-consent:';
export const MAX_CALL_MINUTES = 120;
/** With nobody left in the voice channel for this long, the call ends by itself. */
export const EMPTY_CALL_GRACE_MS = 2 * 60_000;

export interface VoiceLink {
  receiver: ReceiverLike;
  destroy(): void;
  /** Called once if the connection drops and can't recover. */
  onLost(handler: () => void): void;
}
export type JoinVoice = (channel: VoiceChannel) => Promise<VoiceLink>;

/** Joins with @discordjs/voice: deafened off (to hear), muted (it never speaks). */
export async function joinWithDiscord(channel: VoiceChannel): Promise<VoiceLink> {
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true,
  });
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (error) {
    log.warn('could not join a voice channel', { error });
    connection.destroy();
    throw new UserError("The bot couldn't join the voice channel. Please try again in a minute.");
  }
  let lost: (() => void) | undefined;
  connection.on(VoiceConnectionStatus.Disconnected, () => {
    // A move or a brief network drop reconnects by itself within a few seconds.
    Promise.race([entersState(connection, VoiceConnectionStatus.Signalling, 5_000), entersState(connection, VoiceConnectionStatus.Connecting, 5_000)]).catch(() => lost?.());
  });
  connection.on('error', (error) => log.warn('voice connection error', { error }));
  return {
    receiver: connection.receiver,
    destroy: () => {
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
    },
    onLost: (handler) => {
      lost = handler;
    },
  };
}

type Consent = 'yes' | 'no';

interface Person extends Speaker {
  userId: string;
}

interface Recording {
  id: string;
  project: Project;
  text: TextChannel;
  startedAt: Date;
  endedAt: Date;
  segments: Segment[];
  people: Map<string, Person>;
  consent: Map<string, Consent>;
}

interface ActiveCall {
  id: string;
  project: Project;
  text: TextChannel;
  voice: VoiceChannel;
  link: VoiceLink;
  recorder: CallRecorder;
  people: Map<string, Person>;
  consent: Map<string, Consent>;
  message?: Message;
  timers: { max?: NodeJS.Timeout; empty?: NodeJS.Timeout };
}

// ---- Wording (pure) --------------------------------------------------------

/** Pure: the consent message, with each person's answer. */
export function consentText(projectName: string, voiceId: string, people: readonly Person[], consent: ReadonlyMap<string, Consent>, ended?: string): string {
  const status = (person: Person) => {
    const answer = consent.get(person.userId);
    if (answer === 'yes') return '✅ being recorded';
    if (answer === 'no') return '❌ not recorded';
    return "⏳ hasn't answered (not recorded until they agree)";
  };
  const who = (person: Person) => (person.role === 'owner' ? OWNER_NAME : `<@${person.userId}>`);
  return [
    `📞 **Call recording for ${projectName}**`,
    ended
      ? `The call has ended (${ended}).`
      : `Join <#${voiceId}> to talk. The bot records the call for the project notes: it transcribes what each person says, then posts a summary and the transcript here. The audio itself is deleted once it's transcribed.`,
    '',
    ...(ended ? [] : ['**Only people who press "Record me" are recorded.** Anyone else is not recorded at all.']),
    ...people.map((person) => `- ${who(person)}: ${status(person)}`),
  ].join('\n');
}

const minutes = (from: Date, to: Date) => Math.max(1, Math.round((to.getTime() - from.getTime()) / 60_000));

/** Pure: the notes posted after a call. Always marked as AI-written. */
export function callNotesText(summary: CallSummary, meta: { startedAt: Date; endedAt: Date; clientName: string }): string {
  const whoDoes = { owner: OWNER_NAME, client: meta.clientName, both: 'Both' } as const;
  const list = (items: readonly string[]) => items.map((item) => `- ${item}`).join('\n');
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short' }).format(meta.startedAt);
  const parts = [
    `📝 **Call notes**: ${day} (London), ${minutes(meta.startedAt, meta.endedAt)} min`,
    summary.summary,
    summary.decisions.length ? `**Decisions**\n${list(summary.decisions)}` : '',
    summary.action_items.length ? `**Action items**\n${list(summary.action_items.map((item) => `${whoDoes[item.who]}: ${item.what}`))}` : '',
    summary.open_questions.length ? `**Open questions**\n${list(summary.open_questions)}` : '',
    "-# AI-written from the call recording (Gemini). The full transcript is attached. If anything here is wrong, say so in this channel and it'll be corrected.",
  ];
  return fitMessage(parts.filter(Boolean).join('\n\n'));
}

/** Pure: the transcript file attached to the notes. */
export function transcriptFile(projectName: string, call: Pick<Call, 'started_at' | 'ended_at' | 'transcript' | 'participants'>): string {
  const recorded = call.participants.filter((person) => person.recorded).map((person) => person.name);
  const notRecorded = call.participants.filter((person) => !person.recorded).map((person) => person.name);
  return [
    `# Call transcript: ${projectName}, ${callLabel(call)} UTC`,
    '',
    `Length: ${minutes(call.started_at, call.ended_at)} min. Recorded: ${recorded.join(', ') || 'nobody'}.${notRecorded.length ? ` Not recorded: ${notRecorded.join(', ')}.` : ''}`,
    'Transcribed by AI (Gemini) from the recording; times are from the start of the call. The audio was deleted after transcription.',
    '',
    call.transcript,
    '',
  ].join('\n');
}

function consentButtons(callId: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${CONSENT_PREFIX}yes:${callId}`).setLabel('Record me').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${CONSENT_PREFIX}no:${callId}`).setLabel("Don't record me").setStyle(ButtonStyle.Secondary),
  );
}

// ---- The manager -----------------------------------------------------------

export interface CallManager {
  /** Joins the project's voice channel and asks for consent. Throws UserError when it can't. */
  start(project: Project, text: TextChannel): Promise<VoiceChannel>;
  /** Ends this project's call and transcribes it in the background. False if there is none. */
  stop(projectName: string, reason: string): Promise<boolean>;
  /** Tries again to transcribe this project's call that failed. False if there is none. */
  retry(projectName: string): boolean;
  onConsent(interaction: ButtonInteraction<'cached'>): Promise<void>;
  onVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void;
  /** The project with a call being recorded, if any. */
  activeProject(): string | undefined;
  /** Resolves when background transcriptions have finished (for tests and shutdown). */
  idle(): Promise<void>;
}

export interface CallOptions {
  join?: JoinVoice;
  ensureVoice?: typeof ensureProjectVoice;
  now?: () => Date;
  maxMinutes?: number;
  emptyGraceMs?: number;
}

export function createCallManager(ctx: BotContext, options: CallOptions = {}): CallManager {
  const join = options.join ?? joinWithDiscord;
  const ensureVoice = options.ensureVoice ?? ensureProjectVoice;
  const now = options.now ?? (() => new Date());
  const ownerId = ctx.env.DISCORD_OWNER_ID;
  let current: ActiveCall | undefined;
  let failed: Recording | undefined;
  const pending = new Set<Promise<void>>();

  const roleOf = (project: Project, userId: string): Person['role'] => (userId === ownerId ? 'owner' : userId === project.client_id ? 'client' : 'other');

  async function displayName(guild: Guild, userId: string): Promise<string> {
    if (userId === ownerId) return OWNER_NAME;
    const member = await guild.members.fetch(userId).catch(() => undefined);
    return member?.displayName ?? member?.user?.username ?? 'Client';
  }

  async function refreshConsentMessage(call: ActiveCall, ended?: string): Promise<void> {
    const content = consentText(call.project.name, call.voice.id, [...call.people.values()], call.consent, ended);
    await call.message?.edit({ content, components: ended ? [] : [consentButtons(call.id)], allowedMentions: { parse: [] } }).catch((error: unknown) => {
      log.warn('could not update the call consent message', { error });
    });
  }

  function checkEmpty(): void {
    const call = current;
    if (!call) return;
    const humans = call.voice.members.filter((member) => !member.user.bot).size;
    if (humans > 0) {
      clearTimeout(call.timers.empty);
      call.timers.empty = undefined;
    } else if (!call.timers.empty) {
      call.timers.empty = setTimeout(() => void manager.stop(call.project.name, 'everyone left the voice channel'), options.emptyGraceMs ?? EMPTY_CALL_GRACE_MS);
      call.timers.empty.unref?.();
    }
  }

  async function processRecording(recording: Recording): Promise<void> {
    const { project, text } = recording;
    const base = { actor: 'owner', actorId: ownerId, project: project.id } as const;
    try {
      const recorded = recording.segments.filter((segment) => recording.consent.get(segment.userId) === 'yes');
      const prepared = prepareSegments(recorded, recording.startedAt);
      if (prepared.length === 0) {
        await text.send({ content: 'The call ended. Nothing was recorded: there was no speech from anyone who agreed to be recorded.', allowedMentions: { parse: [] } });
        await safeRecord(ctx, { ...base, action: 'call.empty', outcome: 'ok', data: { call_id: recording.id } });
        return;
      }
      const speakers = new Map([...recording.people].map(([userId, person]) => [userId, { name: person.name, role: person.role }]));
      const texts = await transcribeSegments(ctx.gemini, prepared, speakers);
      const transcript = assembleTranscript(prepared, texts, speakers);
      if (!transcript) {
        await text.send({ content: "The call ended, but no speech could be made out in the recording, so there are no notes.", allowedMentions: { parse: [] } });
        await safeRecord(ctx, { ...base, action: 'call.empty', outcome: 'ok', data: { call_id: recording.id, reason: 'no speech transcribed' } });
        return;
      }
      const spec = await latestSpec(ctx.db, project);
      const summary = await summariseCall(ctx.gemini, transcript, spec?.markdown);
      const participants: Participant[] = [...recording.people.values()].map((person) => ({
        user_id: person.userId,
        name: person.name,
        role: person.role,
        recorded: recording.consent.get(person.userId) === 'yes',
      }));
      const speechSeconds = prepared.reduce((sum, segment) => sum + segment.seconds, 0);
      const call = await saveCall(
        ctx.db,
        project,
        { startedAt: recording.startedAt, endedAt: recording.endedAt, participants, transcript, summary, speechSeconds, segments: prepared.length, model: SPEC_MODEL, promptVersion: CALL_PROMPT_VERSION },
        { actor: 'owner', actorId: ownerId, action: 'call.recorded', outcome: 'ok', data: { minutes: minutes(recording.startedAt, recording.endedAt), segments: prepared.length, model: SPEC_MODEL, prompt_version: CALL_PROMPT_VERSION } },
      );
      const clientName = participants.find((person) => person.role === 'client')?.name ?? 'Client';
      await text.send({
        content: callNotesText(summary, { startedAt: call.started_at, endedAt: call.ended_at, clientName }),
        files: [new AttachmentBuilder(Buffer.from(transcriptFile(project.name, call)), { name: `call-${callLabel(call).replace(/[ :]/g, '-')}-transcript.md` })],
        allowedMentions: { parse: [] },
      });
      const remembered = [
        `Call on ${callLabel(call)} UTC: ${summary.summary}`,
        ...summary.decisions.map((decision) => `Decided in the call on ${callLabel(call)} UTC: ${decision}`),
        ...summary.action_items.map((item) => `Action item from the call on ${callLabel(call)} UTC (${item.who}): ${item.what}`),
      ];
      for (const line of remembered) await safeRemember(ctx.memory, projectScope(project.name), line);
    } catch (error) {
      failed = recording;
      const known = error instanceof GeminiError || error instanceof UserError;
      log.error('could not process a call', { project: project.name, error });
      await text
        .send({ content: `The call ended, but it couldn't be transcribed just now. ${OWNER_NAME} has been told and will try again.`, allowedMentions: { parse: [] } })
        .catch(() => undefined);
      await safeRecord(ctx, { ...base, action: 'call.failed', outcome: 'failed', data: { call_id: recording.id, reason: known ? (error as Error).message : 'internal error' } });
      try {
        const desk = await ensureOwnerChannel(text.guild, ownerId);
        await desk.send(`**${project.name}**: the call couldn't be transcribed${known ? ` (${(error as Error).message})` : ''}. Run \`/call retry\` in <#${text.id}> to try again. The audio is kept until the bot restarts.`);
      } catch (deskError) {
        log.warn('could not tell the owner about a failed call', { error: deskError });
      }
    }
  }

  function inBackground(work: Promise<void>): void {
    pending.add(work);
    void work.finally(() => pending.delete(work));
  }

  const manager: CallManager = {
    async start(project, text) {
      if (current) {
        throw new UserError(
          current.project.name === project.name
            ? `A call is already being recorded here, in <#${current.voice.id}>.`
            : `The bot is recording a call for **${current.project.name}** right now. End it with /call stop in that channel first.`,
        );
      }
      const voice = await ensureVoice(text.guild, project.name, ownerId, project.client_id);
      const link = await join(voice);
      const id = crypto.randomUUID().slice(0, 8);
      const people = new Map<string, Person>([[ownerId, { userId: ownerId, name: OWNER_NAME, role: 'owner' }]]);
      if (project.client_id) people.set(project.client_id, { userId: project.client_id, name: await displayName(text.guild, project.client_id), role: 'client' });
      const call: ActiveCall = {
        id,
        project,
        text,
        voice,
        link,
        recorder: new CallRecorder(link.receiver, { now, onLimit: () => void manager.stop(project.name, 'the recording limit was reached') }),
        people,
        // Starting the call is Boran's agreement to be recorded; he can still opt out.
        consent: new Map([[ownerId, 'yes']]),
        timers: {},
      };
      call.recorder.allow(ownerId);
      current = call;
      link.onLost(() => void manager.stop(project.name, 'the bot lost its connection to the call'));
      call.timers.max = setTimeout(() => void manager.stop(project.name, `it reached ${options.maxMinutes ?? MAX_CALL_MINUTES} minutes`), (options.maxMinutes ?? MAX_CALL_MINUTES) * 60_000);
      call.timers.max.unref?.();
      call.message = await text.send({
        content: consentText(project.name, voice.id, [...people.values()], call.consent),
        components: [consentButtons(id)],
        allowedMentions: { users: project.client_id ? [project.client_id] : [] },
      });
      checkEmpty();
      await safeRecord(ctx, { actor: 'owner', actorId: ownerId, action: 'call.started', outcome: 'ok', project: project.id, data: { call_id: id, voice_channel: voice.id } });
      return voice;
    },

    async stop(projectName, reason) {
      const call = current;
      if (!call || call.project.name !== projectName) return false;
      current = undefined;
      clearTimeout(call.timers.max);
      clearTimeout(call.timers.empty);
      const segments = call.recorder.stop();
      call.link.destroy();
      await refreshConsentMessage(call, reason);
      await call.text.send({ content: `The call has ended (${reason}). Transcribing it now; the notes will appear here.`, allowedMentions: { parse: [] } }).catch(() => undefined);
      await safeRecord(ctx, { actor: 'owner', actorId: ownerId, action: 'call.ended', outcome: 'ok', project: call.project.id, data: { call_id: call.id, reason, turns: segments.length } });
      inBackground(
        processRecording({ id: call.id, project: call.project, text: call.text, startedAt: call.recorder.startedAt, endedAt: now(), segments, people: call.people, consent: call.consent }),
      );
      return true;
    },

    retry(projectName) {
      if (!failed || failed.project.name !== projectName) return false;
      const recording = failed;
      failed = undefined;
      inBackground(processRecording(recording));
      return true;
    },

    async onConsent(interaction) {
      const [, answer, callId] = interaction.customId.split(':');
      const call = current;
      if (!call || call.id !== callId) throw new UserError('That call has ended.');
      const userId = interaction.user.id;
      const role = roleOf(call.project, userId);
      if (role === 'other') throw new UserError(`Only ${OWNER_NAME} and this project's client are asked.`);
      const consent: Consent = answer === 'yes' ? 'yes' : 'no';
      if (!call.people.has(userId)) call.people.set(userId, { userId, name: await displayName(interaction.guild, userId), role });
      call.consent.set(userId, consent);
      if (consent === 'yes') call.recorder.allow(userId);
      else call.recorder.forget(userId);
      await interaction.update({ content: consentText(call.project.name, call.voice.id, [...call.people.values()], call.consent), allowedMentions: { parse: [] } });
      await recordEvent(ctx.db, { actor: role, actorId: userId, action: 'call.consent', outcome: 'ok', project: call.project.id, data: { call_id: call.id, consent } }).catch((error: unknown) =>
        log.error('could not record call consent', { error }),
      );
    },

    onVoiceStateUpdate(oldState, newState) {
      const call = current;
      if (!call) return;
      const voiceId = call.voice.id;
      if (oldState.channelId !== voiceId && newState.channelId !== voiceId) return;
      const member = newState.member ?? oldState.member;
      if (member && !member.user.bot && newState.channelId === voiceId && !call.people.has(member.id)) {
        call.people.set(member.id, { userId: member.id, name: member.id === ownerId ? OWNER_NAME : member.displayName, role: roleOf(call.project, member.id) });
        void refreshConsentMessage(call);
      }
      checkEmpty();
    },

    activeProject: () => current?.project.name,

    async idle() {
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
  return manager;
}

