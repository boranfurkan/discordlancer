# Make Me Money (Shipyard) — Notes

Organised digest of everything we've read. Raw material is in `sources/`. Last updated 9 Nov 2026. Rulings about in-person shop selling and Google Maps date from the earlier idea and are kept for the record.

**Sources read so far**
- [x] Participant Guide PDF (`sources/participant-guide.pdf`, text in `.txt`). Refs like p.8 point here
- [x] Event detail page (`sources/event-page.md`), but the FAQ answers were missing from the paste
- [x] Discord (`sources/discord/`): starter-kit, rules, announcements, money-feed, general, support, office-days, credit-support
- [x] SurrealDB participant pack (`sources/surrealdb-pack.md`)
- [ ] Discord: workshop-schedule, ask-mentors, our own team channel

**Which source wins:** organiser answers on Discord, then the guide, then the event page. The event page is marketing and is wrong on at least one big point (the £100).

---

## Our team (updated 9 Nov)

- **Solo since 7 Nov.** The teammate left because they didn't have time to visit shops. Boran is "Furkan Bey" on Discord. Tell the organisers about the team change.
- **Business since 9 Nov: freelance app development for new clients,** run through the Discordlancer bot (see `PLAN.md`). Clients are paid in USDC on Solana.
- **The earlier idea, AI-built websites for local shops, is closed.** Its code, agent logs and outreach log are in the archived private repo `boranfurkan/make-me-money-hackathon`, branch `phase-1-cafe-template`. Touches from 2 to 8 Nov relate to that work.
- **Goal:** podium first (highest profit), side prizes where they fit, especially Best Use of Memory. It's picked by SurrealDB, so it's a target, not a certainty. Criteria are under Prizes.

## UK setup: Stripe and tax (checked 5 Nov 2026, not professional advice)

- **No company needed to start.** GOV.UK: you can start trading straight away without registering. Third-party guides say Stripe has an "Individual / Sole trader" option; we couldn't find Stripe's own UK page to confirm.
- **Stripe sign-up needs (per those guides):** name, date of birth, address, phone, description of what you sell, UK bank account, possibly photo ID. One guide says the website field is required; a participant says it can be left empty.
- **£1,000 trading allowance** applies to individuals for tax year 6 Apr 2026 to 5 Apr 2027. Over £1,000 gross, register for Self Assessment by 5 Oct 2027. It rises to £3,000 from 6 Apr 2027 (proposed in Budget 2026, legislation pending), which is too late for hackathon income.
- **Two-person catch:** the allowance doesn't apply to partnership trading income. Sharing profit likely makes us a partnership, even with no paperwork (general knowledge, confirm with an accountant). Then the nominated partner registers the partnership, both register and file returns, by 5 Oct 2027.
- **EU VAT:** third-party sources say UK sellers of digital services to EU consumers owe VAT from the first sale, with no threshold, via Non-Union OSS in an EU country. Factor this in when choosing the idea. UK VAT registration only applies above £90,000.
- **Not checked:** how prize money is taxed.

## The game in one paragraph

An AI agent has until the freeze, **18 Nov 6pm**, to make real money from real strangers, with **up to £100 of your own money** (a cap, not a grant, and never reimbursed). Any model, any framework, laptop or server. **Winner = highest verified net profit**, after audit. Profit = sales minus spend. AI costs aren't counted as spend. Human interventions are logged publicly as "touches" beside profit. They never disqualify you and only matter for the Iron Mode prize.

**The one test for every pound (p.10):** did someone you don't know pay for something they actually wanted, and did they get it? If not, it's not revenue.

## Where the competition stands (6 Nov, 15:20)

From leaderboard.shipyard.london: **Day 5, 169 teams live, £40.17 verified in total, 24 touches, freeze in 12d 02h.**

| Rank | Team | Net profit | Touches | Sales seen |
|---|---|---|---|---|
| 1 | Uplide | +£10.28 | 0 | Four sales of £2.22 to £3.33, one labelled "Subscription creation" |
| 2 | Yaman Sivrikaya | +£2.88 | 8 | £29.89, Steam page redesign for a game studio, bank transfer |
| 5 | jen-ai | ~£0.00 | 3 | £1.00 sale, then refunded |

- **Only three teams have made a sale**, and one was refunded. The worst shown so far is -£23.93 (slothr).
- Yaman's numbers imply about £27 deducted from the £29.89.
- The page also lists Tezos Foundation as a sponsor, which nothing else mentions.
- **First Sale (£500) has very likely gone to Yaman,** pending audit. Note that the bot posts "First revenue" for each team's first sale, so that message alone doesn't mean overall first. Uplide would be next in line if Yaman's were struck.
- **Uplide leads Iron Mode:** profit with 0 touches.
- Office turnout on 5 Nov was low, and Soho may go remote on quiet days.

## Organiser rulings from Discord

All from `efe_shipyard` in #support unless noted. These override the guide.

**Money**
- **The £100 isn't sent out.** "It's a cap, not a budget we provide: you use your own money, up to £100 max, and it isn't reimbursed." You can run on £0. (2 Nov)
- **AI credits, tokens, compute and subscriptions don't count:** "that's what your agent runs on, not what the business spends." Applies to going over partner credits too.
- Business spend before 2 Nov (domain, stock, ads, paid assets) still comes out of the £100, so `/spend` it on day one.
- **Multiple businesses are fine:** one team, one £100 total, one profit number. Stripe sales go through the one connected account. Touches and spend are logged across all of them.

**Timing**
- Building before 2 Nov is fine; keep git history. Sales count from 2 Nov.
- Waitlists and free previews before 2 Nov are fine. Later sales to those signups count if they pay from 2 Nov.
- No compulsory sessions. "The only thing that matters is your agent earning before the freeze."

**Strangers**
- Followers count as strangers if you don't actually know them.
- **Test: would you have DM'd them personally to ask them to buy?** If yes, it doesn't count. Friends, mutuals you chat with and colleagues don't count.

**Touches**
- **Test: did a human do something the agent could have done?**
- Prompts, approvals, code changes: yes. **One sitting = one touch**, with one line on what you did. You don't need to log every prompt.
- Human website edits: yes. Human posting from 2 Nov: yes.
- Agent making the change itself: no touch.
- Checking logs or watching it run: no. Restarting without changes: no. Patching code during a restart: yes.
- "Main prizes go on profit, touches only matter for the lowest touch prize."

**What this means for us:** a working session where a human directs a coding assistant on the agent is one sitting, so one `/touch`. If in doubt, log it.

**Trading and crypto**
- Trading is out, crypto and stocks, even if agent-run. Also betting, prediction markets, staking, arbitrage.
- Selling buy/sell calls, signals or "what to buy" newsletters is out, as investment advice.
- **Selling data or tools is fine,** e.g. a social sentiment dashboard or mention tracking for crypto projects. "Data, not advice."
- Services count; it doesn't need to be a product.

**Ownership and privacy**
- The business and IP stay yours, and they'd like you to keep running it.
- Restricted Stripe keys are used only to count sales and refunds; revoke any time. **A new Stripe account just for this is the simplest option.** A participant (not an organiser) says Stripe's website field can be left empty.
- Audit evidence is private, never published. You can redact confidential content, and they can audit over screen share. They verify who did the work (agent vs human), when, and that the sale was real.

**In-person selling**
- Approved by `sofia_shipyard` in #support: an agent finds businesses, builds preview sites and tracks deals, while a human sells in person and takes payment by Stripe link. "Yes, that's fine!"
- **Google Maps (organiser in #support, 7 Nov):** using Maps data to build previews breaks Google's terms, so it's a no. Using Maps only to find which shops have no website is fine, with each shop's details taken from the shop itself or open data. They also suggested OpenStreetMap, credited on the site.
- **Each in-person showing is a touch** (same reply): a human showing the preview to an owner is one touch, so log every visit. If the agent sends the preview itself, there's no touch.

**Freelance development (Shipyard Admin in Discord, 8 Nov)**
- **A new client's project counts** if it starts after 2 Nov and is paid before the freeze, even when built with AI agents and logged touches. Payment has to be proven to get on the leaderboard.
- **Reaching out to find clients yourself is allowed,** and it counts as a touch.
- **Past clients don't count:** "the rules only count sales to new customers."
- **Wallet declared (9 Nov, 20:15):** Boran told `efe_shipyard` and Shipyard Admin in the team channel that payments go to `FRgRdaRFEiPDe63WdfzJpZWHG1MYJqSZ8SD6i45jGpAG`, which is the bot's `SOLANA_WALLET_ADDRESS` (checked 10 Nov). **Shipyard Admin:** after a payment comes through, send an invoice in that channel; they confirm the payment before adding it to the leaderboard. Keep the invoice and everything else for the records.
- **Referrals count (`efe_shipyard`, 9 Nov):** an existing client introducing a new client, with no cut, is a stranger sale, as long as the new client is new to us and pays us directly. Log the human parts as touches: the intro ask, calls, sales chats and build sessions. If paid in USDC, declare the wallet before the first payment. Keep the intro message for the audit.
- **The website client counts (`efe_shipyard`, 12 Nov, 14:38):** a £350 small-business website. The client was found when Boran's brother saw them ask for a website in a group chat; Boran didn't know them, phoned them on 11 Nov, and they paid him directly. £150 was paid by bank transfer on 11 Nov, and bank transfer was declared late, on 12 Nov at 13:51. The ruling:
  - The lead is fine, and so is the late declaration, "since you flagged it straight away".
  - The £150 counts as long as the website is delivered before the freeze. The remaining £200 counts when it's paid, also before the freeze.
  - Keep the bank statement, the client's written confirmation and the receipt for the audit; there's no need to send them now.
  - Don't post account details in the team channel. Boran's 14:01 attachment (a banking-app screenshot of the £150) was deleted on 12 Nov, as efe suggested.
- **The agent must do part of every sale (`efe_shipyard`, 12 Nov):** "the agent needs to do at least one part of the sale itself, so finding the customer, selling or delivering." Our agents building the work and reporting to the client covers this. Keep logging calls and messages with clients as touches.
- **Declared payment sources:** USDC to the wallet above (9 Nov), and bank transfer (12 Nov, late but accepted).

**Credits**
- Normal partner terms apply. You can exceed credits at your own cost.
- **Some trials auto-renew to paid with a card on file, so check billing settings.**

## Format (event page)

- Solo or a team of up to four. The page says 40–60 teams, but the leaderboard shows 169 live, so limited credits are likely gone sooner. Organisers rematch people whose teammates vanished.
- The page promises a "£100 stake", which is **wrong** (see rulings), and a "starter agent", which nothing else mentions. The only starter we've seen is Celestia's repo, under Resources.
- "There is no autonomy police." Intervene as much as you like, but it's public.
- The main prize is decided by the leaderboard, with no judging panel. Best Use of Memory and Crowd Favourite are subjective, and Best Use of Minds reads that way too.
- Shipyard funds the base pool and partner prizes stack on top ("£10,000+ and counting").
- The ticker and leaderboard rows on the page (AGENT_042 etc.) are **sample data, not results**.

## Key dates (UK time)

| When | What |
|---|---|
| 2 Nov | Kickoff and team formation. Touch logging starts, sales count, credits claimable |
| 2–4 Nov | Learn: online evening workshops |
| 5–18 Nov | Optional build days at **14 Soho Square, London W1D 3QG**, weekdays 12:00–20:00. Goes remote on days with fewer than 5 people; organisers poll daily in #office-days. [Desk form](https://form.typeform.com/to/oEiII58K) |
| **18 Nov, 6pm** | **Freeze. Leaderboard locks. Final manual reports due before this** |
| 19 Nov, 6pm | Evidence packs due |
| 21 Nov (Sat) | Demo Day at Encode Hub, London. Top teams on stage, 80–100 people including investors and press, winners announced and paid on stage, Crowd Favourite vote |
| 21 Nov | ElevenLabs link claim deadline |
| 22 Nov | Tavily credits expire |

## Prizes (p.2–3)

"£10,000+ in cash". The listed cash adds up to £11,500 (£9,000 podium + 5 × £500).

| | 1st | 2nd | 3rd |
|---|---|---|---|
| Cash | £5,000 | £2,500 | £1,500 |
| Stripe credits | $5,000 | $3,000 | $1,000 |
| Replit credits | £1,500 | £1,000 | £500 |
| Tavily credits | 10,000 | 5,000 | 3,000 |
| Treg credits | $500 | $250 | $100 |
| SurrealDB credits | $1,000 | $500 | $250 |

Winning teams also get: ElevenLabs Scale plan for 3 months per team member, Replit Startups Program fast track, £200 SurrealDB swag bundle.

**Special prizes: £500 each, open to every team, stackable with podium**

| Prize | Sponsor | Who wins | Status |
|---|---|---|---|
| Iron Mode | Celestia | Most profit with the fewest human touches | Uplide leading |
| First Sale | Replit | First real sale from a stranger | Very likely Yaman |
| Best Use of Minds | Animoca | Best agent built on Minds | Open |
| Best Use of Memory | SurrealDB | Picked by SurrealDB | Open |
| Crowd Favourite | — | Voted by everyone at Demo Day | Open |

**Best Use of Memory criteria (SurrealDB pack):** "the agent that earns with the fewest human touches because it remembers":
- Customers, deals and decisions that carry across the three weeks
- Facts that supersede rather than overwrite
- Retrieval you can trace back to its source

Using Agent Memory is "recommended, not required". So the agent has to earn, with few touches, and memory has to be the reason why. That overlaps with Iron Mode. Chiru drops into the mentor channel during the build.

Sales are dated to **when the customer paid**, not when money landed or was verified.

## Tracking and commands (p.3, p.19)

All commands run in your team channel. Team appears at `leaderboard.shipyard.london` under team name (or your own name if solo). Verified sales are announced in #money-feed; Stripe sales instantly, others after checking. The bot posts a ranking daily at 18:00 in #announcements.

| Command | Does |
|---|---|
| `/stripe connect` | Connect Stripe with read-only key (pop-up form) |
| `/stripe status` | Check connection |
| `/stripe disconnect` | Remove key |
| `/touch` | Declare a human intervention, one line on what you did |
| `/spend` | Log spend, exact GBP and what it was for |
| `/agent name` | Name your agent |

## Connecting Stripe (p.4–7)

1. dashboard.stripe.com/apikeys → Create a secret key
2. "Sharing with a third-party service". Vendor name: `Shipyard`, URL: `https://shipyard.london`
3. Custom permissions
4. Core = **Read**, leave the rest. Never Write
5. Name it e.g. "API key for Shipyard", confirm all Read, create
6. Copy the key (`rk_live_...`, shown once). Run `/stripe connect`, paste into the form only. Check with `/stripe status`

- Key and payment links must be in **live mode, same Stripe account**. Other accounts aren't seen.
- `rk_test_` and test sales don't count. Full `sk_...` keys are never accepted.
- GBP sales appear automatically. Other currencies wait for an organiser, so they're slower.

## Selling outside Stripe (p.7–8)

eBay, Vinted, Etsy, Gumroad, PayPal, bank transfer, affiliate and ad networks, and crypto all count, but are manual.

1. **Before the first sale**, tag @Organiser with the platform and how the agent gets paid. A source not declared first may not count.
2. **Every day you make a sale, before 6pm**, tag @Organiser with running total per source plus proof of new sales.
3. Organiser adds it, usually same evening, marked "manually verified". Can take up to 24h.

| Source | Proof |
|---|---|
| Marketplaces (eBay, Vinted, Depop, Etsy) | Orders export or order page screenshots (IDs, dates, amounts) + payouts/balance page |
| Storefronts (Gumroad, Whop, Lemon Squeezy, Shopify) | Sales CSV |
| PayPal, Wise, bank, invoices | Transaction export with payer names + invoice copies |
| Affiliate and ads | Dashboard export; only approved/earned commissions count, not pending |
| Crypto | Tx hashes, into a wallet address declared in step 1 |

- Report what was actually received after platform fees, and don't log those fees as spend too.
- Refunds, returns and reversed commissions come off the total.
- Final report must land before the freeze; later doesn't count.
- If audit finds a lower number, the audited number stands. **Inflating = team disqualified.**

## Touches and spend (p.8–9)

`/touch` from 2 Nov, nothing before. Count is public beside profit. See the rulings above for what counts. Hiding a touch can cost a prize; logging one never does.

`/spend` each time, exact GBP and purpose. The guide says ads, freelancers, APIs, stock and tools are deducted; the rulings carve out AI credits, tokens, compute and subscriptions.

## Audit (p.9)

Top 5 and every prize contender are audited. Keep from day one:
- Agent's full logs or conversation history
- Prompts and code with history (git repo is ideal)
- Receipts for everything spent
- Anything a human sent to a customer

Evidence packs due 19 Nov, 6pm.

## What counts (p.10)

- Digital products: templates, tools, apps, content, courses, datasets, print-on-demand
- Services: audits, research, lead lists, translations, design, support, done-for-you work
- Flipping physical items legitimately owned or sourced, **shipped and delivered before the freeze**
- Pre-orders and subscriptions, **only what's charged and delivered before the freeze**
- Rev share, affiliate, ad income, if paid out or verifiable in the dashboard before the freeze
- Crypto as a payment method; converted at freeze rate; **each payment from a distinct wallet shown to belong to a real customer**
- Building tools for crypto customers is a normal business

## Not allowed (p.10–11)

- Money from people you know: friends, family, teammates, other participants, employer, "anyone you'd have messaged anyway". **Existing clients count as friends**
- Fake sales: self-purchase, round-tripping, paying people to buy
- Speculation: trading, gambling, betting, prediction markets, crypto speculation, yield farming, staking rewards, airdrop farming, arbitrage of any financial asset
- Speculative tokens, memecoins, NFTs whose value depends on resale or price rising
- Money for nothing: donations, tips, crowdfunding with nothing in return
- Regulated or restricted: alcohol, tobacco, vapes, drugs, weapons, adult, financial/investment advice, medical/legal advice, lending
- Things you lack rights to: counterfeits, copied content, scraped personal data, other people's IP
- Breaking platform rules: spam, fake reviews, impersonation, bot traffic, astroturfing, any ToS breach. **Agent must disclose it's an AI wherever the platform requires it**

**Grey area:** ask in #support before building. Organiser approval stands. Anything unapproved that resembles the list above is struck at audit.

## Server rules (p.11–12)

Be respectful. Setup and tech in #support, mentor questions in #ask-mentors. Never post keys or .env anywhere, including the team channel; reset if leaked. No unsolicited DMs to other participants, no unrelated advertising. Organisers' decisions are final (warning, DQ or removal). Tag @Organiser in your team channel so they don't miss it.

## Partner credits (p.13–17)

> Codes are kept here for our own use. Don't put them in anything public. The audit git repo should stay private, and `sources/discord/credit-support.md` also holds the Daytona code and other people's emails, so keep `sources/` out of anything shared.

**Per builder**

| Partner | What | Value | How to claim | Catch |
|---|---|---|---|---|
| Tavily | Web search API | 8,000 credits | `app.tavily.com/redeem/[code removed]`; don't pick a plan | 2–22 Nov only |
| Daytona | Code sandboxes | $100 | app.daytona.io → Billing → Wallet → Redeem; code in `sources/discord/credit-support.md` | Shared by 100 people; one report on 5 Nov that it added nothing |
| Elfa | Social and market data API | 15,000 credits (~$217.50) | elfa-ai.typeform.com/shipyard, then dev.elfa.ai/dashboard, under Bonus | **First 75 builders only** |
| SurrealDB | Agent Memory | $50 | sdb.li/4hNUC1i → Billing → code `[code removed]` | A participant says payment details are required first; check auto-renew. Skill at sdb.li/skills; SDKs `@surrealdb/memory`, `surrealdb[memory]` |
| ElevenLabs | Voice AI | 1 month Creator ($22) | Tag @Organiser in team channel for the link | Single-use, claim by 21 Nov |
| Replit | Build and host apps | Pro plan 2–21 Nov ($100) | replit.com/~?redeemCoupon=[code removed] | Must use registered email; several people report "not eligible" |
| Treg | Agent tooling: SEO, enrichment, ads, social, scraping data | $20 | Sign in at treg.to with registered email; if missing, ask `tomosman` in #credit-support | Pays for tool calls, not LLM. One team got "403: org suspended" |

**Per team**

| Partner | What | Value | How to claim | Catch |
|---|---|---|---|---|
| Minds (Animoca) | Autonomous agents with own Base wallets; on-chain payments on Mainnet, Base, Polygon | $50 (see conflicts) | Create Minds at hellominds.ai; codes are sent in team channels | Pay per use for each action |
| Talp | Simulated audience research | One study ($150) | hackathon.talp.ai/shipyard-form | Needs a sharp question tied to a real decision; non-transferable |
| Celestia | Inference paid onchain | 50 TIA | forms.gle/pMYBtVPUjxeLM2i56; needs `celestia1...` and Eden `0x...` addresses, team name, Discord handle, what you're building | First 50 teams, active teams. TIA isn't revenue; selling it counts as speculation |

**Partner people in the server:** Tavily `tavily_rick`, Daytona `dgraviet`, Elfa `decircusmaster` and `nero.sensei`, Replit `raoufchebri`, Minds `mo_ezz14`, Talp `baranatass`, Treg `tomosman`, SurrealDB `chiru.b`, Celestia `joshcs`, Parallel `Rowan (Parallel)`, Thomas `Thomas`.

## Resources

- **Decks:** in #workshop-schedule, under each day's talks. Videos were still uploading on 2 Nov
- **Kickoff recording:** [Google Drive](https://drive.google.com/file/d/1yjH2-xdDKD9pjQCZ8XbnYC026str1cr5/view?usp=drivesdk)
- **Celestia starter repo:** github.com/jcstein/shipyard-agent-starter. Loop: Stripe sale → agent pays Houston from its Eden wallet → receipts on Celestia (Mocha for practice)
- **SurrealDB pack:** [participant resources](https://surrealdb.notion.site/MAKE-ME-MONEY-SurrealDB-participant-resources-pack-405bfa44ae3e8173a4f0e58ed92fe725), saved in `sources/surrealdb-pack.md`. Docs at surrealdb.com/docs/agent-memory. Drop-in packages for Mastra, LangChain, LangGraph, CrewAI, OpenAI Agents SDK, Pydantic AI, Vercel AI SDK and n8n
- **Parallel (not a credit partner):** web search API, $1 per 1k requests, 80k requests when signing up with a work email, free MCP. FindAll API builds lists; Task API goes deeper or enriches; Monitor API tracks things hourly in plain English but burns credits faster
- **Thomas (YC AI founder, madebythomas.ai):** "Happy to fund some experiments later in the hackathon for the ones who are making good progress." Open to DMs

## Sessions and mentors (all past now)

| When | Speaker | Org | Session |
|---|---|---|---|
| Mon 2 Nov 19:00 | Mohamed Ezeldin | Animoca Brands | Building Minds: Agents That Live, Learn and Earn |
| Mon 2 Nov 19:45 | Ricky Johnson | Tavily | Introduction to Tavily |
| Mon 2 Nov 20:15 | Raouf Chebri | Replit | Grow Your Business with Replit |
| Tue 3 Nov 18:00 | Josh Stein | Celestia Labs | Build an Agent That Pays Its Own Bills Onchain |
| Tue 3 Nov 18:30 | Thomas Cloarec | Thomas AI agent (YC P26) | Building Thomas: The First YC-Backed AI Founder |
| Tue 3 Nov 19:00 | Tom Osman | Treg | Give Your Agent Everything It Needs to Earn |
| Tue 3 Nov 19:40 | Alberto Minghetti | a16z Speedrun, stealth founder | What 0 to 1 Looks Like |
| Tue 3 Nov 20:10 | Rowan Aldean | Parallel | How Money Flows & Finds Value |
| Wed 4 Nov 18:00 | Anni Chen | Twilio | Zero UI: Conversations That Convert |
| Wed 4 Nov 18:30 | Danny Graviet | Daytona | Give Your Agent a Computer & Ship |
| Wed 4 Nov 19:00 | Baran Ataş | Talp | How to Price Something Nobody Has Priced Before |
| Wed 4 Nov 19:40 | Fredrik Häggbom | Google AI Innovation Lab | From Idea to First Customer |
| Wed 4 Nov 20:10 | Chiru Boggavarapu | SurrealDB | Memory That Makes Money: Agents That Know What Changed & Why |

## Idea signals seen so far (raw, not evaluated)

- **Actual sale:** Steam page redesign for a game studio, £29.89 by bank transfer
- **Rowan's examples:** hosted AI-generated restaurant menus, £500/month, fully automated. Pool cleaning leads from satellite imagery and flyers, $2k/month
- **Organiser example:** social sentiment dashboard or mention tracking for crypto projects
- **Other teams:** flipping goods on eBay and Vinted (tayfun)
- **Event page samples:** Notion CRM template at £19, hiring a photographer on Fiverr
- **Rowan's advice:** "If you aren't paid, you aren't providing value." "If you spend more on tokens than you make, you don't have a business." Note that token spend doesn't count on the leaderboard, but it's still real money.

## Conflicts still unresolved

| Topic | Says | But | Note |
|---|---|---|---|
| Minds credits | $50 per team (guide p.13, #credit-support pin) | $25 per team (guide p.16) | $50 fits the "$200 per team" total |
| Spend | Guide: APIs and tools are deducted | Ruling: AI credits, tokens, compute and subscriptions aren't | Non-AI APIs and SaaS are unclear |
| Soho dates | Guide: to 13 Nov | Discord: to 18 Nov | Go with Discord |
| Celestia eligibility | Guide: first 50 teams | Josh: "active teams" | Probably both |
| First-sale prize name | "First Sale" (p.2) | "First Blood" (p.8) | Probably the same prize |
| Podium header | "3rd · Talp" (p.2) | No other mention | Unexplained |
| Best Use of Memory prize | Guide: £500 cash | SurrealDB pack: $1,000 Agent Memory credit + £200 swag | Unclear if these stack or if there's no cash. The guide lists the same credit and swag amounts for podium winners |

## Open questions

Answered ones have been folded into the rulings above.

1. **Can revenue be reinvested past £100,** or is total spend capped at £100 regardless?
2. **Do non-AI tools and APIs count as spend?** E.g. Twilio messaging, email sending, scraping APIs, Shopify. The ruling names AI credits, tokens, compute and subscriptions only.
3. **How is Iron Mode scored?** How do "most profit" and "fewest touches" combine?
4. **Must winners attend Demo Day in person?**
5. **What exactly goes in an evidence pack,** and in what format?
6. **Can an existing product or business be entered** if all customers are new strangers?
7. **What is the "starter agent"?** Is it just marketing, or something in the kickoff recording?
8. **What do the event page FAQ answers say?**
9. **Does Twilio offer credits?** Parallel's offer is general, not hackathon-specific.
10. **Are Elfa, Daytona and Celestia allocations still available?**
11. **How would Thomas's funding be treated?** Would it fit under the £100 cap, and would any of it count as revenue? Ask before accepting.
12. **Does Best Use of Memory pay £500 cash, the credit and swag, or both?**
