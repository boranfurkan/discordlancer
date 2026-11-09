# Discordlancer: plan

Agreed with Boran on 8 and 9 Nov 2026. Open questions are at the end.

## What it does

Boran gets clients through referrals: an existing client introduces someone who needs an app built, with no cut (ruled a stranger sale by `efe_shipyard`, 9 Nov). Discordlancer turns each project into a private Discord channel with its own GitHub repo, and walks it through fixed stages. Every step is recorded, which makes the hackathon evidence pack, and the bot remembers each client and decision.

## Stack

- **Code:** TypeScript on Node 24, ESM, Zod 4 at every boundary, Vitest, tsx. Check versions at setup.
- **Discord:** discord.js, a gateway bot with slash commands and buttons.
- **Data:**
  - **SurrealDB database:** exact records, such as projects, spec versions, quotes, payments and the event log.
  - **SurrealDB Agent Memory:** facts about clients, projects and decisions, recalled when writing specs, quotes and change triage. This is aimed at the Best Use of Memory prize.
- **AI:** Gemini through an AI Studio API key. It writes specs, reads screenshots, triages change requests and estimates status.
- **Code hosting:** GitHub, with one repo per project under `boranfurkan`, created by the bot.
- **Payments:** USDC on Solana, checked through a Helius RPC URL using plain JSON-RPC. The bot only reads the chain.
- **Changes after delivery:** Tessl. The bot opens a GitHub issue with the `tessl` label, and Tessl opens a pull request.
- **Research:** Tavily, now and then, to look up an API or library a client mentions.
- **Hosting:** a Replit Reserved VM, which stays on.

The env variables and where to get each one are in `~/Desktop/env-setup.md` and `.env.example`.

## People

- **Boran (owner):** matched by `DISCORD_OWNER_ID`. Can run every command.
- **Client:** the person who joined through the project's invite. Sees only their own channel, plus public channels.
- **Bot:** acts on its own for checks, reminders and messages. Its actions aren't touches.

Every command is visible to both people. If a client runs an owner-only command, they get a private "only Furkan can do this" reply. Commands work only inside a project channel, except `/new-project`.

## Project stages

```
created → joined → specs agreed (vN) → quote accepted (vN) → paid → in development → delivered → support
                                                                     (cancelled or archived at any point)
```

- **Agreement is tied to a version.** If Boran regenerates the specs or changes the quote, earlier agreement is cleared, and both people have to agree again.
- **A quote needs agreed specs.** A payment needs an accepted quote. Development needs a confirmed payment.

## Commands

| Command | Who | What it does |
|---|---|---|
| `/new-project name` | Boran | Creates the private channel, a single-use invite and an empty private repo with the same name. Replies with the invite link to send to the client |
| `/link-client user` | Boran | Fallback: attaches a member to the project by hand if invite tracking missed them |
| `/project` | Both | Project card: stage, spec version, quote, payment, deadline, what's next |
| `/help` | Both | The commands the caller can run at this stage |
| `/add-github username` | Both | Adds the client's GitHub account to the repo as a collaborator |
| `/create-specs` | Boran | Gemini reads the whole channel since the project started, including images and files, plus the previous spec. It writes the new full spec and "what changed since vN", posts it as a file and pins it |
| `/agree-specs` | Both | Agrees to the current spec version. Needs both people |
| `/quote amount deadline` | Boran | Posts quote vN: amount in USDC, delivery date, spec version and short terms (scope is spec vN, the client owns the code once paid, how revisions work) |
| `/accept-quote` | Both | Accepts the current quote version. Needs both people |
| `/set-payment-wallet address` | Client | Declares the Solana wallet the client will pay from. It's recorded before payment as proof the wallet is theirs |
| `/wallet` | Both | Shows Boran's receiving address and the network (USDC on Solana) |
| `/pay` | Client | Shows the amount due from the accepted quote, Boran's address and how to send |
| `/paid tx` | Client | Submits a transaction signature. The bot checks it on chain |
| `/receipt` | Both | A receipt for a confirmed payment |
| `/start-development` | Boran | Marks the start of building. Needs a confirmed payment |
| `/status` | Client | Gemini compares the repo with the agreed spec, and gives a short summary and an estimated percentage, marked as an estimate |
| `/confirm-delivery` | Both | Boran marks it delivered, then the client confirms with a button. Both together set the stage to delivered |
| `/request-update text` | Client | After delivery: asks for a small change. See below |
| `/export` | Boran | Builds the evidence pack: transcript, every spec version, quotes, payment transactions, delivery confirmation and events |
| `/cancel`, `/archive` | Boran | Closes the project. The channel becomes read-only and nothing is deleted |

The bot also logs each of Boran's own actions as a touch, and can draft the day's `/touch` line for the hackathon Discord.

## Joining

- `/new-project` creates a single-use invite that expires after 7 days.
- When someone joins, the bot compares invite use counts to see which invite was used, then opens that project's channel to them with a member-specific permission.
- The welcome message explains how the channel works and includes a short privacy note: what the bot stores and why.
- Joins need the Server Members intent and the Manage Server permission. The bot reads message history when someone runs `/create-specs`, which needs the Message Content intent.

## Payment check

`/paid tx` passes only if all of these hold:
- the transaction is final and succeeded;
- the mint is USDC, `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`;
- the token balance owned by Boran's wallet rose by at least the amount due;
- the sending owner is the client's declared wallet;
- the signature hasn't been used before.

Each check is recorded either way. A failed check never changes the stage.

## Change requests after delivery

1. The client sends `/request-update` with a description.
2. Gemini triages it: is it clear, small and inside the delivered scope? If not, the bot asks questions, or suggests a new quote for bigger work.
3. Boran approves with a button.
4. The bot opens a GitHub issue with a clear task, then adds the `tessl` label in a second call.
5. Tessl opens a pull request on a `tessl/` branch.
6. Boran reviews and merges it. The bot posts the outcome in the channel.

**Limits:** a monthly cap of requests per client, because Tessl charges credits per model call and publishes no per-run price.

**Safety:**
- Give Tessl's environment pull-request access only.
- Protect `main` so nothing merges without Boran's approval.
- Keep no secrets in Tessl's environment.
- Client text in the issue is quoted as data.

**Setup per repo:** turn the factory on in the Tessl web app at delivery. It can't be scripted. The repo stays under `boranfurkan` while support runs.

## Memory

- **The database holds what must be exact:** stages, versions, amounts, signatures and events.
- **Agent Memory holds what's useful to recall:** the client's preferences, decisions and why they were made, past requests, and what was tried. The bot recalls it when writing specs, quotes and triage, so Boran repeats less and touches less.

## Out of scope for now

- **Stripe.** USDC only, as Boran chose. Stripe sales would count automatically, so add it if a client asks to pay by card.
- **Staged payments.** One payment per quote for now.

## Open questions

- Tessl: does an issue created with the label already on it start a run? The plan adds the label in a second call to be safe.
- Tessl: what does a typical run cost?
- Agent Memory: SDK details (`@surrealdb/memory`) and how to scope facts per client.
- Discord: invite tracking can miss a join if the bot restarts at that moment. `/link-client` covers it.
