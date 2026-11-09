# Tools, skills and MCP servers

Set up on 9 Nov 2026. What's installed, why, and what we chose to leave out.

## Skills

All live in `.claude/skills/`. Vendor skills are recorded in `skills-lock.json`.
- **Update them:** `npx skills update -p`.
- **Restore them on a new machine:** `npx skills experimental_install`.

**Vendor skills**

| Skill | Publisher | Use | Phase |
|---|---|---|---|
| `surrealdb-js` | SurrealDB | The JS SDK for the database | 1 |
| `surrealql` | SurrealDB | Schema and queries | 1 |
| `surrealdb-agent-memory-docs` | SurrealDB | Agent Memory, aimed at the Best Use of Memory prize. We call its REST API, because the SDK is still an alpha | 7 |
| `gemini-api-dev` | Google Gemini | The Gemini API with an AI Studio key, through `@google/genai` and the interactions API, always with `store: false` | 4 |
| `tavily-sdk` | Tavily | Search guidance. We call the REST endpoint with `fetch`, not the SDK | 4 |
| `solana-dev` | Solana Foundation | `@solana/kit`, Solana Pay requests with a reference key, and verifying USDC payments | 5 |

- **`surrealdb-agent-memory-docs`** pre-approves read-only docs access: fetching `surrealdb.com`, `curl` to `surrealdb.com`, and `ssh surrealdb.sh`, which is SurrealDB's docs mirror.
- **`solana-dev`** lists Rust, the Solana CLI and Anchor as requirements, but those are for writing on-chain programs. We only read transactions, so Node and `@solana/kit` are enough.
- None of the vendor skills bundles a script.

**Written for this repo**

| Skill | Covers | Status |
|---|---|---|
| `typescript-node` | Code style, the long-running process, API limits, money rules, audit logging, tests | Written |
| `surreal-data` | Our schema, append-only history, connecting to SurrealDB 4, queries, tests | Written |
| `discord-bot` | discord.js conventions: commands, the gate, replies and errors, permissions, invites and join tracking, testing in the server | Written |

**Tessl**

The `tessl/factory-setup` plugin is installed in the project, pinned in `tessl.json` and vendored in `.tessl/plugins/`. Its 8 skills appear as `tessl__*` in `.claude/skills/`. They're symlinks, so commit `.tessl/` too.
- **Factory skills:** `factory-setup`, `change-factory`, `understand-factory`, `check-cloud-setup`.
- **Issue skills:** `create-github-issue`, `create-linear-issue`.
- **Repo and skill writing:** `prepare-repo`, `write-factory-skill`.

These drive `/request-update` in phase 7, and help set up the factory on a client repo at delivery.
- **Update:** `tessl install`.
- **Files it manages:** the install added `@AGENTS.md` to `CLAUDE.md`, and `AGENTS.md` points to `.tessl/RULES.md`. Both are empty until a Tessl plugin adds rules.
- **Global copy:** the same skills are also installed globally in `~/.claude/skills/`. You can remove that copy if it shows them twice.

The Tessl registry had no official docs packages for our libraries, only community skills, so none were added.

## MCP servers

In `.mcp.json`, with no keys. Claude Code asks you to approve them the first time a session starts in this folder.

| Server | Use |
|---|---|
| `context7` | Current library docs: discord.js and the Discord API, the SurrealDB SDK, Octokit, Zod, `@google/genai`. No official Discord skill exists, so this is where Discord knowledge comes from. It works without a key, with lower rate limits |
| `solana-docs` | The Solana Foundation's official docs server |
| `tessl` | Tessl's own CLI as a local server (`tessl mcp start`), added by `tessl install`. Searches the registry and manages plugins. Anything that would start a cloud run spends Tessl credits, so Claude asks first |

**Deliberately not connected**

| Server | Why |
|---|---|
| Third-party Discord MCP servers | Unofficial, and they can act on the server |
| Replit MCP | In beta, and it can create and change apps. Deploying is a one-time manual step |
| GitHub MCP | `gh` is enough |
| Agent Memory MCP | It can write to the memory context. Reconsider in phase 7 |
| Tavily MCP | Claude Code already has web search, and this would spend credits |
| Stripe MCP | It can change a live account and move money. Not used anyway |

Never put API keys in `.mcp.json` or any other committed file.

## Packages

Exact versions, and why each was chosen, are in `PLAN.md` under "Stack and versions". The rule is to pin exact versions and prefer releases at least about two weeks old.

There are two deliberate exceptions, both for SurrealDB 4:
- `surrealdb` 2.2.2;
- `@surrealdb/node` 3.2.0.

TypeScript is 6.0.3, not 7, because the SurrealDB SDK supports only 5 and 6.

**Install scripts:** npm 11 holds back install scripts it hasn't been told about. Three are denied in `package.json` under `allowScripts`, because nothing needs them. `tsx`, `vitest` and `tsc` all work without them:
- `@google/genai`: a no-op echo;
- `esbuild`: an optional speed-up;
- `protobufjs`: a version check.

## Services and keys

See `.env.example` for the variable names and `~/Desktop/env-setup.md` for where each comes from. `node scripts/check-env.mjs` tests every service without printing values.

- **SurrealDB is version 4 (Earth).** HTTP `/signin` refuses system users there, so connect over the WebSocket RPC, which the SDK does.
- **Gemini runs on prepaid AI Studio credits.** If a call returns HTTP 402, top up in AI Studio.
