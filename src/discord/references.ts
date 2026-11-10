// /review-repo: reads an existing codebase (a GitHub repo, or a zip posted in the chat),
// has Gemini write reference notes on it for the new project, saves them, and opens a
// pull request adding them to the project's repo as docs/references/<name>.md. The notes
// then feed the specs, /ask, /sync-docs and Claude Code's brief.

import { createHash } from 'node:crypto';
import { latestSpec } from '../db/deals.js';
import { fileNotesFor } from '../db/files.js';
import type { Project } from '../db/projects.js';
import { referenceReviewsFor, saveRepoReview, type RepoReview } from '../db/references.js';
import { readZip } from '../files/zip.js';
import { REPO_REVIEW_PROMPT_VERSION, REPO_REVIEW_SCHEMA, REPO_REVIEW_SYSTEM, RepoReviewOutput } from '../prompts/repoReview.js';
import { SPEC_MODEL } from '../services/gemini.js';
import { chooseFiles, GITHUB_USERNAME, REVIEW_LIMITS, reviewRank, type RepoSnapshot } from '../services/github.js';
import type { BotContext } from './command.js';
import { OWNER_NAME } from './guards.js';

export const REFERENCES_FOLDER = 'docs/references';

const fence = (tag: string, text: string, attrs = '') => `<${tag}${attrs}>\n${text}\n</${tag}>`;
const day = (date: Date) => date.toISOString().slice(0, 10);

/** Pure: "owner/name" (and a branch, if the link names one) from a GitHub link or "owner/name". */
export function parseRepoRef(input: string): { owner: string; name: string; branch?: string } | undefined {
  const text = input.trim();
  const short = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(text);
  if (short) return GITHUB_USERNAME.test(short[1]!) ? { owner: short[1]!, name: short[2]! } : undefined;
  const ssh = /^git@github\.com:([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(text);
  if (ssh) return { owner: ssh[1]!, name: ssh[2]! };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (!['github.com', 'www.github.com'].includes(url.hostname)) return undefined;
  const [owner, rawName, kind, ...rest] = url.pathname.split('/').filter(Boolean);
  const name = rawName?.replace(/\.git$/, '');
  if (!owner || !name || !GITHUB_USERNAME.test(owner) || !/^[A-Za-z0-9._-]+$/.test(name)) return undefined;
  const branch = kind === 'tree' && rest.length ? decodeURIComponent(rest.join('/')) : undefined;
  return branch ? { owner, name, branch } : { owner, name };
}

/** Pure: a name safe for a file and a branch: "Acme/Old_App" → "acme-old_app". */
export function referenceSlug(repo: string): string {
  return repo
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Pure: a codebase uploaded as a zip, as a snapshot like one read from GitHub. */
export function snapshotFromZip(file: Buffer): RepoSnapshot {
  const zip = readZip(file);
  const entries = zip.entries.filter((entry) => !entry.name.endsWith('/') && !entry.name.startsWith('__MACOSX/') && !entry.encrypted);
  // Most zips of a project have one top folder; drop it from the paths.
  const tops = new Set(entries.map((entry) => entry.name.split('/')[0]));
  const strip = tops.size === 1 && entries.every((entry) => entry.name.includes('/')) ? `${[...tops][0]}/` : '';
  const blobs = entries.map((entry) => ({ path: entry.name.slice(strip.length), size: entry.size, original: entry.name }));
  const chosen = new Set(chooseFiles(blobs, REVIEW_LIMITS, reviewRank));
  const files: RepoSnapshot['files'] = [];
  for (const blob of blobs) {
    if (!chosen.has(blob.path)) continue;
    const content = zip.read(blob.original);
    if (content && !content.subarray(0, 8_000).includes(0)) files.push({ path: blob.path, content: content.toString('utf8') });
  }
  return { branch: 'upload', commit: createHash('sha256').update(file).digest('hex'), paths: blobs.map((blob) => blob.path), files };
}

/** Pure: the repository for the prompt: every path (up to a limit), then the files read. */
export function renderRepository(label: string, snapshot: RepoSnapshot): string {
  const listed = snapshot.paths.slice(0, 3_000);
  return fence(
    'repository',
    [
      fence('file_list', `${listed.join('\n')}${snapshot.paths.length > listed.length ? `\n…and ${snapshot.paths.length - listed.length} more` : ''}`),
      ...snapshot.files.map((file) => fence('file', file.content, ` path="${file.path}"`)),
    ].join('\n'),
    ` name="${label}" branch="${snapshot.branch}" commit="${snapshot.commit.slice(0, 12)}" files_listed="${snapshot.paths.length}" files_read="${snapshot.files.length}"`,
  );
}

/** Pure: the reviewed repos in a prompt, newest review of each, cut to fit. */
export function renderReferences(reviews: readonly RepoReview[], limits = { perRepo: 20_000, total: 60_000 }): string {
  if (reviews.length === 0) return '';
  const blocks: string[] = [];
  let used = 0;
  for (const review of [...reviews].reverse()) {
    const notes = review.markdown.length > limits.perRepo ? `${review.markdown.slice(0, limits.perRepo)}\n<notes cut>` : review.markdown;
    const block = fence('repo', `Why it matters (${OWNER_NAME}): ${review.about}\nSummary (AI): ${review.summary}\n\n${notes}`, ` name="${review.repo}" commit="${review.commit.slice(0, 7)}" reviewed="${day(review.created_at)}"`);
    if (used + block.length > limits.total && blocks.length) break;
    blocks.unshift(block);
    used += block.length;
  }
  return fence('reference_repos', blocks.join('\n'));
}

/** Pure: the reference notes as a file in the project's repo. */
export function referenceDoc(review: Pick<RepoReview, 'repo' | 'source' | 'url' | 'branch' | 'commit' | 'about' | 'markdown' | 'files_read' | 'files_listed' | 'created_at'>): string {
  const where = review.source === 'github' ? `[${review.repo}](${review.url ?? `https://github.com/${review.repo}`}) at \`${review.commit.slice(0, 7)}\` (${review.branch})` : `a zip posted in the project channel (\`${review.repo.replace(/^upload\//, '')}\`)`;
  return [
    `> Reference notes on ${where}, reviewed on ${day(review.created_at)}: ${review.files_read} of ${review.files_listed} files read, not run.`,
    `> Why it matters: ${review.about}`,
    '>',
    `> AI-written by Discordlancer (Google Gemini \`${SPEC_MODEL}\`, prompt \`${REPO_REVIEW_PROMPT_VERSION}\`). This is context about existing code; the agreed spec decides what gets built.`,
    '',
    review.markdown.trim(),
    '',
  ].join('\n');
}

/** Pure: the message in the project channel, marked as an AI review. */
export function reviewPost(review: Pick<RepoReview, 'repo' | 'commit' | 'source' | 'summary' | 'reuse' | 'risks' | 'questions' | 'files_read' | 'doc_path'>, pull?: { url: string } | undefined, note?: string): string {
  const list = (items: readonly string[], max: number) => items.slice(0, max).map((item) => `- ${item}`);
  const lines = [
    `🔎 **Reviewed \`${review.repo}\`**${review.source === 'github' ? ` at \`${review.commit.slice(0, 7)}\`` : ''} (${review.files_read} files read)`,
    review.summary,
    ...(review.reuse.length ? ['', '**Can be reused**', ...list(review.reuse, 4)] : []),
    ...(review.risks.length ? ['', '**Gaps and risks**', ...list(review.risks, 4)] : []),
    ...(review.questions.length ? ['', '**Questions**', ...list(review.questions, 3)] : []),
    '',
    pull ? `Full notes: ${pull.url} (\`${review.doc_path}\`)` : note ?? '',
    `-# AI review (Google Gemini) of the code, read and not run. ${OWNER_NAME} checks it; the agreed spec decides what gets built.`,
  ];
  const text = lines.filter((line, index) => line !== '' || lines[index - 1] !== '').join('\n');
  return text.length <= 1_950 ? text : `${text.slice(0, 1_880).trimEnd()}…\n-# AI review, shortened here; the full notes are in the pull request.`;
}

/** Pure: what the new project is so far, for the reviewer. */
function projectContext(project: Project, spec: string | undefined, files: string[]): string {
  return fence(
    'project',
    [
      `Name: ${project.name}`,
      spec ? `Latest spec:\n${spec.slice(0, 20_000)}` : 'No spec written yet.',
      files.length ? `Files the client shared:\n${files.join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
  );
}

export interface ReviewSource {
  kind: 'github' | 'zip';
  /** "owner/name", or "upload/<zip name>". */
  label: string;
  url?: string | undefined;
  snapshot: RepoSnapshot;
}

/** Reads nothing itself: reviews a snapshot already read, and saves the review. */
export async function reviewSnapshot(ctx: BotContext, project: Project, source: ReviewSource, about: string, actorId: string): Promise<RepoReview> {
  const [spec, files] = await Promise.all([latestSpec(ctx.db, project), fileNotesFor(ctx.db, project).catch(() => [])]);
  const shared = files.filter((note) => note.status === 'read').map((note) => `- ${note.title}: ${note.summary}`);
  const output = await ctx.gemini.json({
    model: SPEC_MODEL,
    system: REPO_REVIEW_SYSTEM,
    input: [{ type: 'text', text: [projectContext(project, spec?.markdown, shared), fence('about', about), renderRepository(source.label, source.snapshot)].join('\n\n') }],
    schema: REPO_REVIEW_SCHEMA,
    parse: RepoReviewOutput,
    thinking: 'medium',
    maxOutputTokens: 32_000,
  });
  return saveRepoReview(
    ctx.db,
    project,
    {
      repo: source.label,
      source: source.kind,
      url: source.url,
      branch: source.snapshot.branch,
      commit: source.snapshot.commit,
      about,
      summary: output.summary,
      markdown: output.markdown,
      reuse: output.reuse,
      risks: output.risks,
      questions: output.questions,
      files_listed: source.snapshot.paths.length,
      files_read: source.snapshot.files.length,
      doc_path: `${REFERENCES_FOLDER}/${referenceSlug(source.label)}.md`,
      model: SPEC_MODEL,
      prompt_version: REPO_REVIEW_PROMPT_VERSION,
    },
    {
      actor: 'owner',
      actorId,
      action: 'repo.reviewed',
      outcome: 'ok',
      data: { repo: source.label, source: source.kind, commit: source.snapshot.commit.slice(0, 12), files_read: source.snapshot.files.length, model: SPEC_MODEL, prompt_version: REPO_REVIEW_PROMPT_VERSION },
    },
  );
}

/** Every reviewed repo's label, for the docs' citation check. */
export async function reviewedRepos(ctx: BotContext, project: Project): Promise<RepoReview[]> {
  return referenceReviewsFor(ctx.db, project).catch(() => []);
}
