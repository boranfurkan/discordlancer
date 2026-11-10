// Specs, quotes and agreements: the history behind "both sides agreed". All three
// tables are append-only. A new version is the next number; the unique index on
// (project, version) turns a race into an error instead of a duplicate.

import { RecordId, type Surreal } from 'surrealdb';
import { z } from 'zod';
import type { EventInput } from './events.js';
import { eventContent, toDate, type Project } from './projects.js';

const recordId = z.custom<RecordId>((value) => value instanceof RecordId);

export const SpecRow = z.object({
  id: recordId,
  version: z.number().int(),
  markdown: z.string(),
  changes: z.array(z.string()),
  open_questions: z.array(z.string()),
  message_count: z.number().int(),
  model: z.string(),
  prompt_version: z.string(),
  created_at: toDate,
});
export type Spec = z.infer<typeof SpecRow>;

export const QuoteRow = z.object({
  id: recordId,
  version: z.number().int(),
  amount_micro: z.number().int(),
  deadline: toDate,
  spec_version: z.number().int(),
  terms: z.string(),
  /** A deposit paid before work starts; the rest is paid on delivery. */
  deposit_micro: z.number().int().optional(),
  created_at: toDate,
});
export type Quote = z.infer<typeof QuoteRow>;

export type AgreementKind = 'spec' | 'quote';
export type Party = 'owner' | 'client';

export class VersionTakenError extends Error {
  override name = 'VersionTakenError';
}

function isDuplicate(error: unknown): boolean {
  return error instanceof Error && /already/i.test(error.message);
}

type ProjectRef = Pick<Project, 'id'>;

export async function latestSpec(db: Surreal, project: ProjectRef): Promise<Spec | undefined> {
  const [rows] = await db.query<[unknown[]]>('SELECT * FROM spec WHERE project = $p ORDER BY version DESC LIMIT 1', {
    p: project.id,
  });
  return rows[0] === undefined ? undefined : SpecRow.parse(rows[0]);
}

export async function latestQuote(db: Surreal, project: ProjectRef): Promise<Quote | undefined> {
  const [rows] = await db.query<[unknown[]]>('SELECT * FROM quote WHERE project = $p ORDER BY version DESC LIMIT 1', {
    p: project.id,
  });
  return rows[0] === undefined ? undefined : QuoteRow.parse(rows[0]);
}

export interface NewSpec {
  markdown: string;
  changes: string[];
  openQuestions: string[];
  messageCount: number;
  model: string;
  promptVersion: string;
}

/**
 * Saves the next spec version and its event. Agreement is tied to a version, so an
 * agreed project goes back to `joined` in the same transaction.
 */
export async function saveSpec(
  db: Surreal,
  project: Pick<Project, 'id' | 'stage'>,
  spec: NewSpec,
  event: Omit<EventInput, 'project'>,
): Promise<number> {
  const version = ((await latestSpec(db, project))?.version ?? 0) + 1;
  const resets = project.stage === 'specs_agreed' || project.stage === 'quote_accepted';
  try {
    await db.query(
      `BEGIN TRANSACTION;
       CREATE spec CONTENT $spec RETURN NONE;
       CREATE event CONTENT $event RETURN NONE;
       UPDATE $id SET stage = "joined" WHERE stage IN ["specs_agreed", "quote_accepted"] RETURN NONE;
       COMMIT TRANSACTION;`,
      {
        id: project.id,
        spec: {
          project: project.id,
          version,
          markdown: spec.markdown,
          changes: spec.changes,
          open_questions: spec.openQuestions,
          message_count: spec.messageCount,
          model: spec.model,
          prompt_version: spec.promptVersion,
        },
        event: eventContent(
          { ...event, data: { ...event.data, version, ...(resets ? { stage_reset_from: project.stage } : {}) } },
          project.id,
        ),
      },
    );
  } catch (error) {
    if (isDuplicate(error)) throw new VersionTakenError('Another spec was saved at the same moment. Try again.');
    throw error;
  }
  return version;
}

export interface NewQuote {
  amountMicro: number;
  deadline: Date;
  specVersion: number;
  terms: string;
  depositMicro?: number | undefined;
}

/**
 * Saves the next quote version. Posting a quote counts as the owner's acceptance of
 * it, so that agreement is written too. A project that had accepted an earlier
 * quote goes back to `specs_agreed`.
 */
export async function saveQuote(
  db: Surreal,
  project: Pick<Project, 'id' | 'stage'>,
  quote: NewQuote,
  ownerId: string,
  event: Omit<EventInput, 'project'>,
): Promise<number> {
  const version = ((await latestQuote(db, project))?.version ?? 0) + 1;
  try {
    await db.query(
      `BEGIN TRANSACTION;
       CREATE quote CONTENT $quote RETURN NONE;
       CREATE agreement CONTENT $agreement RETURN NONE;
       CREATE event CONTENT $event RETURN NONE;
       UPDATE $id SET stage = "specs_agreed" WHERE stage = "quote_accepted" RETURN NONE;
       COMMIT TRANSACTION;`,
      {
        id: project.id,
        quote: {
          project: project.id,
          version,
          amount_micro: quote.amountMicro,
          deadline: quote.deadline,
          spec_version: quote.specVersion,
          terms: quote.terms,
          ...(quote.depositMicro ? { deposit_micro: quote.depositMicro } : {}),
        },
        agreement: { project: project.id, kind: 'quote', version, party: 'owner', user_id: ownerId },
        event: eventContent(
          {
            ...event,
            data: {
              ...event.data,
              version,
              amount_micro: quote.amountMicro,
              ...(quote.depositMicro ? { deposit_micro: quote.depositMicro } : {}),
              ...(project.stage === 'quote_accepted' ? { stage_reset_from: project.stage } : {}),
            },
          },
          project.id,
        ),
      },
    );
  } catch (error) {
    if (isDuplicate(error)) throw new VersionTakenError('Another quote was saved at the same moment. Try again.');
    throw error;
  }
  return version;
}

/** Records one side's agreement. Returns 'already' if they had agreed to this version before. */
export async function addAgreement(
  db: Surreal,
  project: ProjectRef,
  kind: AgreementKind,
  version: number,
  party: Party,
  userId: string,
  event: Omit<EventInput, 'project'>,
): Promise<'recorded' | 'already'> {
  try {
    await db.query(
      `BEGIN TRANSACTION;
       CREATE agreement CONTENT $agreement RETURN NONE;
       CREATE event CONTENT $event RETURN NONE;
       COMMIT TRANSACTION;`,
      {
        agreement: { project: project.id, kind, version, party, user_id: userId },
        event: eventContent({ ...event, data: { ...event.data, kind, version, party } }, project.id),
      },
    );
    return 'recorded';
  } catch (error) {
    if (isDuplicate(error)) return 'already';
    throw error;
  }
}

export async function agreedParties(db: Surreal, project: ProjectRef, kind: AgreementKind, version: number): Promise<Set<Party>> {
  const [rows] = await db.query<[string[]]>(
    'SELECT VALUE party FROM agreement WHERE project = $p AND kind = $kind AND version = $version',
    { p: project.id, kind, version },
  );
  return new Set(rows.filter((party): party is Party => party === 'owner' || party === 'client'));
}

export async function listSpecs(db: Surreal, project: ProjectRef): Promise<Spec[]> {
  const [rows] = await db.query<[unknown[]]>('SELECT * FROM spec WHERE project = $p ORDER BY version', { p: project.id });
  return rows.map((row) => SpecRow.parse(row));
}

export async function listQuotes(db: Surreal, project: ProjectRef): Promise<Quote[]> {
  const [rows] = await db.query<[unknown[]]>('SELECT * FROM quote WHERE project = $p ORDER BY version', { p: project.id });
  return rows.map((row) => QuoteRow.parse(row));
}

export const AgreementRow = z.object({
  kind: z.enum(['spec', 'quote']),
  version: z.number().int(),
  party: z.enum(['owner', 'client']),
  user_id: z.string(),
  at: toDate,
});
export type Agreement = z.infer<typeof AgreementRow>;

export async function listAgreements(db: Surreal, project: ProjectRef): Promise<Agreement[]> {
  const [rows] = await db.query<[unknown[]]>('SELECT kind, version, party, user_id, at FROM agreement WHERE project = $p ORDER BY at', {
    p: project.id,
  });
  return rows.map((row) => AgreementRow.parse(row));
}
