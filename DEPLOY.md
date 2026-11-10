# Deploying to Replit

The bot runs as one always-on process. Replit's **Reserved VM** keeps it on. Autoscale deployments sleep when idle, which breaks a Discord bot. These steps were written on 9 Nov 2026. The items marked **check** could not be verified from outside Replit.

## Before you start

- **Stop any other copy of the bot,** including one running on your Mac (`pkill -f "tsx src/index.ts"`). Two copies would both answer every command and both record every payment.
- Redeem the hackathon Replit Pro coupon: `replit.com/~?redeemCoupon=[code removed]`.

## Steps

1. **Import the repo.** In Replit, create an app from GitHub and pick `boranfurkan/discordlancer`. Replit creates its own `.replit` file. Commit it only if it looks right.
2. **Check the Node version.** In the Replit Shell, run `node -v`. It must print `v24.x`. If not, set the Node.js version to 24 in the app's language or system settings (**check** where Replit puts this), then run `node -v` again.
3. **Add the Secrets.** Add each of the 18 required variables in `.env.example` under Secrets, with the same values as your local `.env`. `ELEVENLABS_API_KEY` is optional: with it, ElevenLabs transcribes recorded calls; without it, Gemini does.
4. **Install and check.** In the Shell:
   ```bash
   npm ci
   npm run check:env
   ```
   It should print `23 passed` once the two morning fixes are done. It says "no .env file" on Replit, which is expected.
5. **Publish as a Reserved VM.**
   - **Machine:** in **Publish → Adjust settings**, choose **Reserved VM** and the smallest machine size. Reserved VM is one machine, so only one copy of the bot runs.
   - **Commands go in the hidden `.replit` file,** not the publish screen (learned 9 Nov). To see it: Files → ⋮ → **Show hidden files**. Add:
     ```toml
     [deployment]
     build = "npm ci && npm run build"
     run = "npm start"

     [[ports]]
     localPort = 8080
     externalPort = 80
     ```
     Keep the `deploymentTarget` line Replit adds.
   - **No top-level `run = …` line.** It drives the editor's green Run button, which would start a second copy of the bot.
   - **The status page:** Replit only finishes publishing once a web page answers. The bot serves a tiny status page on `$PORT` or 8080, saying only `ok` and whether Discord is connected. Without it, publishing fails at **Promote** after about 10 minutes. `ignorePorts = true` didn't prevent that. Recorded calls need nothing extra on Replit: the voice library's encryption support (`@snazzah/davey`) ships a ready-made Linux build in the lockfile, and the voice intent isn't privileged. The same port also serves `/mcp` for Claude Code's progress updates; it answers only requests carrying a project key (see `PLAN.md`).
   - **Don't use "Fix with Agent"** or Replit's Agent: it changes code.
   - **To update the bot later:** push to GitHub, run `git pull` in the Replit Shell (or use the Git pane), then **Republish**.
6. **Check it's live.**
   - The deployment logs show `database connected`, `commands registered` and `discord ready`.
   - In Discord, `/help` answers with your laptop closed.

## Server setup

`node scripts/setup-server.mjs [--icon path/to/icon.png]` sets up the server's public side. Run it once on a new server; it's safe to rerun after changing the wording. It handles:
- the icon;
- the Owner and Client roles;
- trimmed `@everyone` permissions;
- the read-only `#welcome` and `#announcements`;
- join notices going to `owner-desk`.

The bot's own role must be at the top of the role list. If the bot reports "Missing Permissions" when ordering roles, drag any role once in Server Settings → Roles and save, then rerun the script.

## Updating later

Push to GitHub, pull the change in Replit, then republish. At startup the bot applies the database schema (safe to repeat) and registers its commands, so nothing else is needed.

## If something goes wrong

- **`Fix the environment: … is missing`:** a Secret is missing or misnamed. The message names it, never its value.
- **No `discord ready` line:** the Discord token is wrong, or the privileged intents are off. Run `npm run check:env`.
- **The database close times out on shutdown:** expected with SurrealDB 4. The bot gives up after 3 seconds and exits cleanly.
- **Logs:** every line is JSON and has secrets scrubbed. The events in SurrealDB are the record for the audit; the logs are for debugging.
