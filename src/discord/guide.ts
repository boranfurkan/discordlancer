// #owner-guide: a private channel, for Boran only, explaining every command and how a
// project runs. Built from the bot's own command list and refreshed each time the bot
// starts, so it can't go stale; a test fails if a command has no entry here.

import type { Guild } from 'discord.js';
import { log } from '../log.js';
import { ensureGuideChannel } from './channels.js';
import type { Command } from './command.js';

type Listed = Pick<Command, 'name' | 'access' | 'where' | 'definition'>;

/** What each command does, when it works, and anything worth knowing. Keyed by name. */
export const GUIDE_DETAILS: Record<string, string> = {
  help: 'Lists the commands the person can use right there, at that stage. Works anywhere; only they see the reply.',
  project: "A card with the project's stage, the next step, the client team, the repo and who has GitHub access.",
  'new-project':
    'Makes the private channel, a private GitHub repo and a single-use invite (7 days) for the first client, which only you see: send it to them yourself. Run it again for a project still waiting for its client to get a fresh invite (the old one stops working).',
  invite:
    "An invite for one more person on the client's team (CTO, marketing, ...): one use, 7 days, one per person. They get the channel, the voice channel, the threads and the Client role, and can do everything the client can.",
  'link-client':
    "The fallback when join tracking missed someone (the bot was restarting, or two invites were used at once; #owner-desk tells you). Before the client has joined it makes them the client; after, it adds them to the client's team.",
  'add-github': "Adds a GitHub account to the project's repo with read-only access: they can see and clone the code, never push.",
  'create-specs':
    'Gemini reads the whole conversation (images, files and recorded calls too) and writes the next spec version, with what changed and open questions. Posted and pinned, marked as AI-drafted. A new version resets agreement.',
  'agree-specs': "Agrees the current spec version. You and the client side each agree once (anyone on the client's team agrees for all of them); with both, the stage moves to Specs agreed.",
  quote:
    "Posts a quote in USDC for the agreed spec, with a delivery deadline (London time). Posting it counts as your acceptance. A deadline after the hackathon freeze gets a private warning.",
  'accept-quote': 'The client side accepts the current quote; the stage moves to Quote accepted.',
  'set-payment-wallet': 'The client declares the Solana wallet they will pay from. Payments from other wallets are reported once and not counted.',
  wallet: 'Shows your receiving wallet address.',
  pay: 'A Solana Pay QR code and link for the accepted quote, with a unique reference. The bot watches the chain and confirms the payment by itself.',
  paid: 'For a payment sent without the QR code: the client gives the transaction signature and the bot checks it on chain (final, USDC, right wallets, enough, not used before).',
  receipt: 'The receipt for a paid project: amount, transaction and explorer link.',
  'start-development': 'Marks that building has started (stage Being built). Do it once the payment is confirmed.',
  'confirm-delivery':
    'You run it, with an optional note such as a URL, to mark the project delivered; the client side checks it against the spec and confirms with the button (or by running it). Once they confirm, the project is Delivered.',
  progress: "Gemini reads the code in the repo against the agreed spec and gives a progress estimate, marked as an estimate, not a measurement.",
  ask: "Anyone in the project asks a question; the AI answers in the channel from the chat, calls, progress updates, spec, quote, payments, change requests, memory and the code, marked as an AI answer. It never agrees to new prices, dates or scope; anything needing you is flagged in #owner-desk. The client side gets 15 a day per project; you have no limit.",
  call: "`start` joins the project's voice channel and asks each person to press Record me; nobody is recorded until they do. `stop` ends it (it also ends 2 minutes after everyone leaves, or after 2 hours). ElevenLabs transcribes, Gemini summarises, and the notes and transcript go in the 📞 Calls thread. `retry` re-runs a transcription that failed.",
  'sync-docs':
    'Writes the project docs (overview, requirements, decisions, open questions, call notes) into the repo from everything recorded, as one pull request on the discordlancer/project-docs branch. A second AI pass checks every statement, and every citation is checked against the real sources. About 3 to 6 minutes; the link comes back to you privately and in #owner-desk. Review and merge it.',
  'request-update':
    "After delivery, the client asks for a small change. Gemini triages it: unclear ones get questions, bigger ones are sent back for a new quote, small ones wait for your Approve button. Approving opens a GitHub issue for Tessl, whose pull request shows up in the 🔧 Code changes thread.",
  export: 'The evidence pack for the audit, sent to #owner-desk: summary, chat transcript, every event, specs and call transcripts.',
  report: "Drafts today's sales report for the organisers, with transaction hashes. Test projects are left out.",
  touches: "Drafts today's /touch line from your recorded actions. Test projects are left out.",
  cancel: "Cancels the project (needs confirm). The channel stays readable but the client side can no longer post. If it was still waiting for its client, the invite stops working.",
  archive: 'Archives a delivered or cancelled project (needs confirm). The channel stays readable.',
};

function usage(command: Listed): string {
  const options = (command.definition.options ?? []) as Array<{ name: string; type: number; required?: boolean }>;
  const subcommands = options.filter((option) => option.type === 1).map((option) => option.name);
  if (subcommands.length) return `/${command.name} ${subcommands.join(' | ')}`;
  const args = options.map((option) => (option.required ? option.name : `[${option.name}]`));
  return [`/${command.name}`, ...args].join(' ');
}

function entry(command: Listed): string {
  const where = command.where === 'anywhere' ? ' *(anywhere)*' : '';
  return `**\`${usage(command)}\`**${where}: ${GUIDE_DETAILS[command.name] ?? '(no guide entry yet)'}`;
}

const FLOW = [
  '**How a project runs**',
  "1. `/new-project name` anywhere. Send the invite it gives you to the client. For more people on their team, `/invite` in the project channel, one each.",
  '2. They join: the channel opens to them with a welcome. Talk about what they need (screenshots welcome). Record calls with `/call start`.',
  '3. `/create-specs` writes the spec; both sides `/agree-specs`.',
  '4. `/quote amount deadline`; the client side `/accept-quote`.',
  '5. The client side `/set-payment-wallet`, then `/pay`. The bot confirms the payment on chain by itself.',
  '6. `/start-development`. On your laptop, `npm run claude:connect -- <project>` and build with Claude Code; it posts progress updates in the 📈 thread. `/sync-docs` keeps the docs in the repo current.',
  '7. `/confirm-delivery` when it is done; the client side confirms.',
  '8. Support: the client side uses `/request-update`; you approve small changes for Tessl.',
  'Any time: `/ask`, `/project`, `/progress`, and tagging the bot (below).',
].join('\n');

const WITHOUT_COMMANDS = [
  '**Without slash commands**',
  "- **Answer a client's message:** reply to it and tag the bot; any words after the tag are a note for the answer (\"say SMS is extra\"). Or right-click the message, **Apps**, **Answer with AI** (only you see it). The answer is marked as AI. These count as touches.",
  '- **Buttons:** Approve or Decline on change requests (you only), Confirm delivery (client side), Record me / Don\'t record me on calls (each person for themselves).',
  "- **Threads in each project channel:** 📞 Calls (consent, notes, transcripts), 🔧 Code changes (Tessl's pull requests), 📈 Progress updates (Claude Code). Everyone on the project is added, so they are notified. The main channel stays a conversation.",
  '- **#owner-desk:** joins the bot couldn\'t match, questions that need you, pull requests to review, evidence packs, and anything that went wrong.',
].join('\n');

const LAPTOP = [
  '**On your laptop**',
  "- `npm run claude:connect -- <project>` in the discordlancer folder: clones the client's repo to ~/Desktop/<project>, connects Claude Code to the bot for that folder, and adds the CLAUDE.md section and `/update-client`. Run it again to replace the key.",
  "- In Claude Code there: it reads the project brief at the start, posts an update when something meaningful is done (you approve each one), and `/update-client` posts one on request. Don't set post_update to always-allow.",
  '- **Updating the bot:** push, then in Replit run `git pull --no-rebase --no-edit origin main` and Republish. Never run a second copy of the bot.',
  '- **Touches:** a build session, a call or sales chat with a client, and your owner actions here each count. `/touches` drafts the day\'s line.',
].join('\n');

/** Pure: the guide as Discord messages, each under the 2,000-character limit. */
export function ownerGuide(commands: readonly Listed[], limit = 1_900): string[] {
  const owner = commands.filter((command) => command.access === 'owner').map(entry);
  const everyone = commands.filter((command) => command.access === 'everyone').map(entry);
  const sections = [
    `# 📖 Discordlancer guide\nOnly you and the bot can see this channel. It is rebuilt from the bot's own commands every time the bot starts.\n\n${FLOW}`,
    ['**Your commands** (only you can run these)', ...owner].join('\n'),
    ['**Commands for everyone in a project** (you and the whole client team)', ...everyone].join('\n'),
    WITHOUT_COMMANDS,
    LAPTOP,
  ];
  const messages: string[] = [];
  for (const section of sections) {
    let current = '';
    for (const line of section.split('\n')) {
      const next = current ? `${current}\n${line}` : line;
      if (next.length > limit && current) {
        messages.push(current);
        current = line;
      } else current = next;
    }
    if (current) messages.push(current);
  }
  return messages;
}

/** Makes #owner-guide match the current commands: edits its messages in place, adds or removes the difference. */
export async function syncOwnerGuide(guild: Guild, ownerId: string, commands: readonly Listed[]): Promise<void> {
  try {
    const channel = await ensureGuideChannel(guild, ownerId);
    const wanted = ownerGuide(commands);
    const botId = guild.members.me?.id;
    const existing = [...(await channel.messages.fetch({ limit: 50 })).values()].filter((message) => message.author.id === botId).reverse();
    if (existing.length === wanted.length && existing.every((message, index) => message.content === wanted[index])) {
      log.info('owner guide unchanged');
      return;
    }
    for (const [index, content] of wanted.entries()) {
      const message = existing[index];
      if (message) {
        if (message.content !== content) await message.edit({ content, allowedMentions: { parse: [] } });
      } else {
        await channel.send({ content, allowedMentions: { parse: [] } });
      }
    }
    for (const extra of existing.slice(wanted.length)) await extra.delete().catch(() => undefined);
    log.info('owner guide updated', { messages: wanted.length });
  } catch (error) {
    log.warn('could not update the owner guide', { error });
  }
}
