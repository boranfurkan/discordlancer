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
import type { Env } from '../../src/env.js';
import { STATUS_SYSTEM, TRIAGE_SYSTEM } from '../../src/prompts/after-delivery.js';
import { SPEC_SYSTEM } from '../../src/prompts/specs.js';
import type { GeminiApi, JsonRequest } from '../../src/services/gemini.js';
import type { GitHubApi } from '../../src/services/github.js';
import type { MemoryApi } from '../../src/services/memory.js';
import { newReference, type SolanaApi } from '../../src/services/solana.js';
import { memoryDb } from '../helpers/db.js';
import { buttonInteraction, commandInteraction, FakeGuild, said, type FakeChannel, type Person } from '../helpers/fakeDiscord.js';

const GUILD = '223456789012345678';
const BOT = '123456789012345678';
const BORAN: Person = { id: '323456789012345678', name: 'Furkan' };
const CLIENT: Person = { id: '423456789012345678', name: 'Ahmet' };
const STRANGER: Person = { id: '523456789012345678', name: 'Stranger' };
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
};

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
    expect(github.collaborators).toEqual([{ repo: `boranfurkan/${PROJECT}`, username: 'ahmet-dev' }]);
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
    expect(said(await run(CLIENT, channel, 'agree-specs'))).toContain("You've already agreed to spec v1");
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

  it('13. Boran starts building; the client checks progress', async () => {
    expect(said(await run(CLIENT, channel, 'start-development'))).toBe('Only Furkan can do this.');
    await run(BORAN, channel, 'start-development');
    expect(await stage()).toBe('in_development');
    const progress = said(await run(CLIENT, channel, 'progress'));
    expect(progress).toContain('**Progress estimate: about 60%**');
    expect(progress).toContain('Not a measurement');
    expect(geminiInputs.at(-1)).toContain('<file path="src/booking.ts">');
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
  });

  it('18. The record: every step is an event, and memory heard the key moments', async () => {
    const [rows] = await db.query<[Array<{ action: string; outcome: string }>]>('SELECT action, outcome, at FROM event ORDER BY at');
    const actions = rows.map((row) => row.action);
    for (const step of [
      'project.created',
      'project.client_joined',
      'spec.created',
      'specs.agreed_by_both',
      'quote.created',
      'quote.accepted_by_both',
      'wallet.declared',
      'payment.requested',
      'payment.rejected',
      'payment.verified',
      'development.started',
      'status.checked',
      'delivery.marked',
      'delivery.confirmed',
      'support.started',
      'change.requested',
      'change.approved',
      'change.issue_opened',
    ]) {
      expect(actions, step).toContain(step);
    }
    expect(rows.filter((row) => row.outcome === 'refused').length).toBeGreaterThan(10);
    expect(remembered.some((text) => text.includes('agreed spec v1'))).toBe(true);
    expect(remembered.some((text) => text.includes('was paid 0.01 USDC'))).toBe(true);
    expect(remembered.some((text) => text.includes('delivered and the client confirmed'))).toBe(true);
  });
});
