# TODO

Freeze: **Wed 18 Nov, 6pm.** The client comes first, so bot work fits around the client's project, never the other way round. The design is in `PLAN.md`, tools and skills in `TOOLS.md`.

## Boran

**Morning of Mon 9 Nov, in this order.** The bot was built overnight (phases 1, 2 and 4 to 7). It is running on the Mac until it is deployed.

1. [x] **Ask your referrer for an intro.** Keep the message for the audit, and log the ask as a touch.
2. [x] **GitHub token:** replaced with a classic token (`repo` scope only). The fine-grained token kept failing to add collaborators even with Administration: Read and write. Delete the old fine-grained token if you haven't.
3. [x] **Discord:** the bot's role has **Pin Messages**.
4. [x] `npm run check:env`: 23 passed on 9 Nov, morning.
5. [ ] **Real-person check:** on 9 Nov at 22:04 Ahmet joined the test project `ahmetin-yarra` through its invite and got the Client role (from the event log). Still to confirm with Boran: only that channel opened for him, and `/help` and `/project` worked.
   - [ ] **Later, Boran:** a real 0.01 USDC payment through `/pay` with Phantom, to confirm Phantom includes the reference.
6. [x] **Review the default quote terms** in `src/discord/texts.ts` (`quoteTerms`).
7. [x] **Deployed to Replit (9 Nov):** a Reserved VM, live at the status page https://discordlancer.replit.app. Don't run a copy on the Mac any more. Updates: push, `git pull` in Replit, Republish (`DEPLOY.md`).
   - [x] Fresh reset after deploying (9 Nov, 17:09): empty database, empty `#owner-desk`, no invites; backup in `backups/`.
   - [x] Reset again after Boran's test with Ahmet (10 Nov, 00:28): test channel deleted, Ahmet removed from the server, database and `#owner-desk` emptied; backup in `backups/`.
8. [ ] **Hackathon admin:**
   - [x] the organisers know you're solo;
   - [ ] declare your Solana receiving wallet to them before the first payment.
9. [ ] **Before using Approve on a real client's change request:**
   - [x] Tessl GitHub App on `boranfurkan`, reaching all repos (checked 9 Nov);
   - [x] end-to-end test passed on `dl-test-tessl` (PR in about 70 s, 17 credits);
   - [ ] turn on the factory for the client's repo (the `tessl__factory-setup` skill, as for the test repo);
   - [ ] decide: limit Tessl to pull requests only (move its automations into `tessl.json`), and/or GitHub Pro to protect `main`.
   - [ ] note: clients are added read-only, but on a private repo **any human comment on a Tessl pull request starts a "Shepherd PR" run**. A client's comment could change the pull request and spend credits without your approval. Moving the automations into `tessl.json` is also where to limit who can trigger runs.
10. [x] **Test leftovers cleaned up (9 Nov):**
    - Discord channels, the database and the test repos were reset (backup in `backups/`);
    - `boranfurkan/dl-test-tessl` stays on purpose, for `scripts/tessl-e2e.ts`.
11. [x] Cloudflare API token and the old fine-grained GitHub token deleted.

Done earlier:
- [x] env values collected;
- [x] Discord server and bot;
- [x] SurrealDB instance and Agent Memory context.

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

- [x] Write the deploy guide: `DEPLOY.md`. The env check now works without a `.env` file, as on Replit.
- [ ] Import the GitHub repo into Replit. Check that it runs Node 24.
- [ ] Add every variable in Replit Secrets, then run `npm run check:env` there.
- [ ] Deploy as a **Reserved VM** with exactly one instance. Build: `npm ci && npm run build`. Start: `npm start`.
- [x] Note the steps: in `DEPLOY.md`.

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
- [ ] Turn on the Tessl factory for a real client repo: scriptable with the `tessl__factory-setup` skill, done for `dl-test-tessl` on 9 Nov. Decide first whether to limit it to pull requests only (see Boran, step 9).
- [x] Report Tessl's pull request back into the Discord channel: posted when it opens (plus a review reminder in owner-desk), when it's merged, and when it's closed. Checked every minute; matching tested against the real Tessl pull request.
- [x] Agent Memory through REST, one scope per project (`discordlancer/project/<name>`), registered on first use:
  - **written** when specs are agreed, a quote is accepted, a payment arrives, a delivery is confirmed, and a change is triaged or approved;
  - **recalled** in `/create-specs`, `/progress` and triage.

  Memory is best-effort: a failure is logged and never stops a command.
- [ ] Optional: connect the Agent Memory MCP server for development.

### Phase 8: Questions (added 9 Nov)

- [x] `/ask question` for anyone in the project; a client gets 15 a day per project.
- [x] Boran's "answer this": reply to the client's message and tag the bot (the rest of his message is a note for the answer), or **Apps → Answer with AI** (owner only, hidden from clients).
- [x] Context gathered fresh for each answer: the live chat (bot posts included), spec, quote, payments, change requests, Agent Memory and the code. See `PLAN.md`, Questions.
- [x] Guardrails tested against the real Gemini: a normal question, a discount request (refused, flagged to Boran) and a prompt injection (refused).
- [ ] **Live check after deploying:** in a test channel, try `/ask`, a tagged reply and the menu once each.

### Phase 12: Files, repo reviews, previews and deposits (added 10 Nov)

- [x] Shared files and links read once when posted, into append-only `file_note`s; 📎 Files thread; `/read-files`; notes feed specs, `/ask`, docs (`files.md`) and Claude Code's brief. See `PLAN.md`, Shared files and links.
- [x] Real check: a PDF, a Word file and observv.com read by the real Gemini.
- [ ] **Live check after deploying:** in a test channel, post a PDF, a screenshot, a voice note and a link; check 👀/✅, the 📎 Files thread, and a reply under a `.fig` file.
- [x] Preview links: open pull requests' previews (Vercel, Netlify, Cloudflare Pages) posted in 🔧, held back while behind a sign-in. See `PLAN.md`, Preview links.
- [ ] **Boran, per project on Vercel:** import the repo once, and turn off Vercel Authentication (Settings → Deployment Protection) so the client can open previews.
- [x] `/review-repo` for an existing codebase (GitHub link or zip): reference notes, a pull request adding `docs/references/<name>.md`, and the notes in specs, `/ask`, docs and the brief. See `PLAN.md`, Reviewing an existing codebase. Real check on a public repo.

### Phase 11: Client teams and threads (added 10 Nov)

- [x] `/invite` for each extra person on the client's team; joins matched through the `invite` table; channel, voice, threads and the Client role for each. Anyone on the team acts for the client (Boran's choice). See `PLAN.md`, People and permissions.
- [x] 📞 Calls, 🔧 Code changes and 📈 Progress updates threads in each project channel. See `PLAN.md`, Threads.
- [x] Journey test: the client's CTO joins with a team invite, agrees for the team, and is in the Code changes thread.
- [x] **Live on Replit (10 Nov):** two progress updates through Claude Code made one 📈 Progress updates thread (public, archives after a week), with Boran added; the main channel got only Discord's "started a thread" line. Reset afterwards.
- [ ] A team invite with a real second person, when one is available.

### Phase 10: Calls and project docs (added 10 Nov)

- [x] `/call start | stop | retry`: consent buttons, per-speaker recording, Ogg writer, Gemini transcription and summary, append-only `call` table, notes and transcript in the channel, memory. See `PLAN.md`, Recorded calls.
- [x] Calls feed `/ask`, `/create-specs` and the evidence pack.
- [x] `/sync-docs`: writer and reviewer passes, citation check, one pull request on `discordlancer/project-docs`. See `PLAN.md`, Project docs in the repo.
- [x] Real checks: spoken audio through the real transcription and summary; the real docs passes; a real commit and pull request with the bot's token.
- [x] Transcription by ElevenLabs Scribe (one request per speaker, word timings back to turns, its copy deleted after), Gemini as the fallback. Unit-tested with a fake ElevenLabs.
- [ ] **Boran:** claim the ElevenLabs credit (tag the organisers in the team channel, by 21 Nov), make an API key with only the Speech to Text permission, and add `ELEVENLABS_API_KEY` to `.env` and Replit Secrets. Then Claude runs the spoken test clips through the real ElevenLabs.
- [x] **Live on Replit (10 Nov):** a real call in a test voice channel, transcribed by ElevenLabs; `/sync-docs` updated the pull request with 0 unmatched citations (about 6 minutes). Reset afterwards.
- [ ] **Boran:** delete the test repo `boranfurkan/dl-test-docs` afterwards.

### Phase 9: Progress updates from Claude Code (added 10 Nov)

- [x] MCP endpoint at `/mcp` on the bot's web port, with a key per project: `get_project_brief` and `post_update`. See `PLAN.md`, Progress updates from Claude Code.
- [x] `npm run claude:connect -- <project> [folder]`: clone, key, `claude mcp add` for that folder only, `CLAUDE.md` section and `/update-client`.
- [x] Checked locally against the official MCP client (handshake on protocol 2025-11-25, both tools, an update posted), and a real Claude Code session connected and read the brief.
- [x] **Live check on Replit (10 Nov)** with a test project, `dl-test-updates`:
  - `claude:connect` cloned the repo, made the key and connected Claude Code, and its live check passed;
  - a real Claude Code session ran `/update-client` and the update appeared in the channel, marked as AI-written and pinging nobody;
  - the event was recorded, the brief showed the update, and memory recalled it;
  - refused as intended: a wrong or missing key, an update containing a GitHub token, an overlong update, and a 7th update in one day;
  - running `claude:connect` again turned the old key off.

  Reset afterwards (backup in `backups/`). Lesson: the reset must retry applying the schema, because the live bot uses the database at the same time.
- [ ] **Boran:** delete the test repo `boranfurkan/dl-test-updates` (neither the bot's GitHub token nor `gh` may delete repos).

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
