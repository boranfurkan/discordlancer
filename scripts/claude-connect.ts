// Connects a Claude Code session to one project, run on Boran's laptop from this repo:
//   npm run claude:connect -- <project> [folder] [--url https://…/mcp]
//
// 1. Clones the project's repo into the folder (default ~/Desktop/<project>) if it isn't
//    there yet, and checks an existing folder really is that project's repo.
// 2. Makes a new key for the project and stores only its hash (an older key stops working).
// 3. Adds the bot's MCP server to Claude Code for that folder only (local scope, kept in
//    ~/.claude.json), with the key as its header. The key is never printed.
// 4. Writes CLAUDE.md's "Client progress updates" section and the /update-client command.
// 5. Checks the live bot accepts the key.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { closeDatabase, connectDatabase } from '../src/db/client.js';
import { getProjectByName, updateProject } from '../src/db/projects.js';
import { hashDevKey, newDevKey } from '../src/domain/devKey.js';
import { loadEnv, secretValues } from '../src/env.js';
import { registerSecrets, scrub } from '../src/log.js';
import { COMMAND_PATH, DEFAULT_MCP_URL, MCP_SERVER_NAME, remoteMatches, UPDATE_COMMAND, withClaudeSection } from '../src/mcp/repoFiles.js';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const [value] = args.splice(index, 2).slice(1);
  return value;
};
const url = flag('url') ?? DEFAULT_MCP_URL;
const [name, folderArg] = args;
if (!name || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
  console.error('Usage: npm run claude:connect -- <project> [folder] [--url https://…/mcp]');
  process.exit(2);
}
const folder = resolve(folderArg ?? join(homedir(), 'Desktop', name));

function fail(message: string): never {
  console.error(`✗ ${scrub(message)}`);
  process.exit(1);
}

function run(command: string, commandArgs: string[], cwd?: string, quiet = false) {
  const result = spawnSync(command, commandArgs, { cwd, encoding: 'utf8', stdio: quiet ? 'pipe' : ['ignore', 'pipe', 'pipe'] });
  return { ok: result.status === 0, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

const env = loadEnv();
registerSecrets(secretValues(env));
const db = await connectDatabase(env);
try {
  const project = await getProjectByName(db, name);
  if (!project) fail(`No project called "${name}". Check the name with /project in its channel.`);
  if (project.stage === 'cancelled' || project.stage === 'archived') fail(`${name} is ${project.stage}, so there's nothing to connect.`);
  if (!run('claude', ['--version'], undefined, true).ok) fail('Claude Code (the `claude` command) is not installed or not on the PATH.');

  // 1. The folder must be this project's repo: a session in the wrong folder would post to the wrong client.
  if (!existsSync(folder)) {
    console.log(`Cloning ${project.repo} into ${folder}…`);
    const clone = run('gh', ['repo', 'clone', project.repo, folder]);
    if (!clone.ok) fail(`Couldn't clone ${project.repo}: ${clone.out}`);
  }
  const remote = run('git', ['remote', 'get-url', 'origin'], folder);
  if (!remote.ok || !remoteMatches(remote.out, project.repo)) {
    fail(`${folder} isn't a clone of ${project.repo} (its origin is ${remote.ok ? remote.out : 'missing'}). Pick the right folder.`);
  }

  // 2. A new key; only its hash is stored, with an event for the audit trail.
  const key = newDevKey();
  registerSecrets([key]);
  await updateProject(
    db,
    project,
    { dev_key_hash: hashDevKey(key) },
    { actor: 'owner', actorId: env.DISCORD_OWNER_ID, action: 'project.claude_connected', outcome: 'ok', data: { via: 'claude-connect', replaced_key: Boolean(project.dev_key_hash) } },
  );

  // 3. Claude Code, for this folder only. Replaces an earlier entry.
  run('claude', ['mcp', 'remove', MCP_SERVER_NAME, '--scope', 'local'], folder, true);
  const added = run('claude', ['mcp', 'add', '--transport', 'http', '--scope', 'local', MCP_SERVER_NAME, url, '--header', `Authorization: Bearer ${key}`], folder, true);
  if (!added.ok) fail(`Claude Code didn't accept the server: ${added.out}`);

  // 4. The repo files (no key in them).
  const claudeMd = join(folder, 'CLAUDE.md');
  writeFileSync(claudeMd, withClaudeSection(existsSync(claudeMd) ? readFileSync(claudeMd, 'utf8') : undefined));
  const command = join(folder, COMMAND_PATH);
  mkdirSync(dirname(command), { recursive: true });
  writeFileSync(command, UPDATE_COMMAND);

  // 5. The live bot must know the key.
  let check = 'not checked';
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json().catch(() => ({}))) as { result?: { tools?: Array<{ name: string }> } };
    check = response.ok && body.result?.tools?.length
      ? `ok (${body.result.tools.map((tool) => tool.name).join(', ')})`
      : `failed: HTTP ${response.status}. Is the latest bot deployed on Replit?`;
  } catch (error) {
    check = `failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  console.log(
    [
      `✓ Connected Claude Code to ${name}${project.dev_key_hash ? ' (the previous key no longer works)' : ''}.`,
      `- Folder: ${folder}`,
      `- MCP server "${MCP_SERVER_NAME}" added for this folder only, at ${url}. The key is in Claude Code's local config, not in the repo.`,
      `- Wrote CLAUDE.md's "Client progress updates" section and ${COMMAND_PATH}. They hold no key; commit them with your first change.`,
      `- Live check: ${check}`,
      '',
      `Next: open Claude Code in ${folder}. /mcp should show "${MCP_SERVER_NAME}" connected, and /update-client posts an update.`,
    ].join('\n'),
  );
} finally {
  await closeDatabase(db, 1000);
}
process.exit(0);
