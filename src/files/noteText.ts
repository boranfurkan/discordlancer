// Pure: file notes as text: in Gemini prompts (specs, /ask, docs, the Claude Code brief),
// as the post in the project's 📎 Files thread, and as docs/project/files.md.

import type { FileNote } from '../db/files.js';
import { OWNER_NAME } from '../discord/guards.js';

const minute = (date: Date) => date.toISOString().slice(0, 16).replace('T', ' ');
const fence = (tag: string, text: string, attrs = '') => `<${tag}${attrs}>\n${text}\n</${tag}>`;
const attr = (value: string) => value.replace(/["<>\n]/g, ' ').trim();

/**
 * How a file is named in citations: its name and when it was shared, since pasted
 * screenshots are all called "image.png".
 */
export function fileLabel(note: Pick<FileNote, 'name' | 'posted_at'>): string {
  return `${note.name.replace(/[[\]]/g, '')}, ${minute(note.posted_at)}`;
}

export function whoShared(note: Pick<FileNote, 'author_role' | 'author_name'>): string {
  if (note.author_role === 'owner') return `${OWNER_NAME} (owner)`;
  if (note.author_role === 'client') return `Client (${note.author_name})`;
  return `Other member (${note.author_name})`;
}

/** File notes in a prompt: newest kept within the limits, put back in date order. */
export const FILE_TEXT_LIMITS = { perFile: 14_000, total: 120_000 };

export function renderFileNotes(notes: readonly FileNote[], limits = FILE_TEXT_LIMITS): string {
  if (notes.length === 0) return '';
  const blocks: string[] = [];
  let used = 0;
  for (const note of [...notes].reverse()) {
    const attrs = ` label="${attr(fileLabel(note))}" shared_by="${attr(whoShared(note))}" kind="${note.kind}"${note.link ? ` link="${attr(note.link)}"` : ''}`;
    let block: string;
    if (note.status === 'skipped') block = fence('file', `Not read: ${note.reason ?? 'unknown reason'}.`, `${attrs} status="not read"`);
    else {
      const body = [
        `Title: ${note.title}`,
        `Summary (AI): ${note.summary}`,
        ...(note.requirements ?? []).map((item) => `Requirement: ${item}`),
        ...(note.open_questions ?? []).map((item) => `Open question: ${item}`),
        'Notes (AI):',
        note.details ?? '',
      ].join('\n');
      block = fence('file', body.length > limits.perFile ? `${body.slice(0, limits.perFile)}\n<notes cut>` : body, `${attrs} status="read"`);
    }
    if (used + block.length > limits.total && blocks.length) break;
    blocks.unshift(block);
    used += block.length;
  }
  return fence('files', blocks.join('\n'));
}

/** Pure: the post in the 📎 Files thread for a file that was read, marked as AI notes. */
export function filePost(note: Pick<FileNote, 'name' | 'author_name' | 'message_url' | 'title' | 'summary' | 'requirements' | 'open_questions'>): string {
  const list = (items: readonly string[], max: number) => [...items.slice(0, max).map((item) => `- ${item}`), ...(items.length > max ? [`- …and ${items.length - max} more`] : [])];
  const requirements = note.requirements ?? [];
  const questions = note.open_questions ?? [];
  const lines = [
    `📎 **${note.name}** from ${note.author_name} · ${note.message_url}`,
    `**${note.title}**`,
    note.summary ?? '',
    ...(requirements.length ? ['', '**What it asks for**', ...list(requirements, 6)] : []),
    ...(questions.length ? ['', '**Open questions**', ...list(questions, 4)] : []),
    `-# AI notes (Google Gemini) on the file; the full notes go into the specs, answers and project docs. ${OWNER_NAME} checks them. Reply here to correct anything.`,
  ];
  const text = lines.join('\n');
  return text.length <= 1_950 ? text : `${text.slice(0, 1_900).trimEnd()}…\n-# AI notes, shortened here; the full notes are kept.`;
}

/** Pure: the reply under a file the bot couldn't read, so the person can send something it can. */
export function skippedReply(name: string, reason: string): string {
  return `I couldn't read **${name}**: ${reason}. ${OWNER_NAME} can still open it.`;
}

/** Pure: docs/project/files.md: every shared file and link with its notes. */
export function filesDoc(notes: readonly FileNote[]): string {
  const read = notes.filter((note) => note.status === 'read');
  const skipped = notes.filter((note) => note.status === 'skipped');
  const lines = ['# Shared files and links', '', 'Everything shared in the project channel, with AI notes on what each one says. The files themselves stay in the Discord channel.', ''];
  if (notes.length === 0) lines.push('Nothing has been shared yet.', '');
  for (const note of read) {
    lines.push(`## ${note.title ?? note.name}`, '', `\`${note.name}\`, shared by ${whoShared(note)} on ${minute(note.posted_at)} UTC${note.link ? ` (${note.link})` : ''}.`, '', note.summary ?? '', '');
    if (note.requirements?.length) lines.push('**What it asks for**', '', ...note.requirements.map((item) => `- ${item}`), '');
    if (note.open_questions?.length) lines.push('**Open questions**', '', ...note.open_questions.map((item) => `- ${item}`), '');
    if (note.details) lines.push('<details><summary>Full notes</summary>', '', note.details, '', '</details>', '');
  }
  if (skipped.length) {
    lines.push('## Not read', '', ...skipped.map((note) => `- \`${note.name}\` (${minute(note.posted_at)} UTC): ${note.reason ?? 'not read'}.`), '');
  }
  lines.push('_AI-written by Discordlancer (Google Gemini) from the shared files. The agreed spec stays the contract._', '');
  return lines.join('\n');
}
