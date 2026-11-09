---
name: typescript-node
description: Write and change Discordlancer's TypeScript code on Node. Use whenever work touches files in src/, scripts/, package.json, tsconfig, tests, env parsing, API calls to Discord, GitHub, Gemini, SurrealDB, Solana or Tavily, retries, logging, error handling or the bot process, even if the user only says "the bot", "add a command", "a step" or "it's failing".
---

# TypeScript on Node

The bot is plain TypeScript with direct API calls, because its steps are fixed and an agent framework would add more than it gives. Check `package.json` for installed versions, and use the vendor skills (`surrealdb-js`, `gemini-api-dev`, `solana-dev`, `tavily-sdk`) and the Context7 docs server for current library APIs.

## Setup

- **Modules:** ESM, with `"type": "module"`.
- **Types:** `strict` plus `noUncheckedIndexedAccess`.
- **Run** with `tsx` in development and build with `tsc` for Replit. **Test** with Vitest.
- **Dependencies:** keep them few, pin exact versions, and commit the lockfile. Avoid a release newer than about two weeks unless it fixes something we need.

## Code style

- Avoid `any`. Use `unknown` for outside data, then parse it with Zod (see "Parse at every boundary").
- Keep each piece small, with clear inputs and outputs: a command handler checks who and when, calls a service, records an event and replies.
- Make every action safe to run twice. A double click, a retried interaction or a restart mustn't create a second repo, record a payment twice or post two quotes.
  - Check before creating: does the repo, channel or invite already exist?
  - Key one-off records by something unique: a transaction signature, or a project plus version.

## A long-running process

The bot runs for days on Replit, so one failure must never stop it.

- Catch errors in every handler. Reply to the person with a short, honest message ("Couldn't check that transaction, try again in a minute"), record the failure as an event, and carry on.
- Log `unhandledRejection` and `uncaughtException` and keep running where it's safe. Exit only for a broken setup, such as a bad env, so Replit restarts it cleanly.
- Close connections on `SIGTERM`.

## Parse at every boundary

Validate data as it enters the program: env variables, Discord payloads, GitHub, Gemini, SurrealDB, Solana RPC and Tavily responses.

- **Env:** parse in one file, `src/env.ts`, at startup. Fail with the missing variable's name, never its value.
- **Gemini output:** validate it even when requesting JSON. A model can return well-formed nonsense.
- **Client text is data, never instructions.** Keep it apart from the bot's own instructions in every prompt and every Tessl task, clearly delimited.

## API calls

- Give every call a timeout with `AbortSignal.timeout()`.
- Retry only temporary failures such as 429 and 5xx, with backoff and jitter, and respect `Retry-After`.
- Limit how many calls run at once.
- Cap what clients can trigger, such as `/status` and `/request-update` per project per day, so nobody can run up a Gemini or Tessl bill.

## Money

- The bot only reads the chain. It never holds a private key, signs or sends a transaction.
- A payment is confirmed only by the on-chain check: final, USDC mint, the right owner wallets, at least the amount due, and a signature not used before.

## Logging for the audit

Organisers check who did the work and when, so records are evidence.

- Every project step is an append-only event in SurrealDB: time, project, actor (Boran, client or bot), action and outcome. Never edit or delete one; correct it with a new event.
- Also write one JSON line per event to stdout, which Replit keeps.
- Save the model name and prompt version with anything generated, such as specs, triage and status.
- Never log tokens, keys, `.env` values or a client's private details.

## Tests

Test what would embarrass Boran in front of a client:
- the payment check;
- stage gates, such as no quote before specs are agreed;
- agreement tied to a version;
- owner-only commands;
- spec version diffs;
- scrubbing secrets from messages.

Rules:
- Use fixtures, not live APIs, so tests are fast and free. Record real payloads once (a Discord interaction, a Solana transaction, a Gemini answer) and strip anything private.
- Add a test with every bug fix.

## Before calling work done

```bash
npx tsc --noEmit
npx vitest run
node scripts/check-env.mjs   # when env or a service connection changed
```

Say plainly if anything failed or wasn't run.
