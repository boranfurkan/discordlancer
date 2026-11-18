# Discordlancer

A Discord bot that runs freelance software projects from the first chat to the final payment. Each client gets a
private channel and their own GitHub repo. The bot writes the specs from the conversation, records and summarises
calls, reads the files clients share, posts the quote, and takes payment in USDC on Solana, checking it on chain by
itself. It handles delivery and invoices, and after delivery it can hand small changes to an AI coding factory.

It was built for Shipyard's **Make Me Money** hackathon (2–18 Nov 2026), where it ran a real client project from
introduction to full payment. Furkan Boran directed the build, and Claude Code (Anthropic's coding agent) wrote the
code.

```
introduction → private channel + repo → specs → quote → USDC payment on Solana → build → delivery → small changes
```

## What it does

| Stage | What happens | Who starts it |
|---|---|---|
| **Start** | Creates a private channel, a client invite and a GitHub repo, then explains the process to the client | Owner: `/new-project` |
| **Talk** | The client describes the project. The bot reads every file, screenshot and link shared in the channel and posts notes on what each one asks for. It answers questions about the project from its record. | The bot, by itself. Anyone with `/ask` |
| **Calls** | Joins the project's voice channel and records only the people who agree, each time. It transcribes the call (ElevenLabs, or Gemini as a fallback) and posts notes with decisions, action items and open questions. | `/call start` |
| **Specs** | Writes the next spec version from the whole conversation, the calls and the file notes, and lists what changed since the last version. Marked as AI-drafted. | Owner: `/create-specs`. Both sides: `/agree-specs` |
| **Quote** | Posts a fixed quote in USDC for the agreed spec, with an optional deposit, a deadline and standard terms | Owner: `/quote`. Client: `/accept-quote` |
| **Payment** | Creates a Solana Pay request with a QR code and a unique reference. It watches the chain, and accepts only USDC that came from the client's declared wallet, went to the owner's wallet, carried the reference and covered the amount due. | Client: `/set-payment-wallet`, `/pay`, or `/paid` with a signature |
| **Build** | Tracks the build stage. A connected Claude Code session can post progress updates to the channel through the bot's MCP endpoint, and the client can ask for an AI progress estimate against the spec. | Owner: `/start-development`. Anyone: `/progress` |
| **Delivery** | The owner marks the work delivered and the bot asks for the balance. The client confirms. | Both: `/confirm-delivery` |
| **After delivery** | Triages a client's small change request against what was agreed. Approved changes become GitHub issues for a Tessl factory, which opens a pull request. | Client: `/request-update` |
| **Paperwork** | A PDF invoice, an evidence pack of the whole project, a daily sales report and the day's hackathon "touch" line | Owner: `/invoice`, `/export`, `/report`, `/touches` |

Other commands are `/help`, `/project`, `/invite`, `/link-client`, `/add-github`, `/review-repo` (notes on an
existing codebase), `/read-files`, `/sync-docs`, `/wallet`, `/cancel` and `/archive`. The owner's commands are
refused for clients, and each client sees only their own project.

## How it uses SurrealDB

**SurrealDB 4 on SurrealDB Cloud** is the record of truth (`src/db/schema.surql`).

- **Every table is `SCHEMAFULL`.** There are 13: project, event, spec, quote, agreement, payment request, payment,
  call, file note, invoice, change request, invite and repo review.
- **History is append-only, and the database enforces it.** Event, spec, quote, agreement, payment, call, invoice,
  file note and repo review each have a `DEFINE EVENT` that throws on `UPDATE` or `DELETE`. A correction is a new
  record: a new spec version, a new event, or an invoice that `replaces` the previous one.
- **Every fact keeps its source.** A file note keeps the Discord message, author, model and prompt version. A payment
  keeps the transaction signature and the sending wallet. A spec keeps its message count, model and prompt version. An
  answer records which sources it used and the code commit.
- **Every step is an event:** who did it (owner, client or bot), when, and the outcome. That makes each project's
  evidence pack.

**SurrealDB Agent Memory** holds what the bot should recall (`src/services/memory.ts`, through the REST API).

- **Scopes:** one per project, `discordlancer/project/<name>`, so clients never mix.
- **What it remembers:** agreed specs, quotes, verified payments, call decisions and action items, delivery, change
  requests, merged changes and progress updates.
- **When it recalls:** before it drafts a spec, answers `/ask`, writes the project docs, or triages a change request.
- **Best-effort:** if a memory call fails, the database stays the record and the command still works.

## Stack

TypeScript on Node 24 (ESM), with Zod 4 at every boundary and Vitest for tests. It calls each service's API directly,
with no agent framework.

| Part | Used for |
|---|---|
| `discord.js` 14 and `@discordjs/voice` | The bot, slash commands, and recording calls (each speaker's turns, wrapped in Ogg by our own small writer) |
| SurrealDB 4 (`surrealdb` SDK) and Agent Memory (REST) | The record and the memory. Tests run against an in-memory SurrealDB with the real schema. |
| Google Gemini (`@google/genai`) | Specs, file notes, call summaries, answers and change triage, each with a versioned prompt |
| ElevenLabs Scribe | Call transcription |
| Solana (`@solana/kit`) and Solana Pay | Payment requests and on-chain checks. The bot only reads the chain: it never holds a key or sends funds. |
| GitHub (`@octokit/rest`) | A repo per project, collaborators, issues for change requests |
| Tessl | The factory that turns approved change requests into pull requests |

## Layout

```
src/
  index.ts       start-up: environment, database, Discord, web port
  health.ts      the web port: a status page, and /mcp for Claude Code progress updates
  env.ts         every setting, checked with Zod at start-up
  db/            schema.surql and one module of queries per table
  discord/       commands/, the channel watcher, answers, payments, evidence, invites and joins
  voice/         recording, transcription and call notes
  files/         reading shared files and links safely
  services/      Gemini, ElevenLabs, GitHub, Solana, Agent Memory
  domain/        pure logic: stages, money, deposits, payments, invoices and PDFs
  mcp/           the MCP server for a connected coding agent
  prompts/       the versioned prompts
scripts/         check-env, setup-server, claude-connect
test/            unit and integration tests
```

`PLAN.md` is the full design, `DEPLOY.md` covers hosting on Replit, `TODO.md` the build phases, and `NOTES.md` the
hackathon rules and the organisers' rulings.

## Running it

You need Node 24, a Discord application and server, a SurrealDB 4 instance, and keys for the services above.
`.env.example` lists every setting by name.

```bash
npm ci
cp .env.example .env        # then fill in the values
npm run check:env           # tests each service without printing any value
node scripts/setup-server.mjs   # roles, permissions and public channels, once per server
npm run dev                 # or: npm run build && npm start
npm test                    # 349 tests
```

At start-up the bot applies the schema (safe to repeat) and registers its commands. Run only one copy at a time:
two copies would both answer every command. `DEPLOY.md` covers running it on a Replit Reserved VM.

## Principles

- **Real records only.** Payments are confirmed only from the chain, and nothing is invented.
- **Honest AI.** Specs, estimates, notes and answers are marked as AI-written.
- **Client text is data, not instructions,** in every prompt.
- **Secrets stay secret.** Keys never appear in messages or logs, and logs scrub them.
