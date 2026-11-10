// What `npm run claude:connect` writes into a client's repo, so a Claude Code session
// there knows the client follows along in Discord. The client can read the repo, so
// none of this holds a key: the key goes into Claude Code's local config only.

import { OWNER_NAME } from '../discord/guards.js';
import { UPDATES_PER_DAY } from './updates.js';

export const DEFAULT_MCP_URL = 'https://discordlancer.replit.app/mcp';
/** The name Claude Code knows the server by; its tools become mcp__discordlancer__*. */
export const MCP_SERVER_NAME = 'discordlancer';
export const COMMAND_PATH = '.claude/commands/update-client.md';

const START = '<!-- discordlancer:start -->';
const END = '<!-- discordlancer:end -->';

export const CLAUDE_SECTION = `${START}
## Client progress updates

The client follows this project in a private Discord channel with ${OWNER_NAME}. The \`${MCP_SERVER_NAME}\` MCP server links this repo to that channel:
- \`get_project_brief\`: the agreed spec, the deadline and the updates already posted. Read it at the start of each work session.
- \`post_update\`: posts a progress update in the client's channel, marked as written by an AI coding assistant.

Post an update when a meaningful piece of work is finished and at the end of a work session (at most ${UPDATES_PER_DAY} a day), or when asked with \`/update-client\`. Write plainly for the client, report only what is done and checked, never promise dates, prices or features beyond the agreed spec, and never include secrets.
${END}`;

/** Pure: CLAUDE.md with our section added, or replaced if it is already there. */
export function withClaudeSection(existing: string | undefined): string {
  if (!existing?.trim()) return `${CLAUDE_SECTION}\n`;
  const start = existing.indexOf(START);
  const end = existing.indexOf(END);
  if (start !== -1 && end > start) return `${existing.slice(0, start)}${CLAUDE_SECTION}${existing.slice(end + END.length)}`;
  return `${existing.trimEnd()}\n\n${CLAUDE_SECTION}\n`;
}

export const UPDATE_COMMAND = `---
description: Post a progress update for the client in their Discord channel
argument-hint: [anything to mention]
allowed-tools: mcp__${MCP_SERVER_NAME}__get_project_brief
---
Post a progress update for this project's client with the \`${MCP_SERVER_NAME}\` \`post_update\` tool.

1. Call \`get_project_brief\` to see the agreed spec and the updates already posted.
2. Work out what changed since the last update, from this session and \`git log\`.
3. Write it for a non-technical client: a short summary, what's done, what's next, and anything you need from them. Report only what is actually done and checked. No promises about dates, prices or features beyond the spec, and no secrets.
4. Post it with \`post_update\`.

$ARGUMENTS
`;

/** Pure: whether a git remote URL points at this GitHub repo (owner/name). */
export function remoteMatches(remoteUrl: string, repo: string): boolean {
  const match = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(remoteUrl.trim());
  return match?.[1]?.toLowerCase() === repo.toLowerCase();
}
