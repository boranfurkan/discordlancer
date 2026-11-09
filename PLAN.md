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
  prompts/              prompt text, each with a version name
test/
  helpers/db.ts         memoryDb(): in-memory SurrealDB 4 with the real schema
  fixtures/             recorded payloads, with anything private removed
scripts/
  check-env.mjs         tests every service without printing values
```

## Data model

SurrealDB 4 on SurrealDB Cloud (Earth): namespace `freelance`, database `bot`. Every table is `SCHEMAFULL`. The final schema is written in phase 1, with the `surrealql` skill open.

| Table | Holds | Unique by |
|---|---|---|
| `project` | Name, Discord channel ID, repo (`owner/name`), invite code, client's Discord ID, GitHub username and declared wallet, stage, timestamps | Name; channel ID |
| `event` | **Append-only log:** time, project, actor (`owner`, `client` or `bot`), actor's Discord ID, action, data, outcome (`ok`, `refused`, `failed`) | |
| `spec` | Project, version, markdown, what changed, open questions, model, prompt version, how many messages it read | Project + version |
| `quote` | Project, version, amount (micro-USDC), deadline, spec version, terms | Project + version |
| `agreement` | Project, kind (`spec` or `quote`), version, party (`owner` or `client`), Discord ID, time | Project + kind + version + party |
| `payment_request` | Project, quote version, amount, reference key, status (`open`, `paid`, `expired`) | Reference |
| `payment` | Project, request, signature, from wallet, to wallet, amount, slot, block time, verified time | Signature |
| `change_request` | Project, text, Gemini's triage, status, issue number, PR number | |

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
- **Bot:** acts on its own for checks, reminders and messages. Its actions aren't touches.

Commands are registered on our server only, so changes appear instantly. Every command is visible to both people. If a client runs an owner-only command, they get a private "only Furkan can do this" reply. Commands work only inside a project channel, except `/new-project` and `/help`.

## Commands

| Command | Who | Phase | What it does |
|---|---|---|---|
| `/help` | Both | 1 | The commands the caller can run at this stage |
| `/new-project name` | Boran | 2 | Creates the private channel, a single-use invite and a private repo with the same name. Replies privately with the invite link |
| `/link-client user` | Boran | 2 | Fallback: attaches a member to the project if invite tracking missed them |
| `/project` | Both | 2 | Project card: stage, spec version, quote, payment, deadline, what's next |
| `/add-github username` | Both | 2 | Adds the client's GitHub account to the repo with write access |
| `/create-specs` | Boran | 4 | Gemini writes spec version N from the whole channel, plus "what changed since N-1" and open questions. Posted as a `.md` file and pinned (the bot needs the Pin Messages permission) |
| `/agree-specs` | Both | 4 | Agrees to the current spec version. Needs both people |
| `/quote amount deadline` | Boran | 4 | Quote version N, in USDC, tied to the agreed spec version, with short terms |
| `/accept-quote` | Client | 4 | Accepts the current quote version. Posting a quote already counts as Boran's acceptance |
| `/set-payment-wallet address` | Client | 5 | Declares the Solana wallet the client will pay from, before paying |
| `/wallet` | Both | 5 | Boran's receiving address and the network: USDC on Solana |
| `/pay` | Client | 5 | Creates a Solana Pay request for the amount due and posts its QR code. The bot then watches for the payment |
| `/paid signature` | Client | 5 | Fallback if the client paid without scanning the QR: the bot checks that transaction |
| `/receipt` | Both | 5 | A receipt for a verified payment |
| `/start-development` | Boran | 5 | Marks the start of building. Needs a verified payment |
| `/confirm-delivery` | Both | 6 | Boran marks it delivered, then the client confirms with a button |
| `/export` | Boran | 6 | The evidence pack, posted to a private owner-only channel |
| `/report` | Boran | 6 | Drafts today's sales report for the organisers: running total and transaction hashes |
| `/touches` | Boran | 6 | Drafts today's `/touch` line from the owner events |
| `/status` | Client | 7 | Gemini compares the repo with the agreed spec. Gives a summary and an estimated percentage, marked as an estimate |
| `/request-update text` | Client | 7 | After delivery: asks for a small change, handled by Tessl |
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
6. **Treat silence carefully.** No result from the RPC isn't proof that nobody paid. Pending requests stay open, and only Boran can expire one.
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
- **Limits:** `/status` 3 times a day per project, and `/request-update` 10 a month per client.

## Change requests after delivery

1. The client sends `/request-update` with a description.
2. Gemini triages it: small and clear, needs information, or bigger work that needs a quote. If it needs information, the bot asks the questions in the channel.
3. Boran approves with a button.
4. The bot opens a GitHub issue with a clear task, creates the `tessl` label if the repo lacks it, then adds the label in a second call.
5. Tessl opens a pull request on a `tessl/` branch, usually within about 90 seconds of the label.
6. Boran reviews and merges it. The bot posts the outcome.

**Setup per client repo:** turn the factory on in the Tessl web app at delivery. It can't be scripted. Once, install the Tessl GitHub App on `boranfurkan` with All repositories.

**Safety:**
- Give Tessl's environment pull-request access only, and keep no secrets in it.
- Client text in the issue is quoted as data.
- **Open decision:** GitHub can't protect `main` on private repos without GitHub Pro, about $4 a month. Without it, nothing stops a merge except Tessl's default behaviour, which doesn't merge on its own. Decide before phase 7: buy Pro, or accept the risk.

## Memory

- **The database holds what must be exact:** stages, versions, amounts, signatures and events.
- **Agent Memory (REST) holds what's useful to recall:** the client's preferences, decisions and their reasons, past requests, and what was tried.
  - **When it's written:** when specs are agreed, a quote is accepted, a decision is made, or a request is triaged.
  - **When it's recalled:** when writing specs, quotes and triage.
  - **Scope:** facts are scoped per client and project, for example `discordlancer/client/<discord id>/project/<name>`.

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
  - Does an issue created with the label already on it start a run? The plan adds the label in a second call to be safe.
  - What does a typical run cost?
- **GitHub Pro** for protecting `main`: decide before phase 7.
- **Replit's Node version:** check when deploying.
- **Phantom and the reference:** does Phantom include the reference in a Solana Pay transfer? Expected yes. Test with a 0.01 USDC payment between your own wallets before the first client.
