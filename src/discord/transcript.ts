// Reads a project channel into a conversation for Gemini: the people's messages
// (not the bot's), with images and small text files attached. The pure parts
// (choosing attachments, rendering the text) are separate so they can be tested.

import type { TextChannel } from 'discord.js';
import { IMAGE_TYPES, type Part } from '../services/gemini.js';

export type Role = 'owner' | 'client' | 'other' | 'bot';

export interface ChatAttachment {
  name: string;
  contentType: string | null;
  size: number;
  url: string;
}

export interface ChatMessage {
  at: Date;
  role: Role;
  author: string;
  text: string;
  attachments: ChatAttachment[];
}

export const LIMITS = {
  maxPages: 20, // 2,000 messages
  maxImages: 16,
  maxImageBytes: 7 * 1024 * 1024,
  maxTotalImageBytes: 15 * 1024 * 1024, // the whole request must stay under 20 MB
  maxTextFileBytes: 200 * 1024,
  maxTranscriptChars: 300_000,
};

export async function readConversation(
  channel: TextChannel,
  since: Date,
  people: { ownerId: string; clientId?: string | undefined },
  /** Also include the bot's own posts (for answering questions; specs leave them out). */
  options: { includeBot?: boolean } = {},
): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = [];
  let before: string | undefined;
  for (let page = 0; page < LIMITS.maxPages; page++) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (batch.size === 0) break;
    let reachedStart = false;
    for (const message of batch.values()) {
      if (message.createdAt < since) {
        reachedStart = true;
        continue;
      }
      if (message.system || (message.author.bot && !options.includeBot)) continue;
      const role: Role = message.author.bot
        ? 'bot'
        : message.author.id === people.ownerId
          ? 'owner'
          : message.author.id === people.clientId
            ? 'client'
            : 'other';
      messages.push({
        at: message.createdAt,
        role,
        author: message.member?.displayName ?? message.author.username,
        text: message.content,
        attachments: [...message.attachments.values()].map((attachment) => ({
          name: attachment.name,
          contentType: attachment.contentType,
          size: attachment.size,
          url: attachment.url,
        })),
      });
    }
    before = batch.last()?.id;
    if (reachedStart || batch.size < 100) break;
  }
  return messages.sort((a, b) => a.at.getTime() - b.at.getTime());
}

export interface AttachmentPlan {
  images: ChatAttachment[];
  textFiles: ChatAttachment[];
  skipped: Array<{ name: string; reason: string }>;
}

function isTextType(contentType: string | null): boolean {
  if (!contentType) return false;
  const base = contentType.split(';')[0]?.trim() ?? '';
  return base.startsWith('text/') || base === 'application/json';
}

/** Pure: which attachments to send, within Gemini's limits, oldest first. */
export function planAttachments(messages: readonly ChatMessage[]): AttachmentPlan {
  const plan: AttachmentPlan = { images: [], textFiles: [], skipped: [] };
  let imageBytes = 0;
  for (const attachment of messages.flatMap((message) => message.attachments)) {
    const type = attachment.contentType?.split(';')[0]?.trim() ?? '';
    if ((IMAGE_TYPES as readonly string[]).includes(type)) {
      if (attachment.size > LIMITS.maxImageBytes) plan.skipped.push({ name: attachment.name, reason: 'image too large' });
      else if (plan.images.length >= LIMITS.maxImages) plan.skipped.push({ name: attachment.name, reason: 'too many images' });
      else if (imageBytes + attachment.size > LIMITS.maxTotalImageBytes) {
        plan.skipped.push({ name: attachment.name, reason: 'images too large in total' });
      } else {
        plan.images.push(attachment);
        imageBytes += attachment.size;
      }
    } else if (isTextType(attachment.contentType)) {
      if (attachment.size > LIMITS.maxTextFileBytes) plan.skipped.push({ name: attachment.name, reason: 'file too large' });
      else plan.textFiles.push(attachment);
    } else {
      plan.skipped.push({ name: attachment.name, reason: 'file type not read' });
    }
  }
  return plan;
}

const ROLE_LABEL: Record<Role, string> = { owner: 'Furkan (owner)', client: 'Client', other: 'Other member', bot: 'Bot' };

/** Pure: the conversation as tagged text, with numbered image markers and file contents. */
export function renderConversation(
  messages: readonly ChatMessage[],
  plan: AttachmentPlan,
  fileTexts: ReadonlyMap<string, string>,
): string {
  const imageNumber = new Map(plan.images.map((image, index) => [image.url, index + 1]));
  const textUrls = new Set(plan.textFiles.map((file) => file.url));
  const skipped = new Map(plan.skipped.map((item) => [item.name, item.reason]));
  const lines: string[] = ['<conversation>'];
  for (const message of messages) {
    const when = message.at.toISOString().slice(0, 16).replace('T', ' ');
    const who = message.role === 'client' ? `${ROLE_LABEL.client} (${message.author})` : ROLE_LABEL[message.role];
    lines.push(`[${when} UTC] ${who}: ${message.text}`.trimEnd());
    for (const attachment of message.attachments) {
      const number = imageNumber.get(attachment.url);
      if (number !== undefined) lines.push(`  [image ${number}: ${attachment.name}]`);
      else if (textUrls.has(attachment.url)) {
        lines.push(`  [file: ${attachment.name}]`, `  <file name="${attachment.name}">`, fileTexts.get(attachment.url) ?? '', '  </file>');
      } else lines.push(`  [file not read: ${attachment.name} (${skipped.get(attachment.name) ?? 'skipped'})]`);
    }
  }
  lines.push('</conversation>');
  const text = lines.join('\n');
  // Keep the newest part if it's ever too long: recent messages matter most.
  return text.length > LIMITS.maxTranscriptChars ? `<conversation truncated>\n${text.slice(-LIMITS.maxTranscriptChars)}` : text;
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Could not download an attachment (HTTP ${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

/** Downloads the planned attachments: the conversation as text, and the images as parts, in order. */
export async function conversationParts(messages: readonly ChatMessage[]): Promise<{ text: string; images: Part[]; plan: AttachmentPlan }> {
  const plan = planAttachments(messages);
  const fileTexts = new Map<string, string>();
  for (const file of plan.textFiles) fileTexts.set(file.url, (await download(file.url)).toString('utf8'));
  const images: Part[] = [];
  for (const image of plan.images) {
    images.push({ type: 'image', data: (await download(image.url)).toString('base64'), mime_type: image.contentType!.split(';')[0]!.trim() });
  }
  const note = plan.images.length ? `\n\nThe ${plan.images.length} image(s) after this text are the attachments numbered in the conversation, in order.` : '';
  return { text: `${renderConversation(messages, plan, fileTexts)}${note}`, images, plan };
}

/** Gemini's input for a spec: text first, then the images in order. */
export async function buildSpecInput(
  messages: readonly ChatMessage[],
  previous: { version: number; markdown: string } | undefined,
  memory = '',
  /** Recorded calls, already rendered by renderCalls(). */
  calls = '',
): Promise<{ input: Part[]; plan: AttachmentPlan }> {
  const conversation = await conversationParts(messages);
  const sections = [
    previous ? `<previous_spec version="${previous.version}">\n${previous.markdown}\n</previous_spec>` : 'There is no previous spec.',
    memory ? `<memory>\n${memory}\n</memory>` : '',
    calls,
    conversation.text,
  ].filter(Boolean);
  return { input: [{ type: 'text', text: sections.join('\n\n') }, ...conversation.images], plan: conversation.plan };
}
