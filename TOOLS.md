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
| `surrealdb-agent-memory-docs` | SurrealDB | Agent Memory, aimed at the Best Use of Memory prize | 6 |
| `gemini-api-dev` | Google Gemini | The Gemini API with an AI Studio key, through `@google/genai` | 3 |
| `tavily-sdk` | Tavily | Calling Tavily from code | 3 |
| `solana-dev` | Solana Foundation | `@solana/kit`, token accounts and payments, for the USDC check | 4 |

- **`surrealdb-agent-memory-docs`** pre-approves read-only docs access: fetching `surrealdb.com`, `curl` to `surrealdb.com`, and `ssh surrealdb.sh`, which is SurrealDB's docs mirror.
- **`solana-dev`** lists Rust, the Solana CLI and Anchor as requirements, but those are for writing on-chain programs. We only read transactions, so Node and `@solana/kit` are enough.
- None of the vendor skills bundles a script.

**Written for this repo**

| Skill | Covers | Status |
|---|---|---|
| `typescript-node` | Code style, the long-running process, API limits, money rules, audit logging, tests | Written |
| `surreal-data` | Our schema, the append-only event log, queries | To write in phase 1 |
| `discord-bot` | discord.js conventions: commands, permissions, buttons, deferring slow replies, invite tracking | To write in phase 2 |

**Tessl**

The `tessl/factory-setup` plugin is installed in the project, pinned in `tessl.json` and vendored in `.tessl/plugins/`. Its 8 skills appear as `tessl__*` in `.claude/skills/`. They're symlinks, so commit `.tessl/` too.
- **Factory skills:** `factory-setup`, `change-factory`, `understand-factory`, `check-cloud-setup`.
- **Issue skills:** `create-github-issue`, `create-linear-issue`.
- **Repo and skill writing:** `prepare-repo`, `write-factory-skill`.

These drive `/request-update` in phase 6, and help set up the factory on a client repo at delivery.
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
| Agent Memory MCP | It can write to the memory context. Reconsider in phase 6 |
| Tavily MCP | Claude Code already has web search, and this would spend credits |
| Stripe MCP | It can change a live account and move money. Not used anyway |

Never put API keys in `.mcp.json` or any other committed file.

## Services and keys

See `.env.example` for the variable names and `~/Desktop/env-setup.md` for where each comes from. `node scripts/check-env.mjs` tests every service without printing values.

- **SurrealDB is version 4 (Earth).** HTTP `/signin` refuses system users there, so connect over the WebSocket RPC, which the SDK does.
- **Gemini runs on prepaid AI Studio credits.** If a call returns HTTP 402, top up in AI Studio.
