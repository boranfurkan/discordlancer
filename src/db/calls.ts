// Recorded calls (append-only): written once, with their event, after a call is
// transcribed and summarised. Corrections go in a later call or the chat, never an edit.

import { RecordId, type Surreal } from 'surrealdb';
import { z } from 'zod';
import { CallSummary } from '../prompts/calls.js';
import type { EventInput } from './events.js';
import { eventContent, toDate, type Project } from './projects.js';

export const Participant = z.object({
  user_id: z.string(),
  name: z.string(),
  role: z.enum(['owner', 'client', 'other']),
  /** Whether they agreed to be recorded. Nothing they said is in the transcript otherwise. */
  recorded: z.boolean(),
});
export type Participant = z.infer<typeof Participant>;

export const CallRow = z.object({
  id: z.custom<RecordId<'call'>>((value) => value instanceof RecordId),
  project: z.custom<RecordId<'project'>>((value) => value instanceof RecordId),
  started_at: toDate,
  ended_at: toDate,
  participants: z.array(Participant),
  transcript: z.string(),
  summary: CallSummary,
  speech_seconds: z.number().int(),
  segments: z.number().int(),
  model: z.string(),
  prompt_version: z.string(),
  created_at: toDate,
});
export type Call = z.infer<typeof CallRow>;

export interface NewCall {
  startedAt: Date;
  endedAt: Date;
  participants: Participant[];
  transcript: string;
  summary: CallSummary;
  speechSeconds: number;
  segments: number;
  model: string;
  promptVersion: string;
}

export async function saveCall(db: Surreal, project: Pick<Project, 'id'>, call: NewCall, event: Omit<EventInput, 'project'>): Promise<Call> {
  const id = new RecordId('call', crypto.randomUUID());
  await db.query(
    `BEGIN TRANSACTION;
     CREATE ONLY $id CONTENT $content RETURN NONE;
     CREATE event CONTENT $event RETURN NONE;
     COMMIT TRANSACTION;`,
    {
      id,
      content: {
        project: project.id,
        started_at: call.startedAt,
        ended_at: call.endedAt,
        participants: call.participants,
        transcript: call.transcript,
        summary: call.summary,
        speech_seconds: Math.round(call.speechSeconds),
        segments: call.segments,
        model: call.model,
        prompt_version: call.promptVersion,
      },
      event: eventContent({ ...event, data: { ...event.data, call: id.toString() } }, project.id),
    },
  );
  const [rows] = await db.query<[unknown[]]>('SELECT * FROM $id', { id });
  return CallRow.parse(rows[0]);
}

/** A project's calls, oldest first. */
export async function callsFor(db: Surreal, project: Pick<Project, 'id'>): Promise<Call[]> {
  const [rows] = await db.query<[unknown[]]>('SELECT * FROM call WHERE project = $p ORDER BY started_at', { p: project.id });
  return rows.map((row) => CallRow.parse(row));
}

/** How a call is named in docs and citations: its start, to the minute, in UTC. */
export function callLabel(call: Pick<Call, 'started_at'>): string {
  return call.started_at.toISOString().slice(0, 16).replace('T', ' ');
}
