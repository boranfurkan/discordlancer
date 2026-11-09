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

/** What the bot needs from GitHub. Tests use a fake. */
export interface GitHubApi {
  ensureRepo(name: string, description: string): Promise<RepoInfo>;
  addCollaborator(repo: string, username: string): Promise<CollaboratorResult>;
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
  };
}
