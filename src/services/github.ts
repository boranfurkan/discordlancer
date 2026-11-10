// GitHub: one private repo per project under GITHUB_OWNER, and the client added as a
// collaborator. Repos we create carry the `discordlancer` topic, so we never take
// over an unrelated repo that happens to have the same name.

import { createHash } from 'node:crypto';
import { Octokit } from '@octokit/rest';
import type { Env } from '../env.js';

export const REPO_TOPIC = 'discordlancer';
/** Branches the bot may write to. Nothing else, so it can never touch main or master. */
export const BOT_BRANCH_PREFIX = 'discordlancer/';
const TIMEOUT_MS = 20_000;

export class GitHubError extends Error {
  override name = 'GitHubError';
}

export interface RepoInfo {
  fullName: string;
  url: string;
  created: boolean;
}

export type CollaboratorResult = 'invited' | 'already';

export interface RepoSnapshot {
  branch: string;
  commit: string;
  paths: string[];
  files: Array<{ path: string; content: string }>;
}

export interface PullInfo {
  number: number;
  url: string;
  state: 'open' | 'closed';
  merged: boolean;
  branch: string;
}

interface RawPull {
  number: number;
  html_url: string;
  title: string;
  body?: string | null;
  state: string;
  merged_at?: string | null;
  head: { ref: string };
}

/**
 * Pure: the pull request Tessl opened for an issue. Tessl names its branch
 * `tessl/issue-<n>` and titles the pull request `#<n>: …` (seen on 9 Nov).
 */
export function matchPullForIssue(pulls: readonly RawPull[], issue: number): PullInfo | undefined {
  const branch = `tessl/issue-${issue}`;
  const closes = new RegExp(`\\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\\s+#${issue}\\b`, 'i');
  const pull = pulls.find(
    (candidate) =>
      candidate.head.ref === branch ||
      candidate.head.ref.startsWith(`${branch}-`) ||
      candidate.title.startsWith(`#${issue}:`) ||
      closes.test(candidate.body ?? ''),
  );
  return pull
    ? { number: pull.number, url: pull.html_url, state: pull.state === 'open' ? 'open' : 'closed', merged: Boolean(pull.merged_at), branch: pull.head.ref }
    : undefined;
}

/** What the bot needs from GitHub. Tests use a fake. */
export interface GitHubApi {
  ensureRepo(name: string, description: string): Promise<RepoInfo>;
  addCollaborator(repo: string, username: string): Promise<CollaboratorResult>;
  /** The default branch's file list and the contents of the files chooseFiles() picks. */
  readRepo(repo: string): Promise<RepoSnapshot>;
  /** Opens an issue, then adds the labels in a second call (creating them if missing). */
  openIssue(repo: string, title: string, body: string, labels: string[]): Promise<{ number: number; url: string }>;
  /** The pull request opened for this issue, if there is one yet. */
  findPullForIssue(repo: string, issue: number): Promise<PullInfo | undefined>;
  /** A pull request's current state. */
  getPull(repo: string, number: number): Promise<PullInfo>;
  /** The text files under a folder on the default branch, by path. */
  readFolder(repo: string, folder: string): Promise<Map<string, string>>;
  /**
   * Commits these files on top of the default branch, as one commit on `branch` (made, or
   * reset to it). Only files that differ are written; with none, nothing is committed.
   */
  commitToBranch(repo: string, branch: string, files: ReadonlyArray<RepoFile>, message: string): Promise<CommitResult>;
  /** Opens a pull request from `branch` into the default branch, or updates the open one. */
  upsertPull(repo: string, branch: string, title: string, body: string): Promise<{ number: number; url: string; created: boolean }>;
}

export interface RepoFile {
  path: string;
  content: string;
}

export type CommitResult = { changed: false } | { changed: true; sha: string; base: string; paths: string[] };

/** Pure: the id git gives a file's contents, to tell whether it changed. */
export function gitBlobSha(content: string): string {
  const body = Buffer.from(content, 'utf8');
  return createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body])).digest('hex');
}

/** Pure: a safe repo path for a file we write (no "..", no absolute paths). */
export function isSafePath(path: string): boolean {
  return /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(path) && !path.split('/').includes('..');
}

const SKIP_DIRS = /(^|\/)(node_modules|dist|build|out|coverage|vendor|\.git|\.next|\.venv|__pycache__)\//;
const SKIP_FILES = /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|\.min\.(js|css)|\.map)$/;
const BINARY = /\.(png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|woff2?|ttf|otf|mp4|mp3|wav|jar|exe|dll|so|dylib|lockb)$/i;

export const SNAPSHOT_LIMITS = { maxFiles: 40, maxFileBytes: 30_000, maxTotalBytes: 300_000 };

/** Pure: which files to read for a status check, most useful first, within the limits. */
export function chooseFiles(tree: ReadonlyArray<{ path: string; size: number }>): string[] {
  const candidates = tree.filter(
    (entry) => !SKIP_DIRS.test(entry.path) && !SKIP_FILES.test(entry.path) && !BINARY.test(entry.path) && entry.size <= SNAPSHOT_LIMITS.maxFileBytes,
  );
  const rank = (path: string) => {
    if (/^readme/i.test(path)) return 0;
    if (/^(package\.json|pyproject\.toml|go\.mod|Cargo\.toml)$/.test(path)) return 1;
    if (/^(src|app|lib|pages|components|server|api)\//.test(path)) return 2;
    return 3;
  };
  const sorted = [...candidates].sort((a, b) => rank(a.path) - rank(b.path) || a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
  const chosen: string[] = [];
  let total = 0;
  for (const entry of sorted) {
    if (chosen.length >= SNAPSHOT_LIMITS.maxFiles || total + entry.size > SNAPSHOT_LIMITS.maxTotalBytes) continue;
    chosen.push(entry.path);
    total += entry.size;
  }
  return chosen;
}

// GitHub usernames: letters, digits and single hyphens, up to 39 characters.
export const GITHUB_USERNAME = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

function status(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : undefined;
}

const signal = () => ({ request: { signal: AbortSignal.timeout(TIMEOUT_MS) } });

export function createGitHub(
  env: Pick<Env, 'GITHUB_TOKEN' | 'GITHUB_OWNER'>,
  options: { fetch?: typeof fetch } = {},
): GitHubApi {
  const octokit = new Octokit({
    auth: env.GITHUB_TOKEN,
    userAgent: 'discordlancer',
    ...(options.fetch ? { request: { fetch: options.fetch } } : {}),
  });
  const owner = env.GITHUB_OWNER;

  return {
    async ensureRepo(name, description) {
      try {
        const { data } = await octokit.rest.repos.get({ owner, repo: name, ...signal() });
        if (!data.topics?.includes(REPO_TOPIC)) {
          throw new GitHubError(`A repo named ${owner}/${name} already exists and isn't a Discordlancer project. Pick another name.`);
        }
        return { fullName: data.full_name, url: data.html_url, created: false };
      } catch (error) {
        if (status(error) !== 404) throw error;
      }

      const { data } = await octokit.rest.repos.createForAuthenticatedUser({
        name,
        description,
        private: true,
        auto_init: true,
        has_issues: true,
        ...signal(),
      });
      await octokit.rest.repos.replaceAllTopics({ owner, repo: name, names: [REPO_TOPIC], ...signal() });
      return { fullName: data.full_name, url: data.html_url, created: true };
    },

    async addCollaborator(repo, username) {
      if (!GITHUB_USERNAME.test(username)) throw new GitHubError(`"${username}" isn't a valid GitHub username`);
      const [repoOwner, repoName] = repo.split('/');
      if (!repoOwner || !repoName) throw new GitHubError(`Bad repo name ${repo}`);
      try {
        const response = await octokit.rest.repos.addCollaborator({
          owner: repoOwner,
          repo: repoName,
          username,
          // Read-only: clients can see and clone the code, but never push to it.
          permission: 'pull',
          ...signal(),
        });
        // 201: an invitation was sent. 204: they already have access (a re-invite also
        // sets the permission to read-only).
        return response.status === 201 ? 'invited' : 'already';
      } catch (error) {
        const code = status(error);
        if (code === 404 || code === 422) throw new GitHubError(`GitHub has no user called "${username}"`);
        if (code === 403) {
          throw new GitHubError(
            "GitHub refused this because the bot's GitHub access is missing a permission (Administration: Read and write). Furkan needs to fix it, then try again.",
          );
        }
        throw error;
      }
    },

    async readRepo(repo) {
      const [repoOwner, repoName] = repo.split('/');
      if (!repoOwner || !repoName) throw new GitHubError(`Bad repo name ${repo}`);
      const { data: info } = await octokit.rest.repos.get({ owner: repoOwner, repo: repoName, ...signal() });
      const branch = info.default_branch;
      const { data: ref } = await octokit.rest.repos.getBranch({ owner: repoOwner, repo: repoName, branch, ...signal() });
      const { data: tree } = await octokit.rest.git.getTree({ owner: repoOwner, repo: repoName, tree_sha: ref.commit.sha, recursive: 'true', ...signal() });
      const blobs = tree.tree.filter((entry) => entry.type === 'blob' && entry.path).map((entry) => ({ path: entry.path!, size: entry.size ?? 0 }));
      const files: RepoSnapshot['files'] = [];
      for (const path of chooseFiles(blobs)) {
        const { data } = await octokit.rest.repos.getContent({
          owner: repoOwner,
          repo: repoName,
          path,
          ref: ref.commit.sha,
          mediaType: { format: 'raw' },
          ...signal(),
        });
        files.push({ path, content: typeof data === 'string' ? data : '' });
      }
      return { branch, commit: ref.commit.sha, paths: blobs.map((blob) => blob.path), files };
    },

    async openIssue(repo, title, body, labels) {
      const [repoOwner, repoName] = repo.split('/');
      if (!repoOwner || !repoName) throw new GitHubError(`Bad repo name ${repo}`);
      for (const label of labels) {
        try {
          await octokit.rest.issues.getLabel({ owner: repoOwner, repo: repoName, name: label, ...signal() });
        } catch (error) {
          if (status(error) !== 404) throw error;
          await octokit.rest.issues.createLabel({ owner: repoOwner, repo: repoName, name: label, color: '5319e7', ...signal() });
        }
      }
      const { data: issue } = await octokit.rest.issues.create({ owner: repoOwner, repo: repoName, title, body, ...signal() });
      // Added in a second call: the Tessl docs don't say a label present at creation starts a run.
      if (labels.length) await octokit.rest.issues.addLabels({ owner: repoOwner, repo: repoName, issue_number: issue.number, labels, ...signal() });
      return { number: issue.number, url: issue.html_url };
    },

    async findPullForIssue(repo, issue) {
      const [repoOwner, repoName] = repo.split('/');
      if (!repoOwner || !repoName) throw new GitHubError(`Bad repo name ${repo}`);
      const { data } = await octokit.rest.pulls.list({
        owner: repoOwner,
        repo: repoName,
        state: 'all',
        sort: 'created',
        direction: 'desc',
        per_page: 30,
        ...signal(),
      });
      return matchPullForIssue(data, issue);
    },

    async readFolder(repo, folder) {
      const [repoOwner, repoName] = repo.split('/');
      if (!repoOwner || !repoName) throw new GitHubError(`Bad repo name ${repo}`);
      const { data: info } = await octokit.rest.repos.get({ owner: repoOwner, repo: repoName, ...signal() });
      const { data: ref } = await octokit.rest.repos.getBranch({ owner: repoOwner, repo: repoName, branch: info.default_branch, ...signal() });
      const { data: tree } = await octokit.rest.git.getTree({ owner: repoOwner, repo: repoName, tree_sha: ref.commit.sha, recursive: 'true', ...signal() });
      const files = new Map<string, string>();
      const wanted = tree.tree.filter((entry) => entry.type === 'blob' && entry.path?.startsWith(`${folder}/`) && (entry.size ?? 0) <= 200_000).slice(0, 60);
      for (const entry of wanted) {
        const { data } = await octokit.rest.repos.getContent({ owner: repoOwner, repo: repoName, path: entry.path!, ref: ref.commit.sha, mediaType: { format: 'raw' }, ...signal() });
        if (typeof data === 'string') files.set(entry.path!, data);
      }
      return files;
    },

    async commitToBranch(repo, branch, files, message) {
      const [repoOwner, repoName] = repo.split('/');
      if (!repoOwner || !repoName) throw new GitHubError(`Bad repo name ${repo}`);
      // The bot only ever writes to its own branches; people merge them.
      if (!branch.startsWith(BOT_BRANCH_PREFIX) || !isSafePath(branch)) throw new GitHubError(`Refusing to write to the branch ${branch}`);
      const unsafe = files.find((file) => !isSafePath(file.path));
      if (unsafe) throw new GitHubError(`Refusing to write the path ${unsafe.path}`);
      const where = { owner: repoOwner, repo: repoName };
      const { data: info } = await octokit.rest.repos.get({ ...where, ...signal() });
      const base = info.default_branch;
      const { data: baseRef } = await octokit.rest.git.getRef({ ...where, ref: `heads/${base}`, ...signal() });
      const baseSha = baseRef.object.sha;
      const { data: baseCommit } = await octokit.rest.git.getCommit({ ...where, commit_sha: baseSha, ...signal() });
      const { data: tree } = await octokit.rest.git.getTree({ ...where, tree_sha: baseCommit.tree.sha, recursive: 'true', ...signal() });
      const existing = new Map(tree.tree.filter((entry) => entry.type === 'blob').map((entry) => [entry.path, entry.sha]));
      const changed = files.filter((file) => existing.get(file.path) !== gitBlobSha(file.content));
      if (changed.length === 0) return { changed: false };
      const { data: newTree } = await octokit.rest.git.createTree({
        ...where,
        base_tree: baseCommit.tree.sha,
        tree: changed.map((file) => ({ path: file.path, mode: '100644' as const, type: 'blob' as const, content: file.content })),
        ...signal(),
      });
      const { data: commit } = await octokit.rest.git.createCommit({ ...where, message, tree: newTree.sha, parents: [baseSha], ...signal() });
      try {
        await octokit.rest.git.updateRef({ ...where, ref: `heads/${branch}`, sha: commit.sha, force: true, ...signal() });
      } catch (error) {
        if (status(error) !== 422 && status(error) !== 404) throw error;
        await octokit.rest.git.createRef({ ...where, ref: `refs/heads/${branch}`, sha: commit.sha, ...signal() });
      }
      return { changed: true, sha: commit.sha, base, paths: changed.map((file) => file.path) };
    },

    async upsertPull(repo, branch, title, body) {
      const [repoOwner, repoName] = repo.split('/');
      if (!repoOwner || !repoName) throw new GitHubError(`Bad repo name ${repo}`);
      const where = { owner: repoOwner, repo: repoName };
      const { data: open } = await octokit.rest.pulls.list({ ...where, head: `${repoOwner}:${branch}`, state: 'open', ...signal() });
      const existing = open[0];
      if (existing) {
        const { data } = await octokit.rest.pulls.update({ ...where, pull_number: existing.number, title, body, ...signal() });
        return { number: data.number, url: data.html_url, created: false };
      }
      const { data: info } = await octokit.rest.repos.get({ ...where, ...signal() });
      const { data } = await octokit.rest.pulls.create({ ...where, title, body, head: branch, base: info.default_branch, ...signal() });
      return { number: data.number, url: data.html_url, created: true };
    },

    async getPull(repo, number) {
      const [repoOwner, repoName] = repo.split('/');
      if (!repoOwner || !repoName) throw new GitHubError(`Bad repo name ${repo}`);
      const { data } = await octokit.rest.pulls.get({ owner: repoOwner, repo: repoName, pull_number: number, ...signal() });
      return { number: data.number, url: data.html_url, state: data.state === 'open' ? 'open' : 'closed', merged: data.merged, branch: data.head.ref };
    },
  };
}
