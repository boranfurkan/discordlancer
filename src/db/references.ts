// Repo reviews (append-only): AI reference notes on an existing codebase, saved once
// with their event. Reviewing the same repo again adds a newer record.

import { RecordId, type Surreal } from 'surrealdb';
import { z } from 'zod';
import type { EventInput } from './events.js';
import { eventContent, toDate, type Project } from './projects.js';

export const RepoReviewRow = z.object({
  id: z.custom<RecordId<'repo_review'>>((value) => value instanceof RecordId),
  project: z.custom<RecordId<'project'>>((value) => value instanceof RecordId),
  repo: z.string(),
  source: z.enum(['github', 'zip']),
  url: z.string().optional(),
  branch: z.string(),
  commit: z.string(),
  about: z.string(),
  summary: z.string(),
  markdown: z.string(),
  reuse: z.array(z.string()),
  risks: z.array(z.string()),
  questions: z.array(z.string()),
  files_listed: z.number().int(),
  files_read: z.number().int(),
  doc_path: z.string(),
  model: z.string(),
  prompt_version: z.string(),
  created_at: toDate,
});
export type RepoReview = z.infer<typeof RepoReviewRow>;

export type NewRepoReview = Omit<RepoReview, 'id' | 'project' | 'created_at'>;

export async function saveRepoReview(db: Surreal, project: Pick<Project, 'id'>, review: NewRepoReview, event: Omit<EventInput, 'project'>): Promise<RepoReview> {
  const id = new RecordId('repo_review', crypto.randomUUID());
  const content: Record<string, unknown> = { ...review, project: project.id };
  if (review.url === undefined) delete content.url;
  await db.query(
    `BEGIN TRANSACTION;
     CREATE ONLY $id CONTENT $content RETURN NONE;
     CREATE event CONTENT $event RETURN NONE;
     COMMIT TRANSACTION;`,
    { id, content, event: eventContent({ ...event, data: { ...event.data, repo_review: id.toString() } }, project.id) },
  );
  const [rows] = await db.query<[unknown[]]>('SELECT * FROM $id', { id });
  return RepoReviewRow.parse(rows[0]);
}

/** The newest review of each repo for this project, oldest repo first. */
export async function referenceReviewsFor(db: Surreal, project: Pick<Project, 'id'>): Promise<RepoReview[]> {
  const [rows] = await db.query<[unknown[]]>('SELECT * FROM repo_review WHERE project = $p ORDER BY created_at', { p: project.id });
  const latest = new Map<string, RepoReview>();
  for (const row of rows) {
    const review = RepoReviewRow.parse(row);
    latest.delete(review.repo);
    latest.set(review.repo, review);
  }
  return [...latest.values()];
}
