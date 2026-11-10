// One project from start to finish, through the bot's real interaction handler and a
// real in-memory SurrealDB 4. Discord, GitHub, Gemini, Solana and Agent Memory are
// fakes that record what the bot asked of them. Nothing here needs a second person,
// the network or money.

import { ChannelType } from 'discord.js';
import type { Surreal } from 'surrealdb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getChangeRequest } from '../../src/db/changes.js';
import { listOpenRequests } from '../../src/db/payments.js';
import { getProjectByName } from '../../src/db/projects.js';
import { USDC_MINT } from '../../src/domain/payment.js';
import { routeInteraction } from '../../src/discord/client.js';
import type { BotContext } from '../../src/discord/command.js';
import { APPROVE_PREFIX, DECLINE_PREFIX, onApproveChange, onDeclineChange } from '../../src/discord/commands/afterDelivery.js';
import { CONFIRM_DELIVERY_BUTTON, onConfirmDeliveryButton } from '../../src/discord/commands/delivery.js';
import { COMMANDS } from '../../src/discord/commands/index.js';
import { onMemberAdd } from '../../src/discord/joins.js';
import { checkRequest } from '../../src/discord/watcher.js';
import { checkChangeRequest } from '../../src/discord/prWatcher.js';
import { ANSWER_MENU_NAME, onOwnerMention } from '../../src/discord/ownerAnswer.js';
import { ANSWER_SYSTEM } from '../../src/prompts/answers.js';
import type { Env } from '../../src/env.js';
import { STATUS_SYSTEM, TRIAGE_SYSTEM } from '../../src/prompts/after-delivery.js';
import { SPEC_SYSTEM } from '../../src/prompts/specs.js';
import { DOCS_REVIEW_SYSTEM, DOCS_SYSTEM } from '../../src/prompts/docs.js';
import type { GeminiApi, JsonRequest } from '../../src/services/gemini.js';
import type { GitHubApi, PullInfo, RepoFile } from '../../src/services/github.js';
import type { MemoryApi } from '../../src/services/memory.js';
import { newReference, type SolanaApi } from '../../src/services/solana.js';
import { memoryDb } from '../helpers/db.js';
import { buttonInteraction, commandInteraction, FakeGuild, incomingMessage, menuInteraction, said, type FakeChannel, type Person } from '../helpers/fakeDiscord.js';

const GUILD = '223456789012345678';
const BOT = '123456789012345678';
const BORAN: Person = { id: '323456789012345678', name: 'Furkan' };
const CLIENT: Person = { id: '423456789012345678', name: 'Ahmet' };
const STRANGER: Person = { id: '523456789012345678', name: 'Stranger' };
const CTO: Person = { id: '623456789012345678', name: 'Zeynep' };
const PROJECT = 'booking-app';

const BUTTONS = {
  [CONFIRM_DELIVERY_BUTTON]: onConfirmDeliveryButton,
  [APPROVE_PREFIX]: onApproveChange,
  [DECLINE_PREFIX]: onDeclineChange,
};

// --- Fakes that record what the bot asked for ---------------------------------

const github = {
  repos: [] as string[],
  collaborators: [] as Array<{ repo: string; username: string }>,
  issues: [] as Array<{ repo: string; title: string; body: string; labels: string[] }>,
  /** Pull requests Tessl has opened, by the issue they answer. */
  pulls: new Map<number, PullInfo>(),
  /** The docs folder on the main branch. */
  docs: new Map<string, string>(),
  commits: [] as Array<{ branch: string; files: RepoFile[]; message: string }>,
  docPulls: [] as Array<{ title: string; body: string }>,
};
const githubApi: GitHubApi = {
  ensureRepo: async (name) => {
    github.repos.push(name);
    return { fullName: `boranfurkan/${name}`, url: `https://github.com/boranfurkan/${name}`, created: true };
  },
  addCollaborator: async (repo, username) => {
    github.collaborators.push({ repo, username });
    return 'invited';
  },
  readRepo: async () => ({
    branch: 'main',
    commit: 'abc1234def5678',
    paths: ['README.md', 'src/booking.ts'],
    files: [{ path: 'src/booking.ts', content: 'export function book() {}' }],
  }),
  openIssue: async (repo, title, body, labels) => {
    github.issues.push({ repo, title, body, labels });
    return { number: github.issues.length, url: `https://github.com/${repo}/issues/${github.issues.length}` };
  },
  findPullForIssue: async (_repo, issue) => github.pulls.get(issue),
  getPull: async (_repo, number) => {
    const pull = [...github.pulls.values()].find((candidate) => candidate.number === number);
    if (!pull) throw new Error(`no pull request #${number}`);
    return pull;
  },
  readFolder: async () => new Map(github.docs),
  commitToBranch: async (_repo, branch, files, message) => {
    const changed = files.filter((file) => github.docs.get(file.path) !== file.content);
    if (changed.length === 0) return { changed: false };
    github.commits.push({ branch, files: changed, message });
    return { changed: true, sha: 'c0ffee1', base: 'main', paths: changed.map((file) => file.path) };
  },
  upsertPull: async (repo, _branch, title, body) => {
    github.docPulls.push({ title, body });
    return { number: 7, url: `https://github.com/${repo}/pull/7`, created: github.docPulls.length === 1 };
  },
};

/** The fake docs writer cites the chat message about barbers by its real time, and one source that doesn't exist. */
function fakeDocs(text: string) {
  const barber = /\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) UTC\] Client \(Ahmet\): Remember, customers should be able to pick a barber/.exec(text)?.[1] ?? 'missing';
  return {
    overview: '# Booking app\n\nA booking app for a barber shop. See requirements.md.',
    requirements: '## Agreed (spec v1)\n- Book a slot [spec v1]\n\n## Discussed since, not agreed yet\n- Customers pick a barber [chat ' + barber + ']',
    decisions: '- **2001-01-01**: Something nobody said. [chat 2001-01-01 00:00]',
    open_questions: '- Which email provider? (client) [spec v1]',
  };
}

const geminiInputs: string[] = [];
const geminiApi: GeminiApi = {
  async json<T>(request: JsonRequest<T>): Promise<T> {
    const text = request.input.map((part) => (part.type === 'text' ? part.text : '[image]')).join('\n');
    geminiInputs.push(text);
    let answer: unknown;
    if (request.system === SPEC_SYSTEM) {
      answer = { summary: 'A booking app for a barber shop.', markdown: '# Booking app\n\n## Features\n- Book a slot', changes: [], open_questions: ['Which email provider?'] };
    } else if (request.system === STATUS_SYSTEM) {
      answer = { summary: 'Booking works; emails are missing.', percent: 60, done: ['Book a slot'], remaining: ['Confirmation email'], confidence: 'medium' };
    } else if (request.system === TRIAGE_SYSTEM) {
      answer = text.includes('loyalty')
        ? { decision: 'quote', title: 'Loyalty points', task: '', questions: [], reason: 'Loyalty points are new work beyond the agreed spec.' }
        : { decision: 'small', title: 'Make the Book button green', task: 'Change the Book button colour to green.', questions: [], reason: 'A small styling change.' };
    } else if (request.system === ANSWER_SYSTEM) {
      const question = text.slice(text.lastIndexOf('<question>'));
      answer = /discount/i.test(question)
        ? { answer: 'The agreed price is 0.01 USDC for spec v1. Furkan decides anything beyond that.', needs_owner: true, owner_note: 'The client asks for a discount.', confidence: 'high', based_on: ['quote'] }
        : { answer: 'Booking a slot is in the agreed spec, and src/booking.ts has a book() function.', needs_owner: false, owner_note: '', confidence: 'medium', based_on: ['spec', 'code', 'chat'] };
    } else if (request.system === DOCS_SYSTEM) {
      answer = { ...fakeDocs(text), change_summary: github.docs.size ? [] : ['First version of the project docs'] };
    } else if (request.system === DOCS_REVIEW_SYSTEM) {
      expect(text).toContain('<draft>');
      answer = { ...fakeDocs(text), issues: ['Removed a claim that SMS reminders were agreed'] };
    } else {
      throw new Error('unexpected Gemini call');
    }
    // The fake's answers must pass the same Zod checks as real ones.
    return request.parse.parse(answer);
  },
};

const chain = {
  signaturesByAddress: new Map<string, string[]>(),
  transactions: new Map<string, unknown>(),
};
const solanaApi: SolanaApi = {
  signaturesFor: async (address) => (chain.signaturesByAddress.get(address) ?? []).map((signature) => ({ signature, err: null })),
  transaction: async (signature) => chain.transactions.get(signature) ?? null,
  accountOwner: async () => null, // a fresh wallet: no account yet, which is fine
};

/** Puts a finalized USDC transfer on the fake chain, the way a wallet sends a Solana Pay request. */
function payOnChain(signature: string, from: string, to: string, amountMicro: number, reference: string): void {
  const balance = (index: number, owner: string, amount: number) => ({ accountIndex: index, mint: USDC_MINT, owner, uiTokenAmount: { amount: String(amount), decimals: 6 } });
  chain.transactions.set(signature, {
    slot: 300_000_000,
    blockTime: Math.floor(Date.now() / 1000),
    meta: {
      err: null,
      preTokenBalances: [balance(1, from, amountMicro), balance(2, to, 0)],
      postTokenBalances: [balance(1, from, 0), balance(2, to, amountMicro)],
    },
    transaction: { signatures: [signature], message: { accountKeys: [{ pubkey: from }, { pubkey: 'ata1' }, { pubkey: 'ata2' }, { pubkey: reference }] } },
  });
  chain.signaturesByAddress.set(reference, [...(chain.signaturesByAddress.get(reference) ?? []), signature]);
}

const remembered: string[] = [];
const memoryApi: MemoryApi = {
  remember: async (_scope, text) => {
    remembered.push(text);
  },
  recall: async () => '',
};

// --- The world ------------------------------------------------------------------

let db: Surreal;
let ctx: BotContext;
let guild: FakeGuild;
let lobby: FakeChannel;
let BORAN_WALLET: string;
let CLIENT_WALLET: string;

async function run(person: Person, channel: FakeChannel, command: string, options: Record<string, string | boolean | Person> = {}) {
  const interaction = commandInteraction(guild, channel, person, command, options);
  await routeInteraction(interaction as never, ctx, BUTTONS);
  return interaction;
}

async function click(person: Person, channel: FakeChannel, customId: string) {
  const interaction = buttonInteraction(guild, channel, person, customId);
  await routeInteraction(interaction as never, ctx, BUTTONS);
  return interaction;
}

async function stage(): Promise<string | undefined> {
  return (await getProjectByName(db, PROJECT))?.stage;
}

beforeAll(async () => {
  db = await memoryDb();
  BORAN_WALLET = await newReference();
  CLIENT_WALLET = await newReference();
  guild = new FakeGuild(GUILD, BOT);
  guild.memberIds.add(BORAN.id);
  lobby = guild.addChannel('welcome', ChannelType.GuildText);
  const env = {
    DISCORD_GUILD_ID: GUILD,
    DISCORD_OWNER_ID: BORAN.id,
    SOLANA_WALLET_ADDRESS: BORAN_WALLET,
    GITHUB_OWNER: 'boranfurkan',
  } as Env;
  ctx = { env, db, github: githubApi, gemini: geminiApi, solana: solanaApi, memory: memoryApi, commands: COMMANDS };
});

afterAll(async () => {
  await db.close();
});

// --- The journey, in order --------------------------------------------------------

describe('a project from start to finish', () => {
  let channel: FakeChannel;
  let changeKey = '';

  it('1. Boran starts a project: private channel, invite and repo', async () => {
    const reply = await run(BORAN, lobby, 'new-project', { name: 'Booking App' });
    expect(said(reply)).toContain('Created **booking-app**');
    expect(said(reply)).toMatch(/Invite for the client \(one use, valid 7 days\): https:\/\/discord\.gg\/inv/);
    expect(reply.replies.every((r) => r.ephemeral || r.kind !== 'reply')).toBe(true);
    channel = guild.channelNamed(PROJECT);
    expect(guild.channelNamed('Projects').type).toBe(ChannelType.GuildCategory);
    expect(github.repos).toEqual([PROJECT]);
    expect(await stage()).toBe('created');
  });

  it('2. A client can do nothing before joining, and a stranger is kept out', async () => {
    expect(said(await run(CLIENT, channel, 'project'))).toBe("This isn't your project channel.");
    expect(said(await run(STRANGER, channel, 'quote', { amount: '1', deadline: '2030-01-15' }))).toBe('Only Furkan can do this.');
  });

  it('3. The client joins with the invite: channel opened, welcomed, Client role given', async () => {
    const project = (await getProjectByName(db, PROJECT))!;
    guild.useInvite(project.invite_code!, CLIENT.id);
    await onMemberAdd({ id: CLIENT.id, guild, user: { bot: false } } as never, ctx);
    expect(await stage()).toBe('joined');
    expect(channel.overwrites.get(CLIENT.id)).toMatchObject({ ViewChannel: true, SendMessages: true });
    expect(channel.botText().at(-1)).toContain(`Welcome, <@${CLIENT.id}>!`);
    expect(guild.roleGrants).toEqual([{ user: CLIENT.id, role: 'role-client' }]);
  });

  it('4. The client looks around: /help, /project, /add-github', async () => {
    const help = said(await run(CLIENT, channel, 'help'));
    expect(help).toContain('**Stage:** Talking about the project');
    expect(help).toContain('/agree-specs');
    expect(help).not.toContain('/quote');
    const card = (await run(CLIENT, channel, 'project')).replies[0]!;
    expect(card.embeds[0]?.fields?.find((f) => f.name === 'Client')?.value).toBe(`<@${CLIENT.id}>`);
    expect(said(await run(CLIENT, channel, 'add-github', { username: 'ahmet-dev' }))).toContain('Invited **ahmet-dev**');
    expect(said(await run(CLIENT, channel, 'add-github', { username: 'ahmet-dev2' }))).toContain('read-only access');
    expect(github.collaborators.map((c) => c.username)).toEqual(['ahmet-dev', 'ahmet-dev2']);
  });

  it("4b. The client's CTO joins with a team invite and gets the same access", async () => {
    expect(said(await run(CLIENT, channel, 'invite'))).toBe('Only Furkan can do this.');
    const reply = said(await run(BORAN, channel, 'invite'));
    expect(reply).toMatch(/Invite for one more person on \*\*booking-app\*\*'s team \(one use, valid 7 days\): https:\/\/discord\.gg\/inv/);
    const code = /discord\.gg\/(\S+)/.exec(reply)![1]!;
    guild.useInvite(code, CTO.id);
    await onMemberAdd({ id: CTO.id, guild, user: { bot: false } } as never, ctx);

    expect(await stage()).toBe('joined'); // unchanged
    const project = (await getProjectByName(db, PROJECT))!;
    expect(project.client_id).toBe(CLIENT.id);
    expect(project.client_ids).toEqual([CTO.id]);
    expect(channel.overwrites.get(CTO.id)).toMatchObject({ ViewChannel: true, SendMessages: true, SendMessagesInThreads: true });
    expect(channel.botText().at(-1)).toContain(`Welcome, <@${CTO.id}>! You've joined **booking-app** with the rest of your team.`);
    expect(guild.roleGrants.at(-1)).toEqual({ user: CTO.id, role: 'role-client' });
    const [invites] = await db.query<[Array<{ status: string; used_by: string }>]>('SELECT status, used_by FROM invite');
    expect(invites).toEqual([{ status: 'used', used_by: CTO.id }]);

    // The CTO is on the client's side for commands, and the project card lists both.
    const card = (await run(CTO, channel, 'project')).replies[0]!;
    expect(card.embeds[0]?.fields?.find((f) => f.name === 'Client')?.value).toBe(`<@${CLIENT.id}> <@${CTO.id}>`);
    expect(said(await run(STRANGER, channel, 'project'))).toBe("This isn't your project channel.");
  });

  it('5. Commands at the wrong stage are refused in plain words', async () => {
    expect(said(await run(CLIENT, channel, 'pay'))).toContain("That can't be done at this stage (Talking about the project)");
    expect(said(await run(CLIENT, channel, 'agree-specs'))).toContain('There are no specs yet');
  });

  it('6. They talk; Boran writes the specs with Gemini, from the conversation', async () => {
    channel.post(CLIENT, 'I need a booking app for my barber shop. Customers pick a slot.');
    channel.post(BORAN, 'Which platforms?');
    channel.post(CLIENT, 'Web, mobile friendly.');
    const reply = await run(BORAN, channel, 'create-specs');
    expect(said(reply)).toContain('**Spec v1** for **booking-app**');
    expect(said(reply)).toContain('Which email provider?');
    expect(reply.replies.at(-1)?.files).toEqual(['booking-app-spec-v1.md']);
    const prompt = geminiInputs.at(-1)!;
    expect(prompt).toContain('Client (Ahmet): I need a booking app for my barber shop.');
    expect(prompt).toContain('Furkan (owner): Which platforms?');
    expect(prompt).not.toContain('Welcome, <@'); // the bot's own messages are left out
    expect(channel.history.some((m) => m.pinned)).toBe(true);
  });

  it('7. Both agree the specs; the stage moves only when both have', async () => {
    expect(said(await run(CLIENT, channel, 'agree-specs'))).toContain('Waiting for Furkan');
    expect(await stage()).toBe('joined');
    expect(said(await run(CTO, channel, 'agree-specs'))).toContain('Your side has already agreed to spec v1'); // one agreement for the whole team
    expect(said(await run(BORAN, channel, 'agree-specs'))).toContain('Both sides agreed to **spec v1**');
    expect(await stage()).toBe('specs_agreed');
  });

  it('8. Only Boran quotes; a deadline after the freeze gets a private warning', async () => {
    expect(said(await run(CLIENT, channel, 'quote', { amount: '0.01', deadline: '2030-01-15' }))).toBe('Only Furkan can do this.');
    const reply = await run(BORAN, channel, 'quote', { amount: '0.01', deadline: '2030-01-15' });
    expect(said(reply)).toContain('**Quote v1** for **booking-app** (spec v1)');
    expect(said(reply)).toContain('Price: **0.01 USDC**');
    expect(reply.replies.find((r) => r.kind === 'followUp')).toMatchObject({ ephemeral: true, content: expect.stringContaining('after the hackathon freeze') });
    expect(said(await run(BORAN, channel, 'accept-quote'))).toContain('Posting the quote already counts as your acceptance');
  });

  it('9. The client accepts the quote', async () => {
    expect(said(await run(CLIENT, channel, 'accept-quote'))).toContain('accepted **quote v1**: 0.01 USDC');
    expect(await stage()).toBe('quote_accepted');
  });

  it('10. The client declares a wallet, then gets the Solana Pay QR code', async () => {
    expect(said(await run(CLIENT, channel, 'pay'))).toContain('First declare the wallet');
    expect(said(await run(BORAN, channel, 'set-payment-wallet', { address: CLIENT_WALLET }))).toContain('The client declares their own wallet');
    expect(said(await run(CLIENT, channel, 'set-payment-wallet', { address: BORAN_WALLET }))).toContain("That's Furkan's receiving wallet");
    expect(said(await run(CLIENT, channel, 'set-payment-wallet', { address: 'not-a-wallet' }))).toContain("That isn't a Solana address");
    expect(said(await run(CLIENT, channel, 'set-payment-wallet', { address: CLIENT_WALLET }))).toContain('declared their payment wallet');

    const pay = await run(CLIENT, channel, 'pay');
    const text = said(pay);
    expect(text).toContain('**Pay quote v1: 0.01 USDC on Solana**');
    expect(text).toContain(`solana:${BORAN_WALLET}?amount=0.01&spl-token=${USDC_MINT}&reference=`);
    expect(pay.replies.at(-1)?.files).toEqual(['pay-booking-app-v1.png']);
    // Running /pay again reuses the same request.
    await run(CLIENT, channel, 'pay');
    expect(await listOpenRequests(db)).toHaveLength(1);
  });

  it('11. A payment from the wrong wallet is reported once and does not count', async () => {
    const [request] = await listOpenRequests(db);
    const wrongWallet = await newReference();
    payOnChain('SigWrongWallet', wrongWallet, BORAN_WALLET, 10_000, request!.reference);
    const client = { guilds: { cache: new Map([[GUILD, guild]]) } };
    const judged = new Set<string>();
    await checkRequest(client as never, ctx, request!, judged);
    await checkRequest(client as never, ctx, request!, judged);
    expect(await stage()).toBe('quote_accepted');
    const desk = guild.channelNamed('owner-desk');
    expect(desk.botText().filter((t) => t.includes("doesn't count as payment"))).toHaveLength(1);
  });

  it('12. The real payment is found by its reference, recorded once and announced', async () => {
    const [request] = await listOpenRequests(db);
    payOnChain('SigGood', CLIENT_WALLET, BORAN_WALLET, 10_000, request!.reference);
    const client = { guilds: { cache: new Map([[GUILD, guild]]) } };
    const judged = new Set<string>();
    await checkRequest(client as never, ctx, request!, judged);
    expect(await stage()).toBe('paid');
    expect(channel.botText().at(-1)).toContain('Payment received: **0.01 USDC**');
    expect(guild.channelNamed('owner-desk').botText().at(-1)).toContain('USDC sales are reported by hand');
    expect(await listOpenRequests(db)).toHaveLength(0);
    // /paid with the same signature is refused: it's already recorded.
    expect(said(await run(CLIENT, channel, 'paid', { signature: 'SigGood'.padEnd(88, '1') }))).toContain("That can't be done at this stage (Paid)");
    const receipt = (await run(CLIENT, channel, 'receipt')).replies[0]!;
    expect(receipt.embeds[0]?.fields?.[0]?.name).toBe('Payment 1: 0.01 USDC');
  });

  it('12b. Boran makes the invoice for the organisers; it never changes once issued', async () => {
    const year = new Date().getUTCFullYear();
    expect(said(await run(CLIENT, channel, 'invoice', { billed_to: 'Ahmet Barbers' }))).toBe('Only Furkan can do this.');
    const first = said(await run(BORAN, channel, 'invoice', { billed_to: 'Ahmet Barbers Ltd | 1 High Street, London', note: 'Thank you!' }));
    expect(first).toContain(`Invoice **DL-${year}-0001** is in https://discord.com/channels/`);
    const desk = guild.channelNamed('owner-desk');
    expect(desk.history.at(-1)?.files).toEqual([`DL-${year}-0001.pdf`]);
    expect(desk.history.at(-1)?.content).toContain('0.01 USDC, paid');

    const again = said(await run(BORAN, channel, 'invoice', { billed_to: 'Someone Else' }));
    expect(again).toContain(`already has invoice **DL-${year}-0001**`);
    expect(desk.history.at(-1)?.files).toEqual([`DL-${year}-0001.pdf`]);

    const corrected = said(await run(BORAN, channel, 'invoice', { billed_to: 'Ahmet Barbers Limited', correct: true }));
    expect(corrected).toContain(`Invoice **DL-${year}-0002**`);
    expect(desk.history.at(-1)?.content).toContain(`It replaces DL-${year}-0001.`);
  });

  it('13. Boran starts building; the client checks progress', async () => {
    expect(said(await run(CLIENT, channel, 'start-development'))).toBe('Only Furkan can do this.');
    await run(BORAN, channel, 'start-development');
    expect(await stage()).toBe('in_development');
    const progress = said(await run(CLIENT, channel, 'progress'));
    expect(progress).toContain('**Progress estimate: about 60%**');
    expect(progress).toContain('Not a measurement');
    expect(geminiInputs.at(-1)).toContain('<file path="src/booking.ts">');
  });

  it('13b. Questions: the client uses /ask; Boran has the bot answer a client message', async () => {
    channel.post(CLIENT, 'Remember, customers should be able to pick a barber.');

    // The client asks, and the answer is built from everything the bot knows, read fresh.
    const answer = said(await run(CLIENT, channel, 'ask', { question: 'Is booking a slot done yet?' }));
    expect(answer).toContain('> Is booking a slot done yet?');
    expect(answer).toContain('Booking a slot is in the agreed spec');
    expect(answer).toContain('-# AI answer from the spec, the code at `abc1234`, the chat.');
    const input = geminiInputs.at(-1)!;
    expect(input).toContain('<spec version="1" status="agreed by both">');
    expect(input).toContain('Latest quote: v1, 0.01 USDC for spec v1');
    expect(input).toContain('Payments received: 0.01 USDC');
    expect(input).toContain('customers should be able to pick a barber'); // the live chat
    expect(input).toMatch(/UTC\] Bot: /); // and the bot's own posts
    expect(input).toContain('<file path="src/booking.ts">');
    expect(input).toContain('<question>\nIs booking a slot done yet?\n</question>');

    // Anything beyond the deal goes to Boran.
    const discount = said(await run(CLIENT, channel, 'ask', { question: 'Can I get a discount?' }));
    expect(discount).toContain('Furkan decides anything beyond that.');
    expect(guild.channelNamed('owner-desk').botText().at(-1)).toContain('**booking-app**: a question needs you');

    // Boran replies to a client message and tags the bot, with a note for the answer.
    const question = channel.post(CLIENT, 'Can it send reminders by SMS?');
    const before = channel.history.length;
    await onOwnerMention(incomingMessage(guild, channel, BORAN, `<@${BOT}> say SMS isn't in the spec`, question) as never, ctx, BOT);
    const reply = channel.history.at(-1)!;
    expect(reply.author.bot).toBe(true);
    expect(reply.replyTo).toBe(question.id);
    expect(reply.content).toContain('-# AI answer');
    expect(geminiInputs.at(-1)).toContain("<owner_note>\nsay SMS isn't in the spec\n</owner_note>");
    expect(geminiInputs.at(-1)).toContain('<question>\nCan it send reminders by SMS?\n</question>');
    expect(channel.history.length).toBe(before + 2); // Boran's message, then the answer

    // A reply without the tag, or the client tagging the bot, answers nothing.
    const quiet = channel.history.length;
    await onOwnerMention(incomingMessage(guild, channel, BORAN, 'Thanks!', question) as never, ctx, BOT);
    await onOwnerMention(incomingMessage(guild, channel, CLIENT, `<@${BOT}> give me a discount`) as never, ctx, BOT);
    expect(channel.history.length).toBe(quiet + 2);

    // Right-click, Apps, "Answer with AI": only Boran can use it.
    const another = channel.post(CLIENT, 'Which page shows my bookings?');
    const refused = menuInteraction(guild, channel, CLIENT, ANSWER_MENU_NAME, another);
    await routeInteraction(refused as never, ctx, BUTTONS);
    expect(said(refused)).toBe('Only Furkan can do this.');
    const menu = menuInteraction(guild, channel, BORAN, ANSWER_MENU_NAME, another);
    await routeInteraction(menu as never, ctx, BUTTONS);
    expect(said(menu)).toContain('Answered: https://discord.com/channels/');
    expect(channel.history.at(-1)?.replyTo).toBe(another.id);
  });

  it('13c. Boran syncs the project docs into the repo, as a pull request he reviews', async () => {
    expect(said(await run(CLIENT, channel, 'sync-docs'))).toBe('Only Furkan can do this.');
    const reply = said(await run(BORAN, channel, 'sync-docs'));
    expect(reply).toContain('Opened the docs pull request for **booking-app**: https://github.com/boranfurkan/booking-app/pull/7');
    expect(reply).toContain("1 citation(s) couldn't be matched");

    const writer = geminiInputs.at(-2)!;
    expect(writer).toContain('<spec version="1" status="agreed by both"');
    expect(writer).toContain('customers should be able to pick a barber');
    expect(writer).toContain('<current_docs>There are no docs in the repository yet.</current_docs>');
    expect(geminiInputs.at(-1)).toContain('<draft>');

    const [commit] = github.commits;
    expect(commit!.branch).toBe('discordlancer/project-docs');
    expect(commit!.files.map((file) => file.path)).toEqual([
      'docs/project/README.md',
      'docs/project/requirements.md',
      'docs/project/decisions.md',
      'docs/project/open-questions.md',
    ]);
    const body = github.docPulls[0]!.body;
    expect(body).toContain('- First version of the project docs');
    expect(body).toContain('fixed 1 thing:\n- Removed a claim that SMS reminders were agreed');
    expect(body).toContain("**Citations:** 4 checked; these couldn't be matched to a source, so check them before merging:\n- [chat 2001-01-01 00:00]");
    expect(body).toMatch(/\*\*Sources:\*\* \d+ chat messages, spec v1 \(agreed by both\), quote v1/);
    expect(guild.channelNamed('owner-desk').botText().at(-1)).toContain('Opened the docs pull request');

    // Boran merges it; a second sync finds nothing new.
    for (const file of commit!.files) github.docs.set(file.path, file.content);
    expect(said(await run(BORAN, channel, 'sync-docs'))).toContain('The docs in the repo are already up to date; nothing changed.');
    expect(github.commits).toHaveLength(1);
    expect(geminiInputs.at(-2)).toContain('<doc path="docs/project/README.md">');
  });

  it('14. Boran marks delivery; only the client can confirm it', async () => {
    expect(said(await run(CLIENT, channel, 'confirm-delivery'))).toContain("hasn't marked it as delivered yet");
    const marked = await run(BORAN, channel, 'confirm-delivery', { note: 'Live at https://booking.example' });
    expect(marked.replies[0]?.customIds).toEqual([CONFIRM_DELIVERY_BUTTON]);
    expect(said(await click(BORAN, channel, CONFIRM_DELIVERY_BUTTON))).toContain('Only the client confirms the delivery');
    const confirmed = await click(CLIENT, channel, CONFIRM_DELIVERY_BUTTON);
    expect(confirmed.replies.find((r) => r.kind === 'followUp')?.content).toContain('confirmed the delivery');
    expect(await stage()).toBe('delivered');
  });

  it('15. A small change request: triaged, approved by Boran only, sent to Tessl as an issue', async () => {
    const request = await run(CLIENT, channel, 'request-update', { details: 'Please make the Book button green.' });
    expect(said(request)).toContain('Change request noted: **Make the Book button green**');
    expect(await stage()).toBe('support');
    const approveId = request.replies.at(-1)!.customIds.find((id) => id.startsWith(APPROVE_PREFIX))!;
    expect(said(await click(CLIENT, channel, approveId))).toContain('Only Furkan can approve or decline changes');
    expect(github.issues).toHaveLength(0);

    const approved = await click(BORAN, channel, approveId);
    expect(said(approved)).toContain('Opened issue #1');
    expect(github.issues[0]).toMatchObject({ repo: `boranfurkan/${PROJECT}`, title: 'Make the Book button green', labels: ['tessl'] });
    expect(github.issues[0]!.body).toContain('> Please make the Book button green.');
    expect((await getChangeRequest(db, approveId.slice(APPROVE_PREFIX.length)))?.status).toBe('issue_opened');
    // A second click can't open a second issue.
    expect(said(await click(BORAN, channel, approveId))).toContain('already been handled');
    expect(github.issues).toHaveLength(1);
    changeKey = approveId.slice(APPROVE_PREFIX.length);
  });

  it("15b. Tessl's pull request is posted in the channel, then its merge", async () => {
    const check = async () => checkChangeRequest(guild as never, ctx, (await getChangeRequest(db, changeKey))!);
    await check(); // no pull request yet: nothing happens
    expect(channel.botText().at(-1)).not.toContain('pull request #7');

    github.pulls.set(1, { number: 7, url: 'https://github.com/boranfurkan/booking-app/pull/7', state: 'open', merged: false, branch: 'tessl/issue-1' });
    const mainChat = channel.botText().length;
    await check();
    const code = guild.channelNamed('🔧 Code changes');
    expect(code.parentId).toBe(channel.id);
    expect([...code.threadMembers]).toEqual([BORAN.id, CLIENT.id, CTO.id]);
    expect(code.botText().at(-1)).toContain('Tessl has proposed **Make the Book button green** as pull request #7');
    expect(code.botText().at(-1)).toContain('Furkan reviews it before anything is merged');
    expect(channel.botText()).toHaveLength(mainChat); // the main chat stays a conversation
    expect(guild.channelNamed('owner-desk').botText().at(-1)).toContain('Review **booking-app**: Tessl opened pull request #7');
    expect(await getChangeRequest(db, changeKey)).toMatchObject({ status: 'pr_open', pr_number: 7 });

    await check(); // still open: nothing new is posted
    const posted = code.botText().length;
    github.pulls.set(1, { ...github.pulls.get(1)!, state: 'closed', merged: true });
    code.archived = true; // a week went by: Discord archived the thread
    await check();
    expect(code.archived).toBe(false);
    expect(code.botText()).toHaveLength(posted + 1);
    expect(code.botText().at(-1)).toContain('**Make the Book button green** is done: pull request #7 has been merged');
    expect((await getChangeRequest(db, changeKey))?.status).toBe('merged');
    expect(remembered.some((text) => text.includes('merged: Make the Book button green'))).toBe(true);
  });

  it('16. A bigger request is sent back for a new quote, and Boran is told', async () => {
    const request = await run(CLIENT, channel, 'request-update', { details: 'Add a loyalty points system.' });
    expect(said(request)).toContain('it needs a new quote');
    expect(guild.channelNamed('owner-desk').botText().at(-1)).toContain('needs a new quote');
  });

  it('17. Paperwork: evidence pack, sales report and touch line', async () => {
    expect(said(await run(CLIENT, channel, 'export'))).toBe('Only Furkan can do this.');
    const exported = await run(BORAN, channel, 'export');
    expect(said(exported)).toContain('Evidence pack sent to');
    const desk = guild.channelNamed('owner-desk');
    expect(desk.history.at(-1)?.files).toEqual(
      expect.arrayContaining(['booking-app-transcript-' + new Date().toISOString().slice(0, 10) + '.md', 'booking-app-spec-v1.md']),
    );
    const report = said(await run(BORAN, lobby, 'report'));
    expect(report).toContain('- booking-app: 0.01 USDC, transaction SigGood');
    const touches = said(await run(BORAN, lobby, 'touches'));
    expect(touches).toContain('set up booking-app');
    expect(touches).toContain('posted quote v1 for booking-app');
    expect(touches).toContain('had the AI assistant answer client questions on booking-app');
    expect(touches).toContain('updated the project docs for booking-app in a pull request');
    expect(touches).toContain('issued the invoice for booking-app');
  });

  it('18. The record: every step is an event, and memory heard the key moments', async () => {
    const [rows] = await db.query<[Array<{ action: string; outcome: string }>]>('SELECT action, outcome, at FROM event ORDER BY at');
    const actions = rows.map((row) => row.action);
    for (const step of [
      'project.created',
      'project.client_joined',
      'project.team_invite_created',
      'project.member_joined',
      'spec.created',
      'specs.agreed_by_both',
      'quote.created',
      'quote.accepted_by_both',
      'wallet.declared',
      'payment.requested',
      'payment.rejected',
      'payment.verified',
      'invoice.issued',
      'development.started',
      'status.checked',
      'ask.answered',
      'question.answered',
      'docs.synced',
      'delivery.marked',
      'delivery.confirmed',
      'support.started',
      'change.requested',
      'change.approved',
      'change.issue_opened',
      'change.pr_opened',
      'change.merged',
    ]) {
      expect(actions, step).toContain(step);
    }
    expect(rows.filter((row) => row.outcome === 'refused').length).toBeGreaterThan(10);
    expect(remembered.some((text) => text.includes('agreed spec v1'))).toBe(true);
    expect(remembered.some((text) => text.includes('was paid 0.01 USDC'))).toBe(true);
    expect(remembered.some((text) => text.includes('delivered and the client confirmed'))).toBe(true);
  });
});
