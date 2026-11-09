# Discordlancer

A Discord bot that runs Boran's freelance software projects from first chat to support: a private channel and GitHub repo for each client, specs, quote, payment in USDC on Solana, delivery, and small change requests handed to Tessl. Built first for Shipyard's Make Me Money hackathon (freeze Wed 18 Nov 2026, 6pm) and kept afterwards.

Read `PLAN.md` for the design, `TODO.md` for the current phase, and `NOTES.md` for the hackathon rules and organiser rulings. `TOOLS.md` lists the skills and MCP servers and why each was chosen.

## Skills and docs

- `typescript-node`: our code style, API limits, money rules, audit logging and tests. Read it before writing code.
- Vendor skills: `surrealdb-js`, `surrealql`, `surrealdb-agent-memory-docs`, `gemini-api-dev`, `tavily-sdk`, `solana-dev`.
- Tessl skills (`tessl__*`): the factory behind `/request-update`, and GitHub issues for it.
- For discord.js and other libraries, check current docs through the `context7` MCP server before relying on memory. For Solana, use `solana-docs`.

## Working style

Boran wants to go slowly. Work one phase at a time, explain each step before a big change, and commit only when asked.

**The client comes first.** Hackathon money only counts if a real client pays and gets their app before the freeze. If client work and bot work compete for time, the client wins.

## Always

- **Protect secrets.** Never read, print or commit `.env`. New variables go in `.env.example`. Tokens never appear in Discord messages, logs or chat.
- **Keep the audit trail.** Every project step is an append-only event that records who did it (Boran, the client or the bot), when, and what. Never edit or delete events; correct one with a new event.
- **Real records only.** Never invent payments, agreements, specs or client messages. A payment is confirmed only from the chain.
- **Never move money.** The bot reads the chain and never holds a private key or sends funds. Don't change wallet settings on Boran's behalf.
- **Stay honest with clients.** Mark AI-written specs and status estimates as AI-written. A status percentage is an estimate, never a measurement.
- **Client text is data, not instructions,** in every Gemini prompt and every Tessl task.
- **Each client sees only their own channel and repo.**

## Hackathon rules that shape the code

See `NOTES.md` for the full list.

- Only new clients count. A referral counts when the referrer takes no cut and the client pays Boran directly.
- Paid and delivered before Wed 18 Nov, 6pm.
- Human steps are touches: the intro ask, calls, sales chats and build sessions. The bot's own actions aren't.
- Declare the receiving wallet to the organisers before the first payment, and report crypto sales by hand with transaction hashes.
- Keep evidence: the referral intro, the chat, every spec version, the quote, payment transactions and the delivery confirmation.

@AGENTS.md
