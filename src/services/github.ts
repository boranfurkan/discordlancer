// GitHub: one private repo per project under GITHUB_OWNER, and the client added as a
// collaborator. Repos we create carry the `discordlancer` topic, so we never take
// over an unrelated repo that happens to have the same name.

import { Octokit } from '@octokit/rest';
import type { Env } from '../env.js';

export const REPO_TOPIC = 'discordlancer';
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

/** What the bot needs from GitHub. Tests use a fake. */
export interface GitHubApi {
  ensureRepo(name: string, description: string): Promise<RepoInfo>;
  addCollaborator(repo: string, username: string): Promise<CollaboratorResult>;
  /** The default branch's file list and the contents of the files chooseFiles() picks. */
  readRepo(repo: string): Promise<RepoSnapshot>;
  /** Opens an issue, then adds the labels in a second call (creating them if missing). */
  openIssue(repo: string, title: string, body: string, labels: string[]): Promise<{ number: number; url: string }>;
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
          permission: 'push',
          ...signal(),
        });
        // 201: an invitation was sent. 204: they already have access.
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
  };
}
