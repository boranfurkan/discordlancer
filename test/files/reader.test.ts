import { RecordId, type Surreal } from 'surrealdb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fileNotesFor, notedSources, saveFileNote } from '../../src/db/files.js';
import { getProjectByName, type Project } from '../../src/db/projects.js';
import type { BotContext } from '../../src/discord/command.js';
import { createFileReader, FILES_PER_DAY, sourcesOf, type SharedMessage } from '../../src/discord/files.js';
import { LinkError } from '../../src/files/links.js';
import { fileLabel, filePost, filesDoc, renderFileNotes } from '../../src/files/noteText.js';
import { GeminiError, type GeminiApi, type JsonRequest } from '../../src/services/gemini.js';
import { memoryDb } from '../helpers/db.js';

let db: Surreal;
let project: Project;
const OWNER = 'owner-1';
const CLIENT = 'client-1';

beforeAll(async () => {
  db = await memoryDb();
  await db.query('CREATE $id CONTENT $content', {
    id: new RecordId('project', 'observv'),
    content: { name: 'observv', channel_id: 'c-1', repo: 'me/observv', stage: 'joined', client_id: CLIENT },
  });
  project = (await getProjectByName(db, 'observv'))!;
});

afterAll(async () => {
  await db.close();
});

let geminiFails = false;
const gemini: GeminiApi = {
  async json<T>(request: JsonRequest<T>): Promise<T> {
    if (geminiFails) throw new GeminiError('Gemini is busy');
    return request.parse.parse({ title: 'Roadmap deck', summary: 'The plan for Q1.', details: '- slide 2: AI reports', requirements: ['Weekly AI progress report'], open_questions: ['Which format?'] });
  },
};

let messageCount = 0;
function message(attachments: SharedMessage['attachments'], content = '') {
  const id = `m-${++messageCount}`;
  const log: string[] = [];
  const shared: SharedMessage = {
    id,
    url: `https://discord.com/channels/g/c-1/${id}`,
    createdAt: new Date(Date.UTC(2026, 10, 11, 12, messageCount)),
    authorId: CLIENT,
    authorName: 'Laura',
    content,
    attachments,
    react: async (emoji) => void log.push(`+${emoji}`),
    unreact: async (emoji) => void log.push(`-${emoji}`),
    reply: async (text) => void log.push(`reply: ${text}`),
  };
  return { shared, log };
}

const pdf = (id: string, size = 1000) => ({ id, name: 'roadmap.pdf', contentType: 'application/pdf', size, url: `https://cdn.discordapp.com/${id}/roadmap.pdf` });

function reader(overrides: { fetchLink?: () => Promise<never> } = {}) {
  const posts: string[] = [];
  const owner: string[] = [];
  const downloads: string[] = [];
  const ctx = { db, gemini, env: { DISCORD_OWNER_ID: OWNER, DISCORD_GUILD_ID: 'g' } } as unknown as BotContext;
  const files = createFileReader(ctx, {
    download: async (url) => {
      downloads.push(url);
      return Buffer.from('%PDF-1.4');
    },
    fetchLink: overrides.fetchLink ?? (async () => ({ url: 'https://observv.com/', contentType: 'text/html', body: Buffer.from(`<html><body><h1>Observv</h1><p>${'A living visual record of every property. '.repeat(10)}</p></body></html>`) })),
    post: async (_project, text) => void posts.push(text),
    notifyOwner: async (text) => void owner.push(text),
  });
  return { files, posts, owner, downloads };
}

beforeEach(() => {
  geminiFails = false;
});

describe('reading shared files', () => {
  it('reads an attachment once: 👀 then ✅, notes saved and posted in the Files thread', async () => {
    const { files, posts } = reader();
    const { shared, log } = message([pdf('a-1')], 'Our roadmap');
    expect(await files.readMessage(project, shared)).toMatchObject({ read: 1, skipped: 0, failed: 0 });
    expect(log).toEqual(['+👀', '-👀', '+✅']);
    expect(posts[0]).toContain('📎 **roadmap.pdf** from Laura');
    expect(posts[0]).toContain('Weekly AI progress report');
    expect(posts[0]).toContain('AI notes');
    const notes = await fileNotesFor(db, project);
    expect(notes.at(-1)).toMatchObject({ source_id: 'a-1', author_role: 'client', status: 'read', title: 'Roadmap deck', kind: 'pdf' });

    const again = reader();
    expect(await again.files.readMessage(project, shared)).toMatchObject({ read: 0 });
    expect(again.downloads).toEqual([]);
  });

  it("replies under a file it can't read, saying what works, and doesn't try it again", async () => {
    const { files, posts } = reader();
    const { shared, log } = message([{ id: 'a-2', name: 'design.fig', contentType: null, size: 500, url: 'https://cdn.discordapp.com/a-2/design.fig' }]);
    expect(await files.readMessage(project, shared)).toMatchObject({ skipped: 1 });
    expect(log.find((line) => line.startsWith('reply:'))).toMatch(/couldn't read \*\*design\.fig\*\*.*PDF, an image/);
    expect(log).not.toContain('+✅');
    expect(posts).toEqual([]);
    expect((await notedSources(db, project)).has('a-2')).toBe(true);
  });

  it('reads a public web page link, and answers a Figma link with what to send instead', async () => {
    const { files, posts } = reader();
    const { shared } = message([], 'Our site: https://observv.com/ and the design https://www.figma.com/design/abc/App');
    const log: string[] = [];
    const result = await files.readMessage(project, { ...shared, reply: async (text) => void log.push(text) });
    expect(result).toMatchObject({ read: 1, skipped: 1 });
    expect(posts[0]).toContain('📎 **observv.com** from Laura');
    expect(log[0]).toMatch(/Figma links can't be read.*export the frames/);
  });

  it("stays quiet about a link that simply couldn't be fetched", async () => {
    const { files } = reader({ fetchLink: async () => Promise.reject(new LinkError('the page was not found')) });
    const replies: string[] = [];
    const { shared } = message([], 'old link https://gone.example.com/page');
    expect(await files.readMessage(project, { ...shared, reply: async (text) => void replies.push(text) })).toMatchObject({ skipped: 1 });
    expect(replies).toEqual([]);
  });

  it('on a failure, tells the owner and saves nothing, so it is tried again later', async () => {
    geminiFails = true;
    const { files, owner } = reader();
    const { shared, log } = message([pdf('a-3')]);
    expect(await files.readMessage(project, shared)).toMatchObject({ failed: 1, read: 0 });
    expect(owner[0]).toMatch(/Couldn't read \*\*roadmap\.pdf\*\* in \*\*observv\*\* \(Gemini is busy\)/);
    expect(log).toEqual(['+👀', '-👀']);
    expect((await notedSources(db, project)).has('a-3')).toBe(false);

    geminiFails = false;
    expect(await reader().files.readMessage(project, shared)).toMatchObject({ read: 1 });
  });

  it('stops at the daily limit and tells the owner once', async () => {
    for (let i = 0; i < FILES_PER_DAY; i++) await db.query("CREATE event CONTENT { actor: 'bot', action: 'file.read', outcome: 'ok', project: $p }", { p: project.id });
    const { files, owner } = reader();
    expect(await files.readMessage(project, message([pdf('a-4')]).shared)).toMatchObject({ limited: true, read: 0 });
    await files.readMessage(project, message([pdf('a-5')]).shared);
    expect(owner).toHaveLength(1);
    expect(owner[0]).toMatch(/today's limit/);
    await db.query("DELETE event WHERE action = 'file.read'").catch(() => undefined);
  });
});

describe('file notes in the database', () => {
  it('are append-only, and one per file', async () => {
    const note = {
      sourceId: 'dup-1',
      source: 'attachment' as const,
      messageId: 'm',
      messageUrl: 'u',
      authorId: OWNER,
      authorRole: 'owner' as const,
      authorName: 'Furkan',
      postedAt: new Date(),
      name: 'x.png',
      kind: 'image',
      result: { status: 'skipped' as const, reason: 'test' },
    };
    const event = { actor: 'bot' as const, action: 'file.not_read', outcome: 'ok' as const };
    expect(await saveFileNote(db, project, note, event)).toBe('saved');
    expect(await saveFileNote(db, project, note, event)).toBe('already');
    await expect(db.query("UPDATE file_note SET reason = 'changed' WHERE source_id = 'dup-1'")).rejects.toThrow(/append-only/);
  });
});

describe('sourcesOf', () => {
  it('gives attachments their own IDs, and links an ID from the message and address', () => {
    const sources = sourcesOf({ id: 'm-9', content: 'see https://observv.com/', attachments: [pdf('a-9')] });
    expect(sources.map((source) => source.source)).toEqual(['attachment', 'link']);
    expect(sources[1]!.sourceId).toMatch(/^link:m-9:[0-9a-f]{16}$/);
    expect(sourcesOf({ id: 'm-9', content: 'see https://observv.com/', attachments: [] })[0]!.sourceId).toBe(sources[1]!.sourceId);
  });
});

describe('note text', () => {
  it('labels files by name and time, renders them for prompts within limits, and writes the docs page', async () => {
    const notes = await fileNotesFor(db, project);
    const read = notes.find((note) => note.status === 'read')!;
    expect(fileLabel(read)).toMatch(/^roadmap\.pdf, 2026-11-11 12:\d\d$/);
    const prompt = renderFileNotes(notes);
    expect(prompt.startsWith('<files>')).toBe(true);
    expect(prompt).toContain('status="not read"');
    expect(prompt).toContain('Requirement: Weekly AI progress report');
    const small = renderFileNotes(notes, { perFile: 100, total: 150 });
    expect(small.match(/<file /g)).toHaveLength(1);
    const doc = filesDoc(notes);
    expect(doc).toContain('# Shared files and links');
    expect(doc).toContain('## Not read');
    expect(doc).toContain('AI-written');
  });

  it('keeps the Files thread post within a Discord message', () => {
    const long = filePost({ name: 'x.pdf', author_name: 'Laura', message_url: 'u', title: 't', summary: 's'.repeat(3_000), requirements: [], open_questions: [] });
    expect(long.length).toBeLessThanOrEqual(2_000);
    expect(long).toContain('AI notes');
  });
});
