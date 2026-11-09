# TODO

Freeze: **Wed 18 Nov, 6pm.** The client comes first, so bot work fits around the client's project, never the other way round. The design is in `PLAN.md`, tools and skills in `TOOLS.md`.

## Boran

- [ ] **Ask your referrer for an intro today.** Keep the message for the audit, and log the ask as a touch.
- [x] Collect the env values. All 22 checks in `scripts/check-env.mjs` passed on 9 Nov.
- [x] Discord server and bot: both intents on, all 11 permissions.
- [x] SurrealDB instance (`freelance-management-db`) and Agent Memory context.
- [ ] **GitHub token:** set Repository permissions → Administration to **Read and write** (Settings → Developer settings → Fine-grained tokens → your token → Edit). The token value doesn't change. Needed by `/add-github`.
- [ ] **Discord:** give the bot's role **Pin Messages** (Server Settings → Roles). Needed to pin specs.
- [ ] **Review the default quote terms** in `src/discord/texts.ts`.
- [ ] **Morning tests** that need a second Discord account: see "Still needs Boran" under each phase.
- [ ] **Clean up test leftovers when done:**
  - the `#dl-test-*` channels;
  - the private repos `boranfurkan/dl-test-*`.
- [ ] Redeem the Replit Pro coupon (`replit.com/~?redeemCoupon=[code removed]`). Needed by phase 3.
- [ ] Tell the organisers you're solo now.
- [ ] Declare your Solana wallet to the organisers before the first payment.
- [ ] Delete the Cloudflare API token (dashboard → My Profile → API Tokens).
- [ ] Before phase 7: install the Tessl GitHub App on `boranfurkan` with All repositories, and decide on GitHub Pro (see `PLAN.md`, Change requests).

## Build phases

Each phase ends with `npx tsc --noEmit`, `npx vitest run` and a check in our Discord server, then a commit when Boran asks. Read the skills listed before writing code.

### Phase 1: Skeleton (target Mon 9 Nov)

Skills: `typescript-node`, `surrealdb-js`, `surrealql`. Context7 for discord.js 14.

- [x] `package.json`:
  - ESM;
  - Node 24 in `engines`;
  - scripts: `dev`, `build`, `start`, `test`, `typecheck`, `db:migrate`, `commands:register`, `check:env`.
- [x] Install the exact versions in `PLAN.md`, and commit `package-lock.json`. TypeScript became 6.0.3 (see `PLAN.md`).
- [x] `tsconfig.json`: `strict` and `noUncheckedIndexedAccess`, `module` `nodenext`, output to `dist/`.
- [x] `src/env.ts`: Zod, using the names in `.env.example`. A missing variable is reported by name only.
- [x] `src/log.ts`: JSON lines to stdout, with secrets scrubbed.
- [x] `src/db/client.ts`: WebSocket connection, sign in, use `freelance`/`bot`, reconnect.
- [x] `src/db/schema.surql` and `npm run db:migrate`:
  - tables, fields and unique indexes from `PLAN.md`;
  - the append-only guard on `event`, and on the other history tables.
- [x] `src/db/events.ts`: `recordEvent()`.
- [x] `src/domain/stages.ts`, `money.ts` and `names.ts`, with unit tests.
- [x] `src/discord/client.ts` with the four intents, `register.ts` for server commands, and `/help`.
- [x] Tests:
  - the append-only guard, against an in-memory database (`@surrealdb/node`);
  - stage rules;
  - money parsing (micro-USDC, never floats);
  - name rules;
  - secret scrubbing.
- [x] Write the `surreal-data` skill: our schema, the event log, transactions, and what the append-only test showed.

**Done when:**
- the bot shows online in the server;
- `/help` answers;
- the `/help` use appears as an event in SurrealDB;
- an update or delete on `event` is refused, or the gap is recorded;
- all tests pass.

**Met on 9 Nov.** Boran's `/help` was recorded as `owner command.help ok`, and the guard was proven on the cloud server.

### Phase 2: Project start (target Tue 10 Nov)

Skills: `typescript-node`, `surreal-data`. Context7 for discord.js and Octokit.

- [x] `/new-project name`. Running it twice must not create a second channel, invite or repo. It does four things:
  - checks the name;
  - creates the channel under `Projects`, hidden from `@everyone`;
  - creates a single-use, 7-day invite;
  - creates a private repo with a README.

  Running it again on a project still waiting for its client issues a fresh invite and retires the old one.
- [x] Join tracking: the joined member gets channel access and a welcome with the privacy note. It reads invites fresh from Discord rather than caching them.
- [x] `/link-client`, `/add-github`, `/project`, `/cancel`, `/archive`.
- [x] Guards:
  - owner-only commands;
  - commands that only work in a project channel;
  - a client only in their own project;
  - stage checks, each with a clear private reply.
- [x] Write the `discord-bot` skill.

**Tried live on 9 Nov (overnight):**
- `/new-project` (new, and again to renew the invite);
- stage-aware `/help`;
- `/project`;
- `/cancel` with False and with True;
- `/archive`.

**Still needs Boran:**
- **Give the GitHub token Administration "Read and write".** `/add-github` is blocked until then; the env check now tests this.
- **Second-account test:** join with the `dl-test-alpha` invite and check it opens only that channel with the welcome. Then try `/add-github` and `/project` as the client.

**Done when:** in our server, with a second Discord account playing the client:
- a project is created;
- the invite opens only that channel;
- `/add-github` adds a collaborator;
- every step shows as an event.

### Phase 3: Deploy (target Tue 10 Nov)

Needed before the first invite goes to a real client, because join tracking needs the bot online.

- [ ] Import the GitHub repo into Replit. Check that it runs Node 24.
- [ ] Add every variable in Replit Secrets, then run `npm run check:env` there.
- [ ] Deploy as a **Reserved VM** with exactly one instance. Build: `npm ci && npm run build`. Start: `npm start`.
- [ ] Note the steps in `TOOLS.md`.

**Done when:** the bot stays online with your laptop closed, and a test join from a second account works.

### Phase 4: Agreement (target Wed 11 Nov)

Skills: `gemini-api-dev` (fetch its interactions, structured output and image docs first), `surreal-data`, `discord-bot`. Optionally `tavily-sdk`.

- [x] `services/gemini.ts`:
  - `store: false`;
  - `gemini-3.8-flash` for specs, `gemini-3.5-flash-lite` for small calls;
  - structured output checked with Zod;
  - model and prompt version saved;
  - retries on bad output, 429 and 5xx, and a clear message when credits run out.
- [x] `/create-specs`:
  - reads the channel since the project started, including images and small text files;
  - writes spec version N with what changed and open questions;
  - posts it as a `.md` file and pins it (pinning needs the Pin Messages permission);
  - clears an earlier spec agreement.
- [x] `/agree-specs`, `/quote amount deadline` (London time, warns after the freeze), `/accept-quote`. All are tied to a version. Posting a quote counts as Boran's acceptance, so only the client runs `/accept-quote`.
- [ ] Optional: Tavily lookups for third-party APIs named in the chat, added to the spec as clearly marked research notes. Not done yet.
- [x] Tests:
  - version resets;
  - gates;
  - quote amounts and deadlines (GMT and BST);
  - Gemini output that fails validation.

**Tried live on 9 Nov (overnight)** on `dl-test-gamma`:
- a real Gemini spec from three test messages, posted with its file;
- `/agree-specs` by Boran;
- `/quote` with the after-freeze warning;
- `/accept-quote` refused for Boran.

With no second account, the project was moved past the client's steps by a script. Each move is recorded as a `test.stage_forced` event that says so.

**Still needs Boran:**
- **Give the bot "Pin Messages":** Server Settings → Roles → the bot's role. Discord split it out of Manage Messages. Until then, specs post but aren't pinned.
- **Review the default quote terms** in `src/discord/texts.ts` (`quoteTerms`). They're a business decision.
- **Second-account test:** the client runs `/agree-specs` and `/accept-quote`.

**Done when:** a test project in our server goes from chat to agreed specs and an accepted quote.

### Phase 5: Payment (target Thu 12 Nov)

Skills: `solana-dev` (`payments.md`, `rpc-quick-lookups.md`, `kit/*`), the `solana-docs` MCP server, `surreal-data`.

- [x] `/set-payment-wallet` (client only; checks it's a real wallet, not a token account or program), `/wallet`.
- [x] `/pay`: a payment request with a unique reference, plus the Solana Pay link and QR code. Running it again reuses the open request; a request for an older quote is expired automatically.
- [x] The watcher (every 20 seconds) and `/paid signature`, with every check in `PLAN.md`:
  - `finalized`;
  - `maxSupportedTransactionVersion: 1`;
  - USDC mint;
  - both wallets;
  - the amount;
  - a unique signature.

  Each payment is recorded once, together with its request, the stage change and the event. A rejected transaction is reported once in `owner-desk`.
- [x] `/receipt`, `/start-development`.
- [x] Tests with a recorded mainnet transaction (addresses replaced):
  - a valid payment;
  - too little;
  - the wrong mint;
  - the wrong sender;
  - the wrong recipient;
  - the same signature twice;
  - a failed transaction;
  - a missing reference.
- [ ] **Live test (Boran):** with the second account as the client, declare one of your wallets, `/pay`, scan the QR code with Phantom and pay 0.01 USDC. Check that the bot confirms by itself within about a minute, and that `/receipt` shows it.

**Tried live on 9 Nov (overnight)** on `dl-test-gamma`:
- `/pay` made the request, the Solana Pay link and the QR code;
- `/paid` with a real but unrelated mainnet transaction was refused ("no USDC reached the receiving wallet");
- the watcher ran with no errors.

The client steps were done by a labelled test script, using a throwaway wallet whose key was discarded. No money moved.

**Done when:** the live test payment is found by itself, verified, recorded once and receipted.

### Phase 6: Delivery and evidence (target Fri 13 Nov)

- [x] `/confirm-delivery`: Boran marks it, with an optional note, then the client confirms with a button or the command. Only the client can confirm.
- [x] `/export`: posts the evidence pack to `owner-desk`:
  - a summary (project, specs, quotes, agreements, payments with explorer links, event log);
  - the full channel transcript;
  - the events as JSON;
  - the spec files.
- [x] `/report`: drafts the daily sales report for the organisers, with transaction hashes and the running total. Test projects are left out.
- [x] `/touches`: drafts today's `/touch` line from Boran's own recorded actions. Test projects are left out.

**Done when:** a test project's full history exports cleanly, and the drafts read right. **Met on 9 Nov (overnight)** on `dl-test-gamma`, which was moved to paid by a labelled test script: no payment was made or recorded.

**Still needs Boran:**
- **Second-account test:** the client clicks "Confirm delivery".
- **Read a `/report` draft** against what the organisers ask for, once a real payment exists.

### Phase 7: After delivery (once the client's build is on track)

Skills: the `tessl__*` skills, `gemini-api-dev`, `surrealdb-agent-memory-docs`.

- [x] `/progress` (renamed from `/status`, because the Wordle app in our server already has a `/status`): reads the repo's default branch (README, manifest, source; at most 40 files and 300 KB), compares it with the agreed spec, gives an estimate marked as one. Limit: 3 a day per project.
- [x] `/request-update`:
  - Gemini triage: small, needs info, or needs a quote;
  - Boran approves or declines with buttons (owner only);
  - approving opens an issue, then adds the `tessl` label in a second call;
  - a failed issue can be retried with Approve.
  - Limit: 10 per 30 days.
  - Reporting the pull request back is not built yet.
- [ ] Turn on the Tessl factory for a client repo, and set its environment to pull-request access. **Boran, in the Tessl web app.**
- [x] Agent Memory through REST, one scope per project (`discordlancer/project/<name>`), registered on first use:
  - **written** when specs are agreed, a quote is accepted, a payment arrives, a delivery is confirmed, and a change is triaged or approved;
  - **recalled** in `/create-specs`, `/progress` and triage.

  Memory is best-effort: a failure is logged and never stops a command.
- [ ] Optional: connect the Agent Memory MCP server for development.

**Tried live on 9 Nov (overnight)** on `dl-test-gamma`:
- `/progress` gave "about 0%", correctly, with the spec's features listed as still to do;
- a small request was triaged as small and then declined with the button;
- a bigger request (online deposits, loyalty points) was triaged as needing a quote;
- memory scopes were registered, and memory writes and recalls succeeded.

**Approve was not clicked live:** it adds the `tessl` label, which could start a paid Tessl run. It is covered by tests with a fake GitHub.

**Still needs Boran:**
- **Before using Approve for real:**
  - install the Tessl GitHub App;
  - turn on the factory for that repo;
  - decide on GitHub Pro (protecting `main`).
- **Then try Approve** on a test repo, and check that Tessl opens a pull request.

**Done when:** a test change request becomes a Tessl pull request on a test repo, and a recalled fact shows up in a new spec.
