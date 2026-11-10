# Discordlancer: plan

Agreed with Boran on 8 and 9 Nov 2026. Updated on 9 Nov with what the vendor skills, the npm registry and our live checks showed. The phases and tasks are in `TODO.md`.

## What it does

Boran gets clients through referrals: an existing client introduces someone who needs an app built, with no cut. `efe_shipyard` ruled on 9 Nov that this counts as a stranger sale.

Discordlancer turns each project into a private Discord channel with its own GitHub repo, and walks it through fixed stages:

```
specs → quote → payment in USDC on Solana → building → delivery → small changes
```

Every step is recorded, which makes the hackathon evidence pack, and the bot remembers each client and decision.

**The client comes first.** If client work and bot work compete for time, the client wins.

## Stack and versions

Plain TypeScript with direct API calls, on Node 24, ESM. Versions were checked on npm on 9 Nov.

**Rule:** pin exact versions, and prefer a release at least about two weeks old. Make an exception only when we need the newer one, and say why.

| Package | Version | Why | Note |
|---|---|---|---|
| `typescript` | 6.0.3 | Type-checking and build (`tsc`) | Not 7.x: the SurrealDB SDK supports TypeScript 5 or 6 only. An internal SDK helper lists only 5, and npm overrides that safely, since it affects types only |
| `tsx` | 4.23.15 | Runs TypeScript in development | |
| `vitest` | 4.1.12 | Tests | 5.1.0 is from 2 Nov, too new |
| `@types/node` | 24.19.2 | Types matching Node 24 | Not 26.x, which is for Node 26 |
| `zod` | 4.6.7 | Validates env, payloads and model output | |
| `discord.js` | 14.27.0 | The Discord bot | 14.28.1 is from 3 Nov, too new |
| `surrealdb` | 2.2.2 | The SurrealDB SDK | **Exception:** SurrealDB 4 support arrived in 2.2.1 and 2.2.2 (3 and 4 Nov), and our instance runs 4.0 |
| `@surrealdb/node` | 3.2.0 | In-memory SurrealDB for tests (dev only) | **Exception, same reason:** 3.2.0 is the first to run SurrealDB 4.0 |
| `@google/genai` | 2.31.0 | Gemini | The skill needs at least 2.29.1. 3.0.0 is from 6 Nov, too new |
| `@solana/kit` | 8.5.0 | Typed Solana RPC, addresses, reference keys | 8.6.0 is from 28 Oct, too new |
| `@octokit/rest` | 22.0.1 | GitHub API | |
| `qrcode` | 1.5.4 (+ `@types/qrcode` 1.5.6) | QR code for the Solana Pay request | |

**Not installed, called with `fetch` instead:**
- **Agent Memory:** its SDK, `@surrealdb/memory`, is only an alpha (`1.0.0-alpha.11`), so we use the documented REST API.
- **Tavily:** a single search endpoint doesn't need an SDK.

## Skills and docs for each area

Read the matching skill before writing code in that area. For libraries without a skill, check Context7.

| Area | Use |
|---|---|
| All code | `typescript-node` (ours) |
| Database | `surrealdb-js`, `surrealql`, and `surreal-data` (ours, written in phase 1) |
| Discord | Context7 (discord.js 14 guide and the Discord API docs), and `discord-bot` (ours, written in phase 2) |
| GitHub | Context7 (Octokit) |
| Gemini | `gemini-api-dev`. **It says to fetch the current docs page before writing code.** It points to the interactions API, `client.interactions.create` |
| Solana | `solana-dev`: `references/payments.md`, `references/rpc-quick-lookups.md` and `references/kit/*`. Also the `solana-docs` MCP server |
| Agent Memory | `surrealdb-agent-memory-docs`, starting with `reference/agents.md` |
| Tavily | `tavily-sdk`: `references/search.md` |
| Tessl | The `tessl__*` skills, and docs.tessl.io |

## Folder layout

```
src/
  index.ts              starts the bot and wires everything together
  env.ts                parses .env with Zod; names a missing variable, never prints a value
  log.ts                JSON-line logging to stdout, with secrets scrubbed
  db/
    client.ts           connect over WebSocket, sign in, use namespace and database
    schema.surql        tables, fields, indexes, the append-only guard
    migrate.ts          applies schema.surql (npm run db:migrate)
    events.ts           recordEvent(): the only way to write an event
    projects.ts         project queries and stage changes
  domain/               pure logic with no I/O, fully unit-tested
    stages.ts           which stage can follow which, and who may move it
    money.ts            USDC amounts as integer micro-units
    names.ts            project names valid for both Discord and GitHub
  discord/
    client.ts           intents, login, the interaction handler, safeRecord()
    command.ts          the Command and BotContext types
    register.ts         registers slash commands on our server (npm run commands:register)
    guards.ts           owner-only, project-channel-only, stage checks
    invites.ts          invite cache and join tracking
    commands/           one file per command
  services/
    github.ts           repos, collaborators, issues, labels, reading code
    gemini.ts           specs, triage, status, always with store: false
    solana.ts           payment requests, finding and verifying payments
    memory.ts           Agent Memory REST calls
    tavily.ts           search
  mcp/                  the MCP endpoint for Boran's Claude Code sessions (progress updates)
  voice/                recorded calls: recorder, Ogg writer, transcription, the call manager
  health.ts             the web port: status page, and /mcp
  prompts/              prompt text, each with a version name
test/
  helpers/db.ts         memoryDb(): in-memory SurrealDB 4 with the real schema
  fixtures/             recorded payloads, with anything private removed
scripts/
  check-env.mjs         tests every service without printing values
  claude-connect.ts     connects a Claude Code session to one project (npm run claude:connect)
```

## Data model

SurrealDB 4 on SurrealDB Cloud (Earth): namespace `freelance`, database `bot`. Every table is `SCHEMAFULL`. The final schema is written in phase 1, with the `surrealql` skill open.

| Table | Holds | Unique by |
|---|---|---|
| `project` | Name, Discord channel ID, repo (`owner/name`), invite code, client's Discord ID (the first), the rest of the client's team (`client_ids`), GitHub username and declared wallet, stage, the SHA-256 of its Claude Code key, timestamps | Name; channel ID |
| `event` | **Append-only log:** time, project, actor (`owner`, `client` or `bot`), actor's Discord ID, action, data, outcome (`ok`, `refused`, `failed`) | |
| `spec` | Project, version, markdown, what changed, open questions, model, prompt version, how many messages it read | Project + version |
| `quote` | Project, version, amount (micro-USDC), deadline, spec version, terms | Project + version |
| `agreement` | Project, kind (`spec` or `quote`), version, party (`owner` or `client`), Discord ID, time | Project + kind + version + party |
| `payment_request` | Project, quote version, amount, reference key, status (`open`, `paid`, `expired`) | Reference |
| `payment` | Project, request, signature, from wallet, to wallet, amount, slot, block time, verified time | Signature |
| `change_request` | Project, text, Gemini's triage, status, issue number, PR number | |
| `invite` | Team invites from `/invite`: code, project, status (`open`, `used`), who used it | Code |
| `call` | **Append-only:** project, start and end, participants (name, role, whether they agreed to be recorded), AI transcript, AI summary (decisions, action items, open questions), speech seconds, turns, model, prompt versions. Never the audio | |

**Rules:**
- **Money is stored as integers in micro-USDC.** USDC has 6 decimals, so 250 USDC is `250000000`. Never use floats for money.
- **History is append-only:** `event`, `spec`, `quote`, `agreement` and `payment`. The bot only ever creates these records. Table permissions don't bind system users like ours, so each history table has an event that throws on update or delete. **Proven on 9 Nov,** both in memory and on the cloud server: `UPDATE`, `UPSERT` and `DELETE` are refused, and the record is left unchanged.
- **A stage change and its event are written in one transaction,** through one function in `db/projects.ts`.
- **Touches are events where the actor is the owner.** They don't need a table of their own.

## Stages

```
created → joined → specs_agreed → quote_accepted → paid → in_development → delivered → support
                                       (cancelled or archived from any stage, by Boran)
```

- **Agreement is tied to a version.** Regenerating the specs moves `specs_agreed` back to `joined`. A new quote clears the quote acceptance.
- **Specs and quote can change only before payment.** After payment, extra scope needs a new project or a later version of the bot. Staged payments are out of scope for now.
- **Gates:**
  - a quote needs agreed specs;
  - `/pay` needs an accepted quote and a declared client wallet;
  - development needs a verified payment;
  - delivery needs both people.
- **Hackathon warning:** `/quote` warns Boran if the deadline falls after Wed 18 Nov, 6pm, because a sale only counts if it's delivered before the freeze.

## People and permissions

- **Boran (owner):** matched by `DISCORD_OWNER_ID`. Can run every command.
- **Client:** whoever joined through the project's invite, or was linked with `/link-client`. Sees only their own channel, plus public channels.
- **The client's team:** a client can be several people (a CEO, a CTO, a marketing lead). Boran runs `/invite` in the project channel for each extra person: a single-use, seven-day invite, kept in the `invite` table so the join is matched to it like the first invite. Whoever joins with it is added to the project's `client_ids`, gets the channel, the voice channel, the threads and the Client role, and is welcomed. **Anyone on the client's team acts for the client** (Boran's choice, 10 Nov): they can chat, `/ask`, join calls (each agrees to recording separately), request changes, and agree specs, accept quotes, pay and confirm delivery; one agreement counts for the whole team. `/link-client` also adds a team member by hand. `client_id` stays the first person, for display.
- **Bot:** acts on its own for checks, reminders and messages. Its actions aren't touches.

Commands are registered on our server only, so changes appear instantly. Every command is visible to both people. If a client runs an owner-only command, they get a private "only Furkan can do this" reply. Commands work only inside a project channel, except `/new-project` and `/help`.

## Commands

| Command | Who | Phase | What it does |
|---|---|---|---|
| `/help` | Both | 1 | The commands the caller can run at this stage |
| `/new-project name` | Boran | 2 | Creates the private channel, a single-use invite and a private repo with the same name. Replies privately with the invite link |
| `/link-client user` | Boran | 2 | Fallback: attaches a member to the project (as its client, or one more of the client's team) if invite tracking missed them |
| `/invite` | Boran | 11 | An invite for one more person on the client's team (single-use, 7 days) |
| `/call start \| stop \| retry` | Boran | 10 | Records a call in the project's voice channel, with each person's consent; notes in the 📞 Calls thread |
| `/sync-docs` | Boran | 10 | Writes the project docs into the repo as a pull request |
| `/project` | Both | 2 | Project card: stage, spec version, quote, payment, deadline, what's next |
| `/add-github username` | Both | 2 | Adds the client's GitHub account to the repo with **read-only** access |
| `/create-specs` | Boran | 4 | Gemini writes spec version N from the whole channel, plus "what changed since N-1" and open questions. Posted as a `.md` file and pinned (the bot needs the Pin Messages permission) |
| `/agree-specs` | Both | 4 | Agrees to the current spec version. Needs both people |
| `/quote amount deadline` | Boran | 4 | Quote version N, in USDC, tied to the agreed spec version, with short terms |
| `/accept-quote` | Client | 4 | Accepts the current quote version. Posting a quote already counts as Boran's acceptance |
| `/set-payment-wallet address` | Client | 5 | Declares the Solana wallet the client will pay from, before paying |
| `/wallet` | Both | 5 | Boran's receiving address and the network: USDC on Solana |
| `/pay` | Both | 5 | Creates a Solana Pay request for the amount due and posts its QR code. The bot then watches for the payment |
| `/paid signature` | Both | 5 | Fallback if the client paid without scanning the QR: the bot checks that transaction |
| `/receipt` | Both | 5 | A receipt for a verified payment |
| `/start-development` | Boran | 5 | Marks the start of building. Needs a verified payment |
| `/confirm-delivery` | Both | 6 | Boran marks it delivered, then the client confirms with a button |
| `/export` | Boran | 6 | The evidence pack, posted to a private owner-only channel |
| `/report` | Boran | 6 | Drafts today's sales report for the organisers: running total and transaction hashes |
| `/touches` | Boran | 6 | Drafts today's `/touch` line from the owner events |
| `/progress` | Both | 7 | Gemini compares the repo with the agreed spec. Gives a summary and an estimated percentage, marked as an estimate. (Not `/status`: the Wordle app in our server has one) |
| `/request-update text` | Client | 7 | After delivery: asks for a small change, handled by Tessl |
| `/ask question` | Both | 8 | The AI assistant answers a question about the project in the channel (see Questions) |
| Tag the bot in a reply, or **Apps → Answer with AI** on a message | Boran | 8 | The assistant answers that client message as a reply (see Questions) |
| `/cancel`, `/archive` | Boran | 2 | Closes the project. The channel becomes read-only and nothing is deleted |

## Discord details

- **Intents:**
  - Guilds;
  - Guild Members (privileged; the env check confirmed it's on), to see joins;
  - Guild Invites, to keep the invite cache current;
  - Message Content (privileged; on), so fetched messages include their text.
- **`/new-project`** creates:
  - the channel under a `Projects` category, hidden from `@everyone` and visible to the bot and Boran;
  - an invite with `maxUses: 1`, `maxAge: 7 days` and `unique: true`.
- **Joining:** when someone joins, the bot fetches the server's invites, compares use counts with its cache, and finds the project. It then gives that member access to the channel only, with a member-specific permission, and posts a welcome. The welcome explains how the channel works, and includes a privacy note on what the bot stores and that specs are AI-written. If the bot was restarted during a join, `/link-client` fixes it.
- **Slow commands** (Gemini, GitHub, Solana) defer the reply first, because Discord expects an answer within 3 seconds.
- **The spec** is posted as a `.md` attachment and pinned, with a short summary in the message.

## Payment

Based on the `solana-dev` skill's payment guidance.

1. **`/pay`** creates a `payment_request` with a fresh, unique reference key, made with `@solana/kit`.
2. It posts a Solana Pay link and QR code:
   `solana:<Boran's wallet>?amount=<USDC>&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&reference=<key>&label=Discordlancer&message=<project> quote v<N>`
   A phone wallet such as Phantom scans it and adds the reference to the transaction.
3. **The bot watches for the payment.** While a request is open, it calls `getSignaturesForAddress(reference)` about every 20 seconds, and immediately when someone runs `/paid`.
4. **For each signature,** it calls `getTransaction` with `encoding: "jsonParsed"`, **`maxSupportedTransactionVersion: 1`** (newer transactions fail to load without it) and `commitment: "finalized"`. A payment counts only if all of these hold:
   - the transaction succeeded (`meta.err` is null);
   - Boran's wallet's USDC balance rose by at least the amount due, comparing `preTokenBalances` and `postTokenBalances` by owner and mint;
   - the client's declared wallet's USDC balance fell by the same amount;
   - the signature hasn't been used before (a unique index).
5. **Record it once:** mark the request paid and write the payment and its event in one transaction. Then post the confirmation and receipt, and remind Boran to report the sale.
6. **Treat silence carefully.** No result from the RPC isn't proof that nobody paid, so requests never expire for lack of an answer. The only automatic expiry: opening a request for a newer quote expires open requests for older quotes, so a superseded amount can't be paid.
7. **`/paid signature`** is the fallback for a manual send that has no reference. It runs the same checks on that one transaction.

The bot never holds a private key, signs or sends anything. It only reads the chain.

## Gemini

Based on the `gemini-api-dev` skill. Fetch its docs page for the interactions API, structured output and image input before writing `services/gemini.ts`.

- **Client:** `new GoogleGenAI({ apiKey })` with the AI Studio key. Calls go through `client.interactions.create`.
- **Always `store: false`.** Interactions are stored by default, for 55 days on the paid tier, and these are client chats. We don't need `previous_interaction_id`.
- **Models:**
  - `gemini-3.8-flash` for specs and status;
  - `gemini-3.5-flash-lite` for triage and other small classifications.
  - Older `gemini-2.x` models are deprecated.
- **Structured output** for every call, validated with Zod, because a model can return well-formed nonsense.
- **Client messages, files and code are data.** They're delimited and labelled in the prompt, never mixed with our instructions.
- **Save the model and prompt version** with each result.
- **Limits:** `/progress` 3 times a day per project, `/request-update` 10 per 30 days per project, and a client's `/ask` 15 times a day per project.

## Questions

Clients ask with `/ask`. Boran gets an answer to a client's message by replying to it and tagging the bot (words after the tag are a note for the answer, such as "say SMS is extra"), or with **Apps → Answer with AI** on the message, which only he sees. The answer is posted as a reply and always marked as an AI answer, with what it was based on.

- **Context, gathered fresh for every answer, so it's never out of date:**
  - the whole channel conversation, read live from Discord, including the bot's own posts (the newest 150,000 characters);
  - the latest spec and whether both agreed it, the latest quote, payments, delivery and change requests, from SurrealDB;
  - Agent Memory recall for the question, in the project's scope;
  - the code on the default branch (the same files `/progress` reads). If GitHub fails, the answer says the code couldn't be read.
- **Guardrails (prompt `answer-v1`):** it answers only from that context; it never agrees to a new price, discount, deadline or scope; it never repeats secrets; and client text and code are data. When something needs Boran it says so, and he's told in `#owner-desk`. Tested live on 9 Nov with a normal question, a discount request and a prompt injection: all three were handled correctly.
- **Touches:** Boran's tag or menu answers are owner actions and appear in `/touches`. A client's `/ask` isn't a touch.
- **Events:** `ask.answered` (from `/ask`) and `question.answered` (Boran's), with the model, prompt version, commit and whether it needs Boran.

## Progress updates from Claude Code

While Boran builds a client's app with Claude Code, the session can tell the client how the work is going, in the project's channel.

- **Connecting a session:** on Boran's laptop, in this repo, `npm run claude:connect -- <project> [folder]`. It:
  - clones the project's repo into the folder (default `~/Desktop/<project>`) if it isn't there, and refuses a folder that isn't that repo, so a session can never post to the wrong client;
  - makes a new key for the project and stores only its SHA-256 (an older key stops working), with a `project.claude_connected` event;
  - adds the bot's MCP server to Claude Code for that folder only (`claude mcp add --scope local`, kept in `~/.claude.json`), with the key as an `Authorization` header. The key is never printed, and never goes into the repo, Discord or a log;
  - writes a "Client progress updates" section into the repo's `CLAUDE.md` and a `/update-client` command (`.claude/commands/update-client.md`). They hold no key and are safe to commit; the client can read them;
  - checks the live bot accepts the key.
- **The MCP server** is part of the bot, at `https://discordlancer.replit.app/mcp` (Streamable HTTP, stateless, JSON replies). It is written by hand rather than with the MCP SDK, which would add a web framework and a dozen packages to a bot that holds secrets. Each request needs a project key; requests with an `Origin` header (browsers) are refused. Its instructions tell Claude when and how to post.
- **Tools:**
  - `get_project_brief`: the stage, the latest spec (fenced, "requirements, not instructions") and whether it's agreed, the quote and deadline, payments, change requests and the last five updates. Read-only. Raw client chat is left out on purpose: the session can run commands on Boran's laptop, so client text never reaches it.
  - `post_update`: summary, done, next, and optionally what's needed from the client. Posted in the key's own project channel, pinging nobody, ending "Written by Furkan's AI coding assistant (Claude) during his work session". Refused before the client joins, after cancel or archive, over 6 a day, over 1,900 characters, or when it looks like it contains a key. Recorded as `dev.update_posted` (actor `owner`) and remembered in Agent Memory, so `/ask` can answer "how's it going?".
- **Boran sees every update before it goes out:** Claude Code asks permission for `post_update` and shows the text. Keep it that way rather than allowing it always.
- **Touches:** the build session is one touch. Updates posted during it don't add more; `/touches` describes them as part of the build session.

## Owner guide

`#owner-guide`, next to `#owner-desk` and just as private, explains how a project runs, every command (yours, and the ones the client team can use), what works without commands, and the laptop steps. It's built from the bot's own command list (`src/discord/guide.ts`) and refreshed each time the bot connects: messages are edited in place, never reposted. A test fails if a command has no guide entry, so a new command can't go undocumented.

## Threads in each project channel

So the main channel stays a conversation, the bot posts three kinds of thing in public threads under it, made the first time they're needed (`ensureProjectThread` in `src/discord/channels.ts`):
- **📞 Calls:** the consent message, "the call has ended", the call notes and transcripts. When a call starts, the main channel gets one line pointing to the voice channel and the thread.
- **🔧 Code changes:** Tessl's pull requests, opened, merged or closed.
- **📈 Progress updates:** Claude Code's updates.

Boran and everyone on the client's team are added to each thread, so they're notified; a team member who joins later is added to the threads that exist. Threads archive after a week without posts and reopen on the next one. People can reply in them (`SendMessagesInThreads`). `/ask` still sees everything: calls and progress updates come from the database, not the chat.

## Recorded calls

Boran runs `/call start` in a project channel. The bot joins the project's private voice channel (made the first time, visible to Boran, the bot and the client) and posts a consent message with **Record me** and **Don't record me** buttons.

- **Consent first:** starting the call counts as Boran's agreement; the client is pinged and isn't recorded until they press **Record me**. Discord sends each speaker's audio separately, so the bot never subscribes to anyone who hasn't agreed. Pressing **Don't record me** later drops everything recorded from that person. Each answer is a `call.consent` event.
- **Recording** (`@discordjs/voice` 0.19.2, which handles Discord's end-to-end voice encryption, DAVE): each person's turn, from when they start talking to a second of silence, is kept as Opus packets in memory. Turns under 0.6 s are dropped as noise. A guard stops at 150 MB.
- **Ending:** `/call stop`, everyone leaving for 2 minutes, 2 hours, a lost connection, or the bot restarting. The consent message is closed.
- **Then:** each turn is wrapped in Ogg (`src/voice/ogg.ts`, our own small writer: no native code, no alpha packages). **ElevenLabs Scribe** (`scribe_v2`, `src/services/elevenlabs.ts`) transcribes it: each speaker's turns are joined into one file with a second of silence between them, so a call costs one request per speaker, and the word timings put every word back in its turn. Filler words are left out (`no_verbatim`). After each transcript the bot asks ElevenLabs to delete its copy (zero-retention mode is for enterprise plans only). The speaker is known from Discord, not guessed. Without `ELEVENLABS_API_KEY`, or if ElevenLabs fails (Boran is told in `#owner-desk`), Gemini transcribes the turns in batches instead. Gemini then summarises the call: decisions (only what both agreed), action items, open questions. The call is saved (append-only, with a `call.recorded` event), the notes are posted in the channel marked as AI-written with the transcript attached, and the decisions and action items go into Agent Memory. **The audio is never stored.**
- **If transcription fails,** the recording is kept in memory, Boran is told in `#owner-desk`, and `/call retry` tries again.
- **Calls feed** `/ask`, `/create-specs`, `/sync-docs` and the evidence pack (`/export` attaches every transcript).
- **Tested 10 Nov** with spoken audio through the real pipeline: Gemini transcribed each turn word for word, and the summary kept deposits as an open question because they needed a quote.
- **Touches:** a call with a client is a touch, recorded or not.

## Project docs in the repo

`/sync-docs` (owner) writes the project's docs into its repo as one pull request: `docs/project/README.md` (overview), `requirements.md` (agreed spec, then "discussed since, not agreed yet"), `decisions.md` (a dated log; replaced decisions are kept and marked, never deleted), `open-questions.md`, and one file per call under `calls/` (the summary, not the transcript). Claude Code reads them at the start of a session (`CLAUDE.md` says so).

- **Sources:** the whole chat with images and files, every spec version and its agreement, the quote, payments, change requests, progress updates, calls, Agent Memory, and the docs already in the repo (so each run is an update, not a rewrite).
- **Two AI passes** (prompt `docs-v1`): a writer (low thinking, fast), then a reviewer (medium thinking) that checks every statement against the same sources, fixes anything unsupported, and lists its fixes in the pull request. Every requirement, decision and open question cites its source, like `[chat 2026-11-12 14:03]` or `[call 2026-11-13 10:00, 00:12:30]`; code then checks each citation against the real messages, calls, specs, quotes, change requests and updates, and lists any that don't match. Docs that look like they contain a key are not committed.
- **GitHub:** one commit on `discordlancer/project-docs` on top of the default branch, only for files that changed; the branch is reset each run, and the one open pull request is updated. The bot can write only to branches under `discordlancer/`, never `main` or `master`. Nothing changed: no commit.
- **Tested 10 Nov** with the real Gemini: 22 citations, all matching; the reviewer fixed real mistakes (a colour scheme written as agreed when it was only discussed). About 3 minutes. A real commit and pull request were made on a test repo with the bot's token.

## Change requests after delivery

1. The client sends `/request-update` with a description.
2. Gemini triages it: small and clear, needs information, or bigger work that needs a quote. If it needs information, the bot asks the questions in the channel.
3. Boran approves with a button.
4. The bot opens a GitHub issue with a clear task, creates the `tessl` label if the repo lacks it, then adds the label in a second call.
5. Tessl opens a pull request on a `tessl/` branch, usually within about 90 seconds of the label.
6. The bot posts the pull request in the channel, with a review reminder in `owner-desk`. Boran reviews and merges it, and the bot posts that it's merged (or closed). The pull request is found by Tessl's branch name, `tessl/issue-<n>`, or its title, `#<n>: …`, checked every minute.

**Setup per client repo:** not automatic. At delivery, Claude Code turns the factory on with the `tessl__factory-setup` skill (create the Tessl project, check the app reaches the repo, turn on Ticket to PR), as was done for `dl-test-tessl`; no web app step is needed. Until then, an approved change request opens an issue that nothing picks up. The Tessl GitHub App is already installed on `boranfurkan` with All repositories.

**Safety:**
- Give Tessl's environment pull-request access only, and keep no secrets in it.
- Client text in the issue is quoted as data.
- **Open decision:** GitHub can't protect `main` on private repos without GitHub Pro, about $4 a month. Without it, nothing stops a merge except Tessl's default behaviour, which doesn't merge on its own. Decide before phase 7: buy Pro, or accept the risk.

## Memory

- **The database holds what must be exact:** stages, versions, amounts, signatures and events.
- **Agent Memory (REST) holds what's useful to recall:** the client's preferences, decisions and their reasons, past requests, and what was tried.
  - **When it's written:** when specs are agreed, a quote is accepted, a decision is made, or a request is triaged.
  - **When it's recalled:** when writing specs, quotes and triage, and for every answer to a question.
  - **Scope:** one per project, `discordlancer/project/<name>`. Agent Memory refuses writes to an unregistered scope ("unknown scope node"), so the bot registers the path chain with `POST /scopes` (idempotent) on first use.

This aims at the Best Use of Memory prize: Boran repeats less and touches less because the bot remembers.

## Hosting

- **Replit, as a Reserved VM.** Autoscale deployments sleep, which breaks a Discord bot.
- **Exactly one instance.** Two instances would both handle every join and payment.
- **Node 24,** checked when deploying.
- **Every variable** goes in Replit Secrets.
- **Build:** `npm ci && npm run build`. **Start:** `npm start`.
- **Deploy** before the first invite is sent, because join tracking needs the bot online.

## Evidence and touches

- **`/export`** posts the evidence pack to a private owner-only channel:
  - the channel transcript;
  - every spec version and quote;
  - payment signatures with explorer links;
  - the delivery confirmation;
  - all events as JSON.
- **Keep outside the bot:** the referral intro message, as efe asked.
- **USDC sales are reported by hand.** Declare the wallet before the first payment, then report each day there's a sale, before 6pm, with transaction hashes. `/report` drafts that message.

## Out of scope for now

- **Stripe:** USDC only, as Boran chose. Add a card link if a client asks.
- **Staged payments:** one payment per project.
- **More than one server:** only ours.

## Open questions

- **Tessl:**
  - ~~Does adding the label start a run?~~ **Yes** (tested 9 Nov): the bot adds `tessl` in a second call, and the run started 1.4 seconds later.
  - ~~What does a run cost?~~ About **17 credits** for a one-line change (tested 9 Nov); the pull request arrived in about 70 seconds.
- **GitHub Pro** for protecting `main`: decide before phase 7.
- **Replit's Node version:** check when deploying.
- **Phantom and the reference:** does Phantom include the reference in a Solana Pay transfer? Expected yes. Test with a 0.01 USDC payment between your own wallets before the first client.
