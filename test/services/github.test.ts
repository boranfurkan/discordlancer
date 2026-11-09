import { describe, expect, it } from 'vitest';
import { createGitHub, GitHubError, GITHUB_USERNAME, REPO_TOPIC } from '../../src/services/github.js';

const env = { GITHUB_TOKEN: 'token-for-tests', GITHUB_OWNER: 'example-owner' };

type Call = { method: string; path: string; body?: unknown };

/** A fake GitHub: answers by method and path, and records every call. */
function fakeFetch(routes: Record<string, (body: unknown) => { status: number; json?: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body });
    const route = routes[`${method} ${url.pathname}`];
    const answer = route ? route(body) : { status: 500, json: { message: `no fake for ${method} ${url.pathname}` } };
    return new Response(answer.json === undefined ? null : JSON.stringify(answer.json), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const repoJson = (topics: string[]) => ({
  full_name: 'example-owner/alpha',
  html_url: 'https://github.com/example-owner/alpha',
  topics,
});

describe('ensureRepo', () => {
  it('creates a private repo with a README and tags it, when none exists', async () => {
    const { fetchImpl, calls } = fakeFetch({
      'GET /repos/example-owner/alpha': () => ({ status: 404, json: { message: 'Not Found' } }),
      'POST /user/repos': () => ({ status: 201, json: repoJson([]) }),
      'PUT /repos/example-owner/alpha/topics': () => ({ status: 200, json: { names: [REPO_TOPIC] } }),
    });
    const repo = await createGitHub(env, { fetch: fetchImpl }).ensureRepo('alpha', 'desc');
    expect(repo).toEqual({ fullName: 'example-owner/alpha', url: 'https://github.com/example-owner/alpha', created: true });
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ name: 'alpha', private: true, auto_init: true });
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ names: [REPO_TOPIC] });
  });

  it('reuses a repo it created before', async () => {
    const { fetchImpl, calls } = fakeFetch({
      'GET /repos/example-owner/alpha': () => ({ status: 200, json: repoJson([REPO_TOPIC]) }),
    });
    const repo = await createGitHub(env, { fetch: fetchImpl }).ensureRepo('alpha', 'desc');
    expect(repo.created).toBe(false);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('never takes over an unrelated repo with the same name', async () => {
    const { fetchImpl, calls } = fakeFetch({
      'GET /repos/example-owner/alpha': () => ({ status: 200, json: repoJson(['personal']) }),
    });
    await expect(createGitHub(env, { fetch: fetchImpl }).ensureRepo('alpha', 'desc')).rejects.toThrow(GitHubError);
    expect(calls.map((c) => c.method)).toEqual(['GET']);
  });
});

describe('addCollaborator', () => {
  it('reports a new invitation and an existing collaborator', async () => {
    const invited = fakeFetch({ 'PUT /repos/example-owner/alpha/collaborators/octocat': () => ({ status: 201, json: {} }) });
    expect(await createGitHub(env, { fetch: invited.fetchImpl }).addCollaborator('example-owner/alpha', 'octocat')).toBe('invited');
    expect(invited.calls[0]?.body).toEqual({ permission: 'pull' }); // read-only

    const already = fakeFetch({ 'PUT /repos/example-owner/alpha/collaborators/octocat': () => ({ status: 204 }) });
    expect(await createGitHub(env, { fetch: already.fetchImpl }).addCollaborator('example-owner/alpha', 'octocat')).toBe('already');
  });

  it('explains an unknown user', async () => {
    const { fetchImpl } = fakeFetch({
      'PUT /repos/example-owner/alpha/collaborators/nobody-here': () => ({ status: 404, json: { message: 'Not Found' } }),
    });
    await expect(createGitHub(env, { fetch: fetchImpl }).addCollaborator('example-owner/alpha', 'nobody-here')).rejects.toThrow(
      /no user called "nobody-here"/,
    );
  });

  it('explains a token that lacks the Administration permission', async () => {
    const { fetchImpl } = fakeFetch({
      'PUT /repos/example-owner/alpha/collaborators/octocat': () => ({
        status: 403,
        json: { message: 'Resource not accessible by personal access token' },
      }),
    });
    await expect(createGitHub(env, { fetch: fetchImpl }).addCollaborator('example-owner/alpha', 'octocat')).rejects.toThrow(
      /Administration: Read and write/,
    );
  });

  it('refuses an invalid username without calling GitHub', async () => {
    const { fetchImpl, calls } = fakeFetch({});
    await expect(createGitHub(env, { fetch: fetchImpl }).addCollaborator('example-owner/alpha', 'bad name')).rejects.toThrow(
      /isn't a valid GitHub username/,
    );
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['octocat', true],
    ['a-b-c', true],
    ['a', true],
    ['-start', false],
    ['end-', false],
    ['double--hyphen', false],
    ['x'.repeat(40), false],
  ])('username %j valid: %s', (name, valid) => {
    expect(GITHUB_USERNAME.test(name)).toBe(valid);
  });
});
