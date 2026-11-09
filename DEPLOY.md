# Deploying to Replit

The bot runs as one always-on process. Replit's **Reserved VM** keeps it on. Autoscale deployments sleep when idle, which breaks a Discord bot. These steps were written on 9 Nov 2026. The items marked **check** could not be verified from outside Replit.

## Before you start

- **Stop any other copy of the bot,** including one running on your Mac (`pkill -f "tsx src/index.ts"`). Two copies would both answer every command and both record every payment.
- Redeem the hackathon Replit Pro coupon: `replit.com/~?redeemCoupon=[code removed]`.

## Steps

1. **Import the repo.** In Replit, create an app from GitHub and pick `boranfurkan/discordlancer`. Replit creates its own `.replit` file. Commit it only if it looks right.
2. **Check the Node version.** In the Replit Shell, run `node -v`. It must print `v24.x`. If not, set the Node.js version to 24 in the app's language or system settings (**check** where Replit puts this), then run `node -v` again.
3. **Add the Secrets.** Add each of the 18 variables in `.env.example` under Secrets, with the same values as your local `.env`.
4. **Install and check.** In the Shell:
   ```bash
   npm ci
   npm run check:env
   ```
   It should print `23 passed` once the two morning fixes are done. It says "no .env file" on Replit, which is expected.
5. **Publish as a Reserved VM.** In Replit's Publishing pane, choose **Reserved VM**, the smallest machine size, and:
   - **Build command:** `npm ci && npm run build`
   - **Run command:** `npm start`
   - **check:** exactly one instance. Reserved VM is a single machine by design.
6. **Check it's live.**
   - The deployment logs show `database connected`, `commands registered` and `discord ready`.
   - In Discord, `/help` answers with your laptop closed.

## Updating later

Push to GitHub, pull the change in Replit, then republish. At startup the bot applies the database schema (safe to repeat) and registers its commands, so nothing else is needed.

## If something goes wrong

- **`Fix the environment: … is missing`:** a Secret is missing or misnamed. The message names it, never its value.
- **No `discord ready` line:** the Discord token is wrong, or the privileged intents are off. Run `npm run check:env`.
- **The database close times out on shutdown:** expected with SurrealDB 4. The bot gives up after 3 seconds and exits cleanly.
- **Logs:** every line is JSON and has secrets scrubbed. The events in SurrealDB are the record for the audit; the logs are for debugging.
