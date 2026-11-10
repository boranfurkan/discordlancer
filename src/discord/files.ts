// Reads each file and link shared in a project channel once, when it is posted: 👀 while
// reading, ✅ once its notes are saved, and the notes posted in the project's 📎 Files
// thread. A file the bot can't read gets a short reply saying what would work. Specs,
// /ask, the docs and Claude Code's brief then use the saved notes.
//
// If the bot was down when something was posted, the next /create-specs, /sync-docs or
// /read-files reads it then.

import { createHash } from 'node:crypto';
import { ChannelType, type Client, type Message, type TextChannel } from 'discord.js';
import { fileNotesFor, linkSourceId, notedSources, saveFileNote, type FileNote } from '../db/files.js';
import { countEventsSince } from '../db/events.js';
import { clientMembers, getProjectByChannel, isClientMember, type Project } from '../db/projects.js';
import { londonDayStart } from '../domain/deadline.js';
import type { Stage } from '../domain/stages.js';
import { exportUrl, fetchPublic, findLinks, LinkError, unreadableApp } from '../files/links.js';
import { filePost, skippedReply } from '../files/noteText.js';
import { linkKind, readShared, skipReason, fileKind, type ReadResult } from '../files/read.js';
import { log } from '../log.js';
import { GeminiError } from '../services/gemini.js';
import { ensureOwnerChannel, ensureProjectThread } from './channels.js';
import { safeRecord } from './client.js';
import type { BotContext } from './command.js';
import { messagesSince } from './transcript.js';

/** Files and links read per project per London day. */
export const FILES_PER_DAY = 40;
export const FILE_READ_ACTION = 'file.read';
export const READ_STAGES: readonly Stage[] = ['created', 'joined', 'specs_agreed', 'quote_accepted', 'paid', 'in_development', 'delivered', 'support'];
/** How many files are read at the same time, across all projects. */
const PARALLEL = 2;

export interface SharedSource {
  sourceId: string;
  source: 'attachment' | 'link';
  name: string;
  contentType: string | null;
  size?: number | undefined;
  /** The attachment's download address, or the link. */
  url: string;
}

/** What the reader needs from a Discord message; tests give a fake. */
export interface SharedMessage {
  id: string;
  url: string;
  createdAt: Date;
  authorId: string;
  authorName: string;
  content: string;
  attachments: ReadonlyArray<{ id: string; name: string; contentType: string | null; size: number; url: string }>;
  react(emoji: string): Promise<void>;
  unreact(emoji: string): Promise<void>;
  reply(text: string): Promise<void>;
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** Pure: the files and links in a message the bot would read. */
export function sourcesOf(message: Pick<SharedMessage, 'id' | 'content' | 'attachments'>): SharedSource[] {
  return [
    ...message.attachments.map((attachment) => ({
      sourceId: attachment.id,
      source: 'attachment' as const,
      name: attachment.name,
      contentType: attachment.contentType,
      size: attachment.size,
      url: attachment.url,
    })),
    ...findLinks(message.content).map((link) => ({ sourceId: linkSourceId(message.id, link, sha), source: 'link' as const, name: link, contentType: null, url: link })),
  ];
}

export interface FileReaderDeps {
  download(url: string): Promise<Buffer>;
  fetchLink: typeof fetchPublic;
  /** Posts a note in the project's 📎 Files thread. */
  post(project: Project, text: string): Promise<void>;
  /** Tells Boran in owner-desk. */
  notifyOwner(text: string): Promise<void>;
  now?: () => Date;
}

export interface FileReader {
  /** Reads a message's files and links (those without notes yet). Never throws. */
  readMessage(project: Project, message: SharedMessage): Promise<{ read: number; skipped: number; failed: number; limited: boolean }>;
}

const role = (project: Project, ownerId: string, userId: string) => (userId === ownerId ? 'owner' : isClientMember(project, userId) ? 'client' : 'other');

const label = (role: 'owner' | 'client' | 'other', name: string) => (role === 'owner' ? 'Furkan (owner)' : role === 'client' ? `Client (${name})` : `Other member (${name})`);

/** Links the bot answers about when it can't read them; any other failed link is skipped quietly. */
const worthReplying = (source: SharedSource, reason: string) => source.source === 'attachment' || /sign-in|Figma|Loom|Miro|Canva|Google Drive/.test(reason);

export function createFileReader(ctx: BotContext, deps: FileReaderDeps): FileReader {
  const now = deps.now ?? (() => new Date());
  const inFlight = new Set<string>();
  const limitTold = new Set<string>();
  let active = 0;
  const waiting: Array<() => void> = [];

  async function slot<T>(work: () => Promise<T>): Promise<T> {
    if (active >= PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await work();
    } finally {
      active--;
      waiting.shift()?.();
    }
  }

  /** Reads one source into a result, or a skip. Throws for temporary failures. */
  async function readSource(project: Project, message: SharedMessage, source: SharedSource, who: string): Promise<ReadResult & { link?: string }> {
    const context = { project: project.name, who, at: message.createdAt, message: message.content.slice(0, 2_000) };
    if (source.source === 'link') {
      const app = unreadableApp(source.url);
      if (app) return { status: 'skipped', kind: 'web', reason: `${app.app} links can't be read without signing in; to share it, ${app.instead}`, link: source.url };
      let fetched;
      try {
        fetched = await deps.fetchLink(exportUrl(source.url));
      } catch (error) {
        if (error instanceof LinkError) return { status: 'skipped', kind: 'web', reason: error.message, link: source.url };
        throw error;
      }
      const kind = linkKind(fetched.contentType, fetched.url);
      if (kind === 'unsupported') return { status: 'skipped', kind, reason: `the link leads to a file type the bot can't read (${fetched.contentType || 'unknown'})`, link: source.url };
      const result = await readShared(ctx, { name: source.url, contentType: fetched.contentType, body: fetched.body, kind }, context);
      return { ...result, link: source.url };
    }
    const early = skipReason(source.name, source.contentType, source.size ?? 0);
    if (early) return { status: 'skipped', kind: fileKind(source.name, source.contentType), reason: early, size: source.size };
    const body = await deps.download(source.url);
    return readShared(ctx, { name: source.name, contentType: source.contentType, body }, context);
  }

  return {
    async readMessage(project, message) {
      const counts = { read: 0, skipped: 0, failed: 0, limited: false };
      let sources: SharedSource[];
      try {
        const noted = await notedSources(ctx.db, project);
        sources = sourcesOf(message).filter((source) => !noted.has(source.sourceId) && !inFlight.has(`${project.name}:${source.sourceId}`));
      } catch (error) {
        log.warn('could not check the file notes', { project: project.name, error });
        return counts;
      }
      if (sources.length === 0) return counts;
      for (const source of sources) inFlight.add(`${project.name}:${source.sourceId}`);
      const authorRole = role(project, ctx.env.DISCORD_OWNER_ID, message.authorId);
      const who = label(authorRole, message.authorName);
      await message.react('👀').catch(() => undefined);

      try {
        for (const source of sources) {
          const today = await countEventsSince(ctx.db, project.id, FILE_READ_ACTION, londonDayStart(now())).catch(() => 0);
          if (today >= FILES_PER_DAY) {
            counts.limited = true;
            const key = `${project.name}:${londonDayStart(now()).toISOString()}`;
            if (!limitTold.has(key)) {
              limitTold.add(key);
              await deps.notifyOwner(`**${project.name}** reached today's limit of ${FILES_PER_DAY} files and links read. The rest are read with /read-files tomorrow, or by the next /create-specs.`).catch(() => undefined);
            }
            break;
          }
          let result: ReadResult & { link?: string };
          try {
            result = await slot(() => readSource(project, message, source, who));
          } catch (error) {
            counts.failed++;
            const reason = error instanceof GeminiError ? error.message : 'a download or the AI service failed';
            log.warn('could not read a shared file', { project: project.name, source: source.source, kind: fileKind(source.name, source.contentType), error });
            await safeRecord(ctx, { actor: 'bot', action: 'file.read_failed', outcome: 'failed', project: project.id, data: { source: source.source, message: message.id, reason } });
            await deps.notifyOwner(`Couldn't read **${source.source === 'link' ? source.url : source.name}** in **${project.name}** (${reason}). It's tried again by the next /create-specs, /sync-docs or /read-files. ${message.url}`).catch(() => undefined);
            continue;
          }

          const saved = await saveFileNote(
            ctx.db,
            project,
            {
              sourceId: source.sourceId,
              source: source.source,
              messageId: message.id,
              messageUrl: message.url,
              authorId: message.authorId,
              authorRole,
              authorName: message.authorName,
              postedAt: message.createdAt,
              name: source.name,
              link: result.link,
              kind: result.kind,
              size: result.size,
              sha256: result.sha256,
              result:
                result.status === 'read'
                  ? {
                      status: 'read',
                      title: result.note.title,
                      summary: result.note.summary,
                      details: result.note.details,
                      requirements: result.note.requirements,
                      openQuestions: result.note.open_questions,
                      model: result.model,
                      promptVersion: result.promptVersion,
                    }
                  : { status: 'skipped', reason: result.reason },
            },
            {
              actor: 'bot',
              action: result.status === 'read' ? FILE_READ_ACTION : 'file.not_read',
              outcome: 'ok',
              data: {
                source: source.source,
                kind: result.kind,
                message: message.id,
                ...(result.status === 'read' ? { model: result.model, prompt_version: result.promptVersion, ...(result.via ? { via: result.via } : {}) } : { reason: result.reason }),
              },
            },
          ).catch((error: unknown) => {
            log.error('could not save a file note', { project: project.name, error });
            return 'failed' as const;
          });
          if (saved !== 'saved') {
            if (saved === 'failed') counts.failed++;
            continue;
          }

          if (result.status === 'read') {
            counts.read++;
            await deps
              .post(project, filePost({ name: source.source === 'link' ? shortLink(source.url) : source.name, author_name: message.authorName, message_url: message.url, title: result.note.title, summary: result.note.summary, requirements: result.note.requirements, open_questions: result.note.open_questions }))
              .catch((error: unknown) => log.warn('could not post file notes', { project: project.name, error }));
          } else {
            counts.skipped++;
            if (worthReplying(source, result.reason)) await message.reply(skippedReply(source.source === 'link' ? shortLink(source.url) : source.name, result.reason)).catch(() => undefined);
          }
        }
      } finally {
        for (const source of sources) inFlight.delete(`${project.name}:${source.sourceId}`);
        await message.unreact('👀').catch(() => undefined);
        if (counts.read > 0) await message.react('✅').catch(() => undefined);
      }
      return counts;
    },
  };
}

/** Pure: a link as a short label: host and path, without the query. */
export function shortLink(link: string): string {
  try {
    const url = new URL(link);
    const path = url.pathname === '/' ? '' : url.pathname;
    const label = `${url.hostname.replace(/^www\./, '')}${path}`;
    return label.length > 80 ? `${label.slice(0, 77)}…` : label;
  } catch {
    return link.slice(0, 80);
  }
}

/** A discord.js message as the reader sees it. */
export function sharedMessage(message: Message, botId: string): SharedMessage {
  return {
    id: message.id,
    url: message.url,
    createdAt: message.createdAt,
    authorId: message.author.id,
    authorName: message.member?.displayName ?? message.author.username,
    content: message.content,
    attachments: [...message.attachments.values()].map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      contentType: attachment.contentType,
      size: attachment.size,
      url: attachment.url,
    })),
    react: async (emoji) => {
      await message.react(emoji);
    },
    unreact: async (emoji) => {
      await message.reactions.resolve(emoji)?.users.remove(botId);
    },
    reply: async (text) => {
      await message.reply({ content: text, allowedMentions: { parse: [], repliedUser: false } });
    },
  };
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new Error(`Could not download an attachment (HTTP ${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

/** The reader the bot uses: Discord downloads, the public link fetcher, and the 📎 Files thread. */
export function discordFileReader(ctx: BotContext, client: Client): FileReader {
  return createFileReader(ctx, {
    download,
    fetchLink: fetchPublic,
    async post(project, text) {
      const channel = await client.channels.fetch(project.channel_id);
      if (channel?.type !== ChannelType.GuildText) throw new Error('project channel not found');
      const thread = await ensureProjectThread(channel, 'files', [ctx.env.DISCORD_OWNER_ID, ...clientMembers(project)]);
      await thread.send({ content: text, allowedMentions: { parse: [] } });
    },
    async notifyOwner(text) {
      const guild = await client.guilds.fetch(ctx.env.DISCORD_GUILD_ID);
      const desk = await ensureOwnerChannel(guild, ctx.env.DISCORD_OWNER_ID);
      await desk.send({ content: text, allowedMentions: { parse: [] } });
    },
  });
}

/** The project a message belongs to: its channel's, or its thread's parent's. */
async function projectOf(ctx: BotContext, message: Message): Promise<Project | undefined> {
  const channelId = message.channel.type === ChannelType.GuildText ? message.channelId : message.channel.isThread() ? message.channel.parentId : null;
  if (!channelId) return undefined;
  return getProjectByChannel(ctx.db, channelId).catch(() => undefined);
}

/** A new message in our server: reads its files and links if it is in a project channel. */
export async function onSharedMessage(message: Message, ctx: BotContext, reader: FileReader, botId: string): Promise<void> {
  if (!message.inGuild() || message.guildId !== ctx.env.DISCORD_GUILD_ID) return;
  if (message.author.bot || message.system) return;
  if (message.attachments.size === 0 && !message.content.includes('https://')) return;
  const project = await projectOf(ctx, message);
  if (!project || !READ_STAGES.includes(project.stage)) return;
  await reader.readMessage(project, sharedMessage(message, botId));
}

/**
 * Reads what was shared in the channel but has no notes yet (posted while the bot was
 * down, or a read that failed), oldest first, up to `max` messages.
 */
export async function readUnreadFiles(ctx: BotContext, reader: FileReader, project: Project, channel: TextChannel, botId: string, max = 10): Promise<{ read: number; skipped: number; failed: number; left: number }> {
  const totals = { read: 0, skipped: 0, failed: 0, left: 0 };
  if (!READ_STAGES.includes(project.stage)) return totals;
  const noted = await notedSources(ctx.db, project);
  const pending = (await messagesSince(channel, project.created_at))
    .filter((message) => !message.author.bot && !message.system)
    .reverse()
    .filter((message) => sourcesOf(sharedMessage(message, botId)).some((source) => !noted.has(source.sourceId)));
  for (const [index, message] of pending.entries()) {
    if (index >= max) {
      totals.left = pending.length - max;
      break;
    }
    const counts = await reader.readMessage(project, sharedMessage(message, botId));
    totals.read += counts.read;
    totals.skipped += counts.skipped;
    totals.failed += counts.failed;
    if (counts.limited) {
      totals.left = pending.length - index;
      break;
    }
  }
  return totals;
}

/** The project's file notes, after reading anything still unread (a few at most). Never throws. */
export async function currentFileNotes(ctx: BotContext, project: Project, channel?: TextChannel, max = 10): Promise<FileNote[]> {
  if (channel && ctx.files && ctx.botId) {
    await readUnreadFiles(ctx, ctx.files, project, channel, ctx.botId, max).catch((error: unknown) => log.warn('could not read the unread files', { project: project.name, error }));
  }
  return fileNotesFor(ctx.db, project).catch((error: unknown) => {
    log.warn('could not load the file notes', { project: project.name, error });
    return [];
  });
}
