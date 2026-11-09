---
name: discord-bot
description: Discordlancer's discord.js conventions - adding a command, the command gate (owner-only, project channel, client, stage), replies and deferring, user-facing errors, channel permissions, invites and join tracking, and testing in the real server. Use whenever work touches src/discord/, a slash command, a button, channel or invite handling, or the bot's wording, even if the user only says "add a command", "the bot says", "the channel" or "the invite".
---

# Discord in Discordlancer

discord.js 14.27, a gateway bot on one server (`DISCORD_GUILD_ID`). For library details, check the discord.js guide and API docs through Context7 before relying on memory. Read `typescript-node` and `surreal-data` first.

## Adding a command

1. Create `src/discord/commands/<name>.ts` exporting a `Command` (see `src/discord/command.ts`):
   - **`access`:** `everyone` or `owner`.
   - **`where`:** `anywhere` or `project`.
   - **`stages`:** optional; the command works only at these stages.
   - **`definition`:** built with `SlashCommandBuilder`.
   - **`execute(run)`:** does the work.
2. Add it to `COMMANDS` in `src/discord/commands/index.ts`. It's registered on our server at startup, or with `npm run commands:register`.
3. Add tests for any pure logic it has, and check `helpText` lists it at the right stages.

## The gate (in `src/discord/client.ts`)

Before `execute` runs, `checkGate` refuses, with a private reply and a `refused` event:
- owner-only commands run by anyone else;
- project commands outside a project channel;
- anyone other than Boran or the project's client;
- the wrong stage.

Then `execute` runs. The handler records `command.<name>` with outcome `ok`, `refused` or `failed`. Only commands with `where: 'project'` are filed under the channel's project, because a command that works anywhere may be about another project.

## Replies and errors

- **Discord expects an answer within 3 seconds.** Anything slower (GitHub, Gemini, Solana, creating channels) calls `interaction.deferReply()` first, then `editReply`.
- **Use private replies** (`flags: MessageFlags.Ephemeral`; the old `ephemeral: true` is deprecated) for anything only the caller needs. Use public replies for results both people should see, like `/add-github` or `/cancel`.
- **Throw `UserError`** with a plain, honest message for anything the person can act on. It's shown as is and recorded as `refused`. Never put secrets or internal details in it.
- **Any other error** becomes "Something went wrong on my side…", is logged in full and recorded as `failed`. `safeReply` handles a deferred interaction too.
- **Service errors** like `GitHubError` are turned into `UserError` in the command.
- **Wording** lives in `src/discord/texts.ts`: `STAGE_LABEL`, `NEXT_STEP`, `welcomeText`. Keep it short and plain.

## Channels and permissions (`src/discord/channels.ts`)

- **Project channels** live under the `Projects` category. They're hidden from `@everyone` and visible to the bot and Boran. Each client gets a member-specific overwrite.
- **Boran's private channel** is `owner-desk`, for notices such as unmatched joins.
- **An overwrite can't grant Manage Roles** unless the bot is an Administrator. The bot's server-wide Manage Roles is enough to edit overwrites, so the bot's overwrite leaves it out.
- **Every helper is safe to run twice:** it finds an existing category or channel before creating one.
- **Nothing is ever deleted.** Cancel and archive only make the channel read-only for the client.

## Invites and joins (`src/discord/joins.ts`)

- **Each project invite is single-use, lasts 7 days and is unique.** Discord deletes it once it's used.
- **On a join,** the project in stage `created` whose invite has just disappeared, and hadn't expired, is the one. The database is the source of truth, so this survives restarts. If none or several match, Boran is told in `owner-desk` and uses `/link-client`.
- **Never leave a second live invite for a project.** Renewing one with `/new-project` deletes the old one, and so does cancelling a project that is still waiting for its client.

## Testing in the real server

- **Unit-test the pure parts:** `checkGate`, `helpText`, `matchJoin`, `projectCard`, texts. Use fakes for services, like `createGitHub(env, { fetch })`.
- **Then try each command in our server.** Name test projects `dl-test-*`, and list what was created so Boran can clean up.
- **Only one bot process may run at a time.** Two would both handle every interaction and join. Stop the old one before starting a new one.
- **Things that need a second Discord account** (a client joining, client-only commands) wait for Boran. Note them in `TODO.md`.
- **To type commands in Discord's web app:** type the command, press Tab to select it, type the option values, then Enter. Boolean options show a True/False list to click.
