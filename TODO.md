# TODO

Freeze: **Wed 18 Nov, 6pm.** The client comes first, so bot work fits around the client's project, never the other way round.

## Boran, now

- [ ] **Ask your referrer for an intro today.** Keep the message for the audit, and log the ask as a touch.
- [ ] Collect the env values (`~/Desktop/env-setup.md`).
- [ ] Create the Discord server and the bot application.
- [ ] Redeem the Replit Pro coupon and the SurrealDB credit.
- [ ] Tell the organisers you're solo now.
- [ ] Declare your Solana wallet to the organisers before the first payment.
- [ ] Delete the Cloudflare API token (dashboard → My Profile → API Tokens).
- [ ] Decide whether to delete the remaining Google API key, "sample".

## Build phases

Target: phases 1 to 4 ready by Wed 11 Nov, so a client can be quoted and pay through the bot.

1. **Skeleton:** package setup, env parsing, the bot connects, commands register, SurrealDB connects, event log.
2. **Project start:** `/new-project` (channel, invite, repo), join tracking, `/link-client`, `/add-github`, `/project`, `/help`.
3. **Agreement:** `/create-specs`, `/agree-specs`, `/quote`, `/accept-quote`.
4. **Payment:** `/set-payment-wallet`, `/wallet`, `/pay`, `/paid` with the on-chain check, `/receipt`, `/start-development`.
5. **Delivery and evidence:** `/confirm-delivery`, `/export`, touch log. Needed by Mon 16 Nov.
6. **After delivery:** `/status`, `/request-update` with Tessl, Agent Memory recall. Once the client's build is on track.
7. **Hosting:** deploy to a Replit Reserved VM, with every variable in Secrets. Before the first client joins.
