import { RecordId, type Surreal } from 'surrealdb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getProjectByName, type Project } from '../src/db/projects.js';
import { referenceReviewsFor, saveRepoReview, type NewRepoReview } from '../src/db/references.js';
import { parseRepoRef, referenceDoc, referenceSlug, renderReferences, reviewPost, snapshotFromZip } from '../src/discord/references.js';
import { chooseFiles, REVIEW_LIMITS, reviewRank } from '../src/services/github.js';
import { memoryDb } from './helpers/db.js';
import { makeZip } from './helpers/zip.js';

describe('parseRepoRef', () => {
  it('reads GitHub links, owner/name and SSH addresses, with a branch from /tree/', () => {
    expect(parseRepoRef('acme/old-app')).toEqual({ owner: 'acme', name: 'old-app' });
    expect(parseRepoRef('https://github.com/acme/old-app.git')).toEqual({ owner: 'acme', name: 'old-app' });
    expect(parseRepoRef('https://github.com/acme/old-app/tree/feature/login')).toEqual({ owner: 'acme', name: 'old-app', branch: 'feature/login' });
    expect(parseRepoRef('git@github.com:acme/old-app.git')).toEqual({ owner: 'acme', name: 'old-app' });
  });

  it('refuses anything else', () => {
    for (const input of ['https://gitlab.com/acme/app', 'acme', 'https://github.com/acme', '../etc/passwd', 'https://github.com/-bad-/x']) {
      expect(parseRepoRef(input), input).toBeUndefined();
    }
  });

  it('makes safe file and branch names', () => {
    expect(referenceSlug('Acme/Old_App')).toBe('acme-old_app');
    expect(referenceSlug('upload/My Project (v2)')).toBe('upload-my-project-v2');
  });
});

describe('choosing files for a review', () => {
  it('reads the README, manifests, docs and schemas before the code, and tests last', () => {
    const tree = ['src/app.ts', 'test/app.test.ts', 'test-d/schema-types.ts', 'README.md', 'package.json', 'prisma/schema.prisma', 'docs/api.md', 'src/routes/users.ts', 'node_modules/x/index.js', 'logo.png'].map((path) => ({ path, size: 100 }));
    expect(chooseFiles(tree, REVIEW_LIMITS, reviewRank)).toEqual(['README.md', 'package.json', 'docs/api.md', 'prisma/schema.prisma', 'src/routes/users.ts', 'src/app.ts', 'test-d/schema-types.ts', 'test/app.test.ts']);
  });

  it('reads an uploaded zip, without its top folder, node_modules or macOS extras', () => {
    const snapshot = snapshotFromZip(
      makeZip({ 'old-app/README.md': '# Old app', 'old-app/src/index.ts': 'export {}', 'old-app/node_modules/x/y.js': 'no', '__MACOSX/old-app/._README.md': 'junk' }),
    );
    expect(snapshot.paths).toEqual(['README.md', 'src/index.ts', 'node_modules/x/y.js']);
    expect(snapshot.files.map((file) => file.path)).toEqual(['README.md', 'src/index.ts']);
    expect(snapshot.branch).toBe('upload');
  });
});

let db: Surreal;
let project: Project;
const review = (repo: string, summary: string): NewRepoReview => ({
  repo,
  source: 'github',
  url: `https://github.com/${repo}`,
  branch: 'main',
  commit: 'abc1234def',
  about: 'Their current app',
  summary,
  markdown: `# ${repo}: reference notes\n\n## What it is\nAn app.`,
  reuse: ['Auth module'],
  risks: ['No tests'],
  questions: ['Still live?'],
  files_listed: 10,
  files_read: 8,
  doc_path: `docs/references/${referenceSlug(repo)}.md`,
  model: 'gemini-test',
  prompt_version: 'repo-review-v1',
});

beforeAll(async () => {
  db = await memoryDb();
  await db.query('CREATE $id CONTENT $content', { id: new RecordId('project', 'demo'), content: { name: 'demo', channel_id: 'c', repo: 'me/demo', stage: 'joined' } });
  project = (await getProjectByName(db, 'demo'))!;
});
afterAll(async () => {
  await db.close();
});

describe('saved reviews', () => {
  it('keep the newest review of each repo, and are append-only', async () => {
    const event = { actor: 'owner' as const, action: 'repo.reviewed', outcome: 'ok' as const };
    await saveRepoReview(db, project, review('acme/a', 'first'), event);
    await saveRepoReview(db, project, review('acme/b', 'other'), event);
    await saveRepoReview(db, project, review('acme/a', 'second'), event);
    const latest = await referenceReviewsFor(db, project);
    expect(latest.map((item) => [item.repo, item.summary])).toEqual([
      ['acme/b', 'other'],
      ['acme/a', 'second'],
    ]);
    await expect(db.query("UPDATE repo_review SET summary = 'changed'")).rejects.toThrow(/append-only/);

    const prompt = renderReferences(latest);
    expect(prompt.startsWith('<reference_repos>')).toBe(true);
    expect(prompt).toContain('<repo name="acme/a" commit="abc1234"');
    expect(prompt).toContain('Why it matters (Furkan): Their current app');

    const doc = referenceDoc(latest[1]!);
    expect(doc).toContain('[acme/a](https://github.com/acme/a) at `abc1234` (main)');
    expect(doc).toContain('AI-written by Discordlancer');
    expect(doc).toContain('the agreed spec decides what gets built');

    const post = reviewPost({ ...latest[1]!, summary: 'x'.repeat(3_000) }, { url: 'https://github.com/me/demo/pull/1' });
    expect(post.length).toBeLessThanOrEqual(2_000);
    expect(post).toContain('AI review');
  });
});
