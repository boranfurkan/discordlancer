// The two guides, posted as embeds and rebuilt from the bot's own command list each
// time it starts (messages are edited in place, never reposted):
// - #owner-guide, private to Boran: every command, how a project runs, the laptop side;
// - #how-it-works, read-only for everyone: what a client can do and how a project works.
// A test fails if a command has no guide entry, so a new command can't go undocumented.

import type { APIEmbed, Guild, Message, TextChannel } from 'discord.js';
import { log } from '../log.js';
import { ensureClientGuideChannel, ensureGuideChannel } from './channels.js';
import type { Command } from './command.js';
import { OWNER_NAME } from './guards.js';

type Listed = Pick<Command, 'name' | 'access' | 'where' | 'definition'>;

type Phase = 'anytime' | 'start' | 'deal' | 'payment' | 'build' | 'delivery' | 'records';

const PHASES: Record<Phase, { title: string; color: number }> = {
  anytime: { title: '💬 Any time', color: 0x5865f2 },
  start: { title: '🚀 Starting a project', color: 0x5865f2 },
  deal: { title: '📝 Specs and quote', color: 0xfee75c },
  payment: { title: '💸 Payment', color: 0x57f287 },
  build: { title: '🔨 Building', color: 0xeb459e },
  delivery: { title: '✅ Delivery and changes', color: 0x3ba55d },
  records: { title: '🗂️ Records and closing', color: 0x99aab5 },
};

interface GuideEntry {
  phase: Phase;
  /** For Boran. */
  owner: string;
  /** For clients; only commands they can run have one. */
  client?: string;
}

/** Every command, keyed by name. */
export const GUIDE: Record<string, GuideEntry> = {
  help: {
    phase: 'anytime',
    owner: 'Lists the commands the person can use right there, at that stage. Only they see the reply.',
    client: 'Shows what you can do in your channel right now, at this stage of the project. Only you see the answer.',
  },
  project: {
    phase: 'anytime',
    owner: "A card with the project's stage, the next step, the client team, the repo and who has GitHub access.",
    client: 'A card with where your project stands, what happens next, who is on it, and its code repository.',
  },
  ask: {
    phase: 'anytime',
    owner:
      'The AI answers in the channel from the chat, calls, progress updates, spec, quote, payments, change requests, memory and the code, marked as an AI answer. It never agrees to new prices, dates or scope; anything needing you is flagged in #owner-desk. Clients get 15 a day per project; you have no limit.',
    client: `Ask anything about your project: what was agreed, how it is going, what comes next. The AI assistant answers in your channel from your conversation, calls, the spec and the code, and marks the answer as AI. It never agrees to new prices, dates or features: anything like that goes to ${OWNER_NAME}. Up to 15 questions a day.`,
  },
  'add-github': {
    phase: 'anytime',
    owner: "Adds a GitHub account to the project's repo with read-only access: they can see and clone the code, never push.",
    client: "Gives a GitHub account read-only access to your project's code, so you can see and download it at any time.",
  },
  'new-project': {
    phase: 'start',
    owner:
      "Makes the private channel, a private GitHub repo, and a single-use invite (7 days) for the first client that only you see: send it yourself. Run it again while the client hasn't joined for a fresh invite; the old one stops working.",
  },
  invite: {
    phase: 'start',
    owner:
      "An invite for one more person on the client's team (CTO, marketing, ...): one use, 7 days, one per person. They get the channel, the voice channel, the threads and the Client role, and can do everything the client can.",
  },
  'link-client': {
    phase: 'start',
    owner:
      "The fallback when join tracking missed someone (#owner-desk tells you). Before the client has joined it makes them the client; after, it adds them to the client's team.",
  },
  'create-specs': {
    phase: 'deal',
    owner:
      'Gemini reads the whole conversation (images, files and recorded calls too) and writes the next spec version, with what changed and open questions. Posted and pinned, marked as AI-drafted. A new version needs agreeing again.',
  },
  'agree-specs': {
    phase: 'deal',
    owner:
      "Agrees the current spec version. You and the client side each agree once (anyone on the client's team agrees for all of them); with both, the stage moves to Specs agreed.",
    client: 'Agrees to the current written spec. Read it first: it is exactly what will be built. Anyone on your team can agree for all of you, and a new version needs agreeing again.',
  },
  quote: {
    phase: 'deal',
    owner:
      'Posts a fixed price in USDC for the agreed spec, with a delivery deadline (London time). Posting it counts as your acceptance. A deadline after the hackathon freeze gets a private warning.',
  },
  'accept-quote': {
    phase: 'deal',
    owner: 'The client side accepts the current quote; the stage moves to Quote accepted.',
    client: `Accepts ${OWNER_NAME}'s quote: the fixed price in USDC and the delivery date, for the agreed spec.`,
  },
  'set-payment-wallet': {
    phase: 'payment',
    owner: 'The client declares the Solana wallet they will pay from. Payments from other wallets are reported once and not counted.',
    client: 'Tells the bot which Solana wallet you will pay from, so it can recognise your payment. Do this before you pay.',
  },
  pay: {
    phase: 'payment',
    owner: 'A Solana Pay QR code and link for the accepted quote, with a unique reference. The bot watches the chain and confirms the payment by itself.',
    client:
      'Shows a QR code and link for the accepted quote. Scan it with a Solana wallet such as Phantom or Solflare and approve the USDC payment (you also need a little SOL for the network fee). The bot sees it on the blockchain within a minute and confirms it in your channel.',
  },
  paid: {
    phase: 'payment',
    owner:
      'For a payment sent without the QR code: the client gives the transaction signature and the bot checks it on chain (final, USDC, right wallets, enough, not used before).',
    client: 'Paid without the QR code? Give the transaction signature and the bot checks it on the blockchain.',
  },
  wallet: {
    phase: 'payment',
    owner: 'Shows your receiving wallet address.',
    client: `Shows the wallet address that receives payments for ${OWNER_NAME}.`,
  },
  receipt: {
    phase: 'payment',
    owner: 'The receipt for a paid project: amount, transaction and explorer link.',
    client: 'Your receipt: the amount and the transaction, with a link to see it on the blockchain.',
  },
  'start-development': {
    phase: 'build',
    owner: 'Marks that building has started (stage Being built). Do it once the payment is confirmed.',
  },
  call: {
    phase: 'build',
    owner:
      "`start` joins the project's voice channel and asks each person to press **Record me**; nobody is recorded until they do. `stop` ends it (it also ends 2 minutes after everyone leaves, or after 2 hours). ElevenLabs transcribes, Gemini summarises, and the notes and transcript go in the 📞 Calls thread. `retry` re-runs a transcription that failed.",
  },
  progress: {
    phase: 'build',
    owner: 'Gemini reads the code in the repo against the agreed spec and gives a progress estimate, marked as an estimate, not a measurement.',
    client: 'An AI estimate of how far the build has got against the agreed spec, read from the code itself. It is an estimate, not a measurement.',
  },
  'sync-docs': {
    phase: 'build',
    owner:
      'Writes the project docs (overview, requirements, decisions, open questions, call notes) into the repo from everything recorded, as one pull request. A second AI pass checks every statement, and every citation is checked against the real sources. About 3 to 6 minutes; the link comes back to you and to #owner-desk. Review and merge it.',
  },
  'confirm-delivery': {
    phase: 'delivery',
    owner:
      'You run it, with an optional note such as a URL, to mark the project delivered; the client side checks it against the spec and confirms with the button (or by running it). Once they confirm, the project is Delivered.',
    client: `When ${OWNER_NAME} marks the project delivered, check it against the spec, then confirm with the button (or this command). If something is missing, say so in the channel instead.`,
  },
  'request-update': {
    phase: 'delivery',
    owner:
      'After delivery, the client asks for a small change. Gemini triages it: unclear ones get questions, bigger ones are sent back for a new quote, small ones wait for your **Approve** button. Approving opens a GitHub issue for Tessl, whose pull request shows up in the 🔧 Code changes thread.',
    client: `After delivery, ask for a small change. Small, clear changes go to ${OWNER_NAME} to approve and are then made; bigger ones get a new quote; unclear ones get questions back.`,
  },
  export: {
    phase: 'records',
    owner: 'The evidence pack for the audit, sent to #owner-desk: summary, chat transcript, every event, specs and call transcripts.',
  },
  report: {
    phase: 'records',
    owner: "Drafts today's sales report for the organisers, with transaction hashes. Test projects are left out.",
  },
  touches: {
    phase: 'records',
    owner: "Drafts today's /touch line from your recorded actions. Test projects are left out.",
  },
  cancel: {
    phase: 'records',
    owner: 'Cancels the project (needs confirm). The channel stays readable but the client side can no longer post. If it was still waiting for its client, the invite stops working.',
  },
  archive: {
    phase: 'records',
    owner: 'Archives a delivered or cancelled project (needs confirm). The channel stays readable.',
  },
};

function usage(command: Listed): string {
  const options = (command.definition.options ?? []) as Array<{ name: string; type: number; required?: boolean }>;
  const subcommands = options.filter((option) => option.type === 1).map((option) => option.name);
  if (subcommands.length) return `/${command.name} ${subcommands.join(' | ')}`;
  return [`/${command.name}`, ...options.map((option) => (option.required ? option.name : `[${option.name}]`))].join(' ');
}

const field = (name: string, value: string) => ({ name, value, inline: false });
const steps = (lines: readonly string[]) => lines.map((line, index) => `**${index + 1}.** ${line}`).join('\n');

/** Pure: the owner guide, one embed per message. */
export function ownerGuide(commands: readonly Listed[]): APIEmbed[] {
  const intro: APIEmbed = {
    title: '📖 Discordlancer: your guide',
    color: 0x5865f2,
    description: [
      "Only you and the bot can see this channel. It is rebuilt from the bot's own commands each time it starts.",
      '',
      '**How a project runs**',
      steps([
        '`/new-project name` anywhere, then send the client the invite. For more of their team, `/invite` in the project channel, one each.',
        'They join and are welcomed. Talk it through; record calls with `/call start`.',
        '`/create-specs`, then both sides `/agree-specs`.',
        '`/quote amount deadline`; the client side `/accept-quote`.',
        'They `/set-payment-wallet` and `/pay`. The bot confirms the payment on chain.',
        '`/start-development`. Build with Claude Code (see *On your laptop*); keep the docs current with `/sync-docs`.',
        '`/confirm-delivery`; the client side confirms.',
        'Support: they `/request-update`; you approve small changes for Tessl.',
      ]),
    ].join('\n'),
    footer: { text: '🔒 = only you can run it. Everything else, you and the whole client team can.' },
  };
  const byPhase = (Object.keys(PHASES) as Phase[]).flatMap((phase): APIEmbed[] => {
    const listed = commands.filter((command) => GUIDE[command.name]?.phase === phase);
    if (listed.length === 0) return [];
    return [
      {
        title: PHASES[phase].title,
        color: PHASES[phase].color,
        fields: listed.map((command) =>
          field(`${command.access === 'owner' ? '🔒 ' : ''}${usage(command)}${command.where === 'anywhere' ? '  ·  anywhere' : ''}`, GUIDE[command.name]!.owner),
        ),
      },
    ];
  });
  const missing = commands.filter((command) => !GUIDE[command.name]);
  return [
    intro,
    ...byPhase,
    ...(missing.length ? [{ title: '❔ Not in the guide yet', color: 0xed4245, fields: missing.map((command) => field(usage(command), 'No guide entry yet.')) }] : []),
    {
      title: '🧵 Without slash commands',
      color: 0x99aab5,
      fields: [
        field(
          "Answer a client's message",
          'Reply to it and tag the bot; words after the tag are a note for the answer ("say SMS is extra"). Or right-click it, **Apps**, **Answer with AI** (only you see it). Marked as AI. These count as touches.',
        ),
        field('Buttons', "**Approve** / **Decline** on change requests (you only), **Confirm delivery** (client side), **Record me** / **Don't record me** on calls (each person for themselves)."),
        field(
          'Threads in each project channel',
          "📞 Calls (consent, notes, transcripts), 🔧 Code changes (Tessl's pull requests), 📈 Progress updates (Claude Code). Everyone on the project is added, so they are notified. The main channel stays a conversation.",
        ),
        field('#owner-desk', "Joins the bot couldn't match, questions that need you, pull requests to review, evidence packs, and anything that went wrong."),
      ],
    },
    {
      title: '💻 On your laptop',
      color: 0x2b2d31,
      fields: [
        field(
          'Connect Claude Code to a project',
          '`npm run claude:connect -- <project>` in the discordlancer folder clones the repo to ~/Desktop/<project>, connects Claude Code for that folder only, and adds the CLAUDE.md section and `/update-client`. Run it again to replace the key.',
        ),
        field(
          'In Claude Code',
          "It reads the project brief and docs at the start, and posts an update to the 📈 thread when something meaningful is done (you approve each one). `/update-client` posts one on request. Don't set post_update to always-allow.",
        ),
        field('Updating the bot', 'Push, then in Replit: `git pull --no-rebase --no-edit origin main`, and **Republish**. Never run a second copy of the bot.'),
        field('Touches', "A build session, a call or sales chat with a client, and your owner actions each count. `/touches` drafts the day's line."),
      ],
    },
  ];
}

/** Pure: the client guide, one embed per message. Nothing project-specific: every client reads it. */
export function clientGuide(commands: readonly Listed[]): APIEmbed[] {
  const usable = commands.filter((command) => command.access === 'everyone' && GUIDE[command.name]?.client);
  const phaseEmbed = (phase: Phase, title: string, intro?: string): APIEmbed[] => {
    const listed = usable.filter((command) => GUIDE[command.name]!.phase === phase);
    if (listed.length === 0) return [];
    return [
      {
        title,
        color: PHASES[phase].color,
        ...(intro ? { description: intro } : {}),
        fields: listed.map((command) => field(usage(command), GUIDE[command.name]!.client!)),
      },
    ];
  };
  return [
    {
      title: '👋 How your project works',
      color: 0x5865f2,
      description: [
        `${OWNER_NAME} builds software for clients, and every project happens in a **private channel** that only you, your team, ${OWNER_NAME} and the Discordlancer bot can see. This channel explains each step and every command you can use there.`,
        '',
        steps([
          '**Talk it through.** Tell us what you need: screenshots, links and files all help. Calls are welcome too.',
          `**Specs.** ${OWNER_NAME} turns the conversation into a written spec. Read it, then \`/agree-specs\`.`,
          `**Quote.** ${OWNER_NAME} posts a fixed price in USDC and a delivery date. \`/accept-quote\` when you are happy.`,
          '**Pay.** `/set-payment-wallet`, then `/pay`. The bot confirms the payment on the blockchain by itself.',
          `**Build.** ${OWNER_NAME} builds it. Progress updates appear in the 📈 thread, and \`/progress\` gives an estimate at any time.`,
          '**Delivery.** Check the delivered project against the spec and confirm it.',
          '**Changes.** Small changes later: `/request-update`.',
        ]),
        '',
        'Type `/help` in your channel at any time to see what you can do right then.',
      ].join('\n'),
    },
    ...phaseEmbed('anytime', '💬 Any time'),
    ...phaseEmbed('deal', '📝 Specs and quote', `${OWNER_NAME} writes the spec and posts the quote; you agree to each.`),
    ...phaseEmbed('payment', '💸 Paying', 'Payment is in USDC on Solana, in full before work starts, as the quote says.'),
    ...phaseEmbed('build', '🔨 While it is built'),
    ...phaseEmbed('delivery', '✅ Delivery and changes'),
    {
      title: '📞 Calls',
      color: 0xeb459e,
      fields: [
        field('Joining', `${OWNER_NAME} starts a call and the bot posts a link to your project's voice channel. Anyone on your team can join.`),
        field('Recording', "The bot only records people who press **Record me**, and nobody else at all. Press **Don't record me** at any time and everything recorded from you is dropped."),
        field(
          'What is kept',
          'ElevenLabs turns the recording into a transcript, and the bot then asks ElevenLabs to delete its copy. Gemini writes a short summary of the decisions and next steps. The notes and the transcript are posted in the 📞 Calls thread; the audio itself is never kept.',
        ),
      ],
    },
    {
      title: '🧵 Your project channel',
      color: 0x99aab5,
      fields: [
        field('The main chat', `For talking with ${OWNER_NAME}: questions, ideas, feedback, files.`),
        field(
          'Threads',
          '📞 **Calls**: recording consent, call notes and transcripts. 🔧 **Code changes**: changes made after delivery. 📈 **Progress updates**: how the build is going. You are added to each, so you get notified.',
        ),
        field(
          'Your team',
          `Need colleagues in the project? Ask ${OWNER_NAME} for an invite for each of them. Everyone on your side can talk, ask, join calls, and agree the spec, the quote and the delivery for your team.`,
        ),
      ],
    },
    {
      title: '🔒 Privacy and AI',
      color: 0x2b2d31,
      fields: [
        field('What is kept', 'A record of your project: the messages in your channel, the commands you run, payments, and call transcripts (never the audio). It gives you both a clear history.'),
        field(
          'AI',
          `Specs, answers to /ask, progress estimates, call summaries and project docs are drafted with Google Gemini, which does not keep them. Calls are transcribed by ElevenLabs. Progress updates are written by ${OWNER_NAME}'s AI coding assistant, Claude. Everything AI-written is marked as such.`,
        ),
        field('Who sees what', `Only you, your team, ${OWNER_NAME} and the bot see your project channel. Your code is in a private repository; \`/add-github\` gives you read-only access.`),
      ],
      footer: { text: 'Questions about any of this? Ask in your project channel.' },
    },
  ];
}

/** Only what we set, so a posted embed compares equal to the one we built. */
function normalise(embed: APIEmbed): string {
  return JSON.stringify({
    title: embed.title ?? null,
    description: embed.description ?? null,
    color: embed.color ?? null,
    fields: (embed.fields ?? []).map((item) => ({ name: item.name, value: item.value, inline: Boolean(item.inline) })),
    footer: embed.footer?.text ?? null,
  });
}

const embedOf = (message: Message): APIEmbed | undefined => {
  const first = message.embeds[0] as unknown as { toJSON?: () => APIEmbed } | APIEmbed | undefined;
  if (!first) return undefined;
  return 'toJSON' in first && typeof first.toJSON === 'function' ? first.toJSON() : (first as APIEmbed);
};

/** Makes a channel hold exactly these embeds, one per message: edits in place, adds or removes the difference. */
export async function syncGuideMessages(channel: TextChannel, botId: string, wanted: readonly APIEmbed[]): Promise<'unchanged' | 'updated'> {
  const existing = ([...(await channel.messages.fetch({ limit: 50 })).values()] as Message[]).filter((message) => message.author.id === botId).reverse();
  const same = (message: Message | undefined, embed: APIEmbed) => {
    const posted = message ? embedOf(message) : undefined;
    return message !== undefined && !message.content && message.embeds.length === 1 && posted !== undefined && normalise(posted) === normalise(embed);
  };
  if (existing.length === wanted.length && wanted.every((embed, index) => same(existing[index], embed))) return 'unchanged';
  for (const [index, embed] of wanted.entries()) {
    const message = existing[index];
    if (message) {
      if (!same(message, embed)) await message.edit({ content: '', embeds: [embed], allowedMentions: { parse: [] } });
    } else {
      await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    }
  }
  for (const extra of existing.slice(wanted.length)) await extra.delete().catch(() => undefined);
  return 'updated';
}

/** Brings #owner-guide and #how-it-works up to date with the current commands. Never throws. */
export async function syncGuides(guild: Guild, ownerId: string, commands: readonly Listed[]): Promise<void> {
  const botId = guild.members.me?.id;
  if (!botId) return;
  try {
    const owner = await syncGuideMessages(await ensureGuideChannel(guild, ownerId), botId, ownerGuide(commands));
    const client = await syncGuideMessages(await ensureClientGuideChannel(guild), botId, clientGuide(commands));
    log.info('guides synced', { owner, client });
  } catch (error) {
    log.warn('could not update the guides', { error });
  }
}
