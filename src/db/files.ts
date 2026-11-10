// File notes (append-only): the bot's notes on each file or link shared in a project
// channel, written once with their event. A second save of the same file is refused by
// the unique index, so two readers racing each other can't both write.

import { RecordId, type Surreal } from 'surrealdb';
import { z } from 'zod';
import type { EventInput } from './events.js';
import { eventContent, toDate, type Project } from './projects.js';

export const FileNoteRow = z.object({
  id: z.custom<RecordId<'file_note'>>((value) => value instanceof RecordId),
  project: z.custom<RecordId<'project'>>((value) => value instanceof RecordId),
  source_id: z.string(),
  source: z.enum(['attachment', 'link']),
  message_id: z.string(),
  message_url: z.string(),
  author_id: z.string(),
  author_role: z.enum(['owner', 'client', 'other']),
  author_name: z.string(),
  posted_at: toDate,
  name: z.string(),
  link: z.string().optional(),
  kind: z.string(),
  size: z.number().int().optional(),
  sha256: z.string().optional(),
  status: z.enum(['read', 'skipped']),
  reason: z.string().optional(),
  title: z.string().optional(),
  summary: z.string().optional(),
  details: z.string().optional(),
  requirements: z.array(z.string()).optional(),
  open_questions: z.array(z.string()).optional(),
  model: z.string().optional(),
  prompt_version: z.string().optional(),
  created_at: toDate,
});
export type FileNote = z.infer<typeof FileNoteRow>;

export interface NewFileNote {
  sourceId: string;
  source: 'attachment' | 'link';
  messageId: string;
  messageUrl: string;
  authorId: string;
  authorRole: 'owner' | 'client' | 'other';
  authorName: string;
  postedAt: Date;
  name: string;
  link?: string | undefined;
  kind: string;
  size?: number | undefined;
  sha256?: string | undefined;
  result:
    | { status: 'read'; title: string; summary: string; details: string; requirements: string[]; openQuestions: string[]; model: string; promptVersion: string }
    | { status: 'skipped'; reason: string };
}

/** Pure: the ID a link gets, from its message and address. */
export function linkSourceId(messageId: string, url: string, hash: (text: string) => string): string {
  return `link:${messageId}:${hash(url).slice(0, 16)}`;
}

/** Saves a note and its event together. 'already' if this file has a note. */
export async function saveFileNote(db: Surreal, project: Pick<Project, 'id'>, note: NewFileNote, event: Omit<EventInput, 'project'>): Promise<'saved' | 'already'> {
  const id = new RecordId('file_note', crypto.randomUUID());
  const content: Record<string, unknown> = {
    project: project.id,
    source_id: note.sourceId,
    source: note.source,
    message_id: note.messageId,
    message_url: note.messageUrl,
    author_id: note.authorId,
    author_role: note.authorRole,
    author_name: note.authorName.slice(0, 100),
    posted_at: note.postedAt,
    name: note.name.slice(0, 300),
    kind: note.kind,
    status: note.result.status,
  };
  if (note.link) content.link = note.link;
  if (note.size !== undefined) content.size = note.size;
  if (note.sha256) content.sha256 = note.sha256;
  if (note.result.status === 'skipped') content.reason = note.result.reason;
  else {
    content.title = note.result.title;
    content.summary = note.result.summary;
    content.details = note.result.details;
    content.requirements = note.result.requirements;
    content.open_questions = note.result.openQuestions;
    content.model = note.result.model;
    content.prompt_version = note.result.promptVersion;
  }
  try {
    await db.query(
      `BEGIN TRANSACTION;
       CREATE ONLY $id CONTENT $content RETURN NONE;
       CREATE event CONTENT $event RETURN NONE;
       COMMIT TRANSACTION;`,
      { id, content, event: eventContent({ ...event, data: { ...event.data, file_note: id.toString() } }, project.id) },
    );
  } catch (error) {
    if (error instanceof Error && /already/.test(error.message)) return 'already';
    throw error;
  }
  return 'saved';
}

/** A project's file notes, oldest first. */
export async function fileNotesFor(db: Surreal, project: Pick<Project, 'id'>): Promise<FileNote[]> {
  const [rows] = await db.query<[unknown[]]>('SELECT * FROM file_note WHERE project = $p ORDER BY posted_at', { p: project.id });
  return rows.map((row) => FileNoteRow.parse(row));
}

/** Which of these sources already have a note. */
export async function notedSources(db: Surreal, project: Pick<Project, 'id'>): Promise<Set<string>> {
  const [rows] = await db.query<[string[]]>('SELECT VALUE source_id FROM file_note WHERE project = $p', { p: project.id });
  return new Set(rows);
}
