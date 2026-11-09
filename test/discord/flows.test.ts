// End-to-end tests of the two paths that can't be tried overnight in the real server:
// a client joining through an invite, and the watcher settling a payment. Discord is
// faked; the database is a real in-memory SurrealDB 4; the payment is a recorded
// mainnet transaction with its addresses replaced.

import { readFileSync } from 'node:fs';
import { ChannelType, Collection } from 'discord.js';
import type { Surreal } from 'surrealdb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequest, paymentBySignature } from '../../src/db/payments.js';
import { createProject, getProjectByName, moveStage } from '../../src/db/projects.js';
import type { BotContext } from '../../src/discord/command.js';
import { onMemberAdd } from '../../src/discord/joins.js';
import { checkRequest } from '../../src/discord/watcher.js';
import type { Env } from '../../src/env.js';
import type { MemoryApi } from '../../src/services/memory.js';
import type { SolanaApi } from '../../src/services/solana.js';
import { memoryDb } from '../helpers/db.js';

const GUILD = '223456789012345678';
const OWNER = '323456789012345678';
const CLIENT = '423456789012345678';
const SENDER = 'Fake01xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const RECIPIENT = 'Fake05xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
const REFERENCE = 'Ref1111111111111111111111111111111111111111';
const fixture = JSON.parse(readFileSync(new URL('../fixtures/solana/usdc-transfer.json', import.meta.url), 'utf8'));
const SIGNATURE = fixture.transaction.signatures[0] as string;

/** The recorded transfer, with the Solana Pay reference added, as a wallet would. */
function paidTransaction() {
  const tx = structuredClone(fixture);
  tx.transaction.message.accountKeys.push({ pubkey: REFERENCE, writable: false, signer: false, source: 'transaction' });
  return tx;
}

type FakeChannel = {
  id: string;
  name: string;
  type: ChannelType;
  parentId: string | null;
  sent: string[];
  overwrites: Array<{ id: string; permissions: Record<string, boolean> }>;
  send(message: string | { content?: string }): Promise<void>;
  permissionOverwrites: { edit(id: string, permissions: Record<string, boolean>): Promise<void> };
};

function fakeChannel(id: string, name: string, type = ChannelType.GuildText, parentId: string | null = 'cat'): FakeChannel {
  const channel: FakeChannel = {
    id,
    name,
    type,
    parentId,
    sent: [],
    overwrites: [],
    async send(message) {
      channel.sent.push(typeof message === 'string' ? message : (message.content ?? ''));
    },
    permissionOverwrites: {
      async edit(userId, permissions) {
        channel.overwrites.push({ id: userId, permissions });
      },
    },
  };
  return channel;
}

function fakeGuild(channels: FakeChannel[], liveInviteCodes: string[]) {
  const all = new Collection(channels.map((channel) => [channel.id, channel]));
  const roleGrants: Array<{ user: string; role: string }> = [];
  return {
    id: GUILD,
    roleGrants,
    roles: { everyone: { id: GUILD }, fetch: async () => new Collection([['role-client', { id: 'role-client', name: 'Client' }]]) },
    members: {
      me: { id: 'bot' },
      addRole: async ({ user, role }: { user: string; role: string }) => {
        roleGrants.push({ user, role });
      },
    },
    invites: { fetch: async () => new Collection(liveInviteCodes.map((code) => [code, { code }])) },
    channels: {
      fetch: async (id?: string) => (id ? (all.get(id) ?? null) : all),
      create: async () => {
        throw new Error('the test should not need to create channels');
      },
    },
  };
}

let db: Surreal;
const remembered: string[] = [];
const memory: MemoryApi = {
  remember: async (_scope, text) => {
    remembered.push(text);
  },
  recall: async () => '',
};

function context(solana: Partial<SolanaApi> = {}): BotContext {
  const env = { DISCORD_GUILD_ID: GUILD, DISCORD_OWNER_ID: OWNER, SOLANA_WALLET_ADDRESS: RECIPIENT } as Env;
  return {
    env,
    db,
    memory,
    commands: [],
    github: {} as BotContext['github'],
    gemini: {} as BotContext['gemini'],
    solana: { signaturesFor: async () => [], transaction: async () => null, accountOwner: async () => null, ...solana },
  };
}

beforeAll(async () => {
  db = await memoryDb();
});
afterAll(async () => {
  await db.close();
});

describe('a client joining through the invite', () => {
  it('opens only their project, records the join and welcomes them', async () => {
    await createProject(db, { name: 'join-a', channelId: 'c-join-a', repo: 'o/join-a', inviteCode: 'inviteA' }, { actor: 'owner', action: 'project.created', outcome: 'ok' });
    await createProject(db, { name: 'join-b', channelId: 'c-join-b', repo: 'o/join-b', inviteCode: 'inviteB' }, { actor: 'owner', action: 'project.created', outcome: 'ok' });
    const a = fakeChannel('c-join-a', 'join-a');
    const b = fakeChannel('c-join-b', 'join-b');
    // inviteA is used up (gone); inviteB is still live.
    const guild = fakeGuild([fakeChannel('cat', 'Projects', ChannelType.GuildCategory, null), a, b], ['inviteB']);
    const member = { id: CLIENT, guild, user: { bot: false } };

    await onMemberAdd(member as never, context());

    expect((await getProjectByName(db, 'join-a'))).toMatchObject({ stage: 'joined', client_id: CLIENT });
    expect((await getProjectByName(db, 'join-b'))?.stage).toBe('created');
    expect(a.overwrites).toEqual([expect.objectContaining({ id: CLIENT, permissions: expect.objectContaining({ ViewChannel: true, SendMessages: true }) })]);
    expect(b.overwrites).toEqual([]);
    expect(a.sent[0]).toContain(`Welcome, <@${CLIENT}>!`);
    expect(a.sent[0]).toContain('**Privacy:**');
    expect(guild.roleGrants).toEqual([{ user: CLIENT, role: 'role-client' }]);
  });

  it('ignores the owner and bots joining', async () => {
    const guild = fakeGuild([], []);
    await onMemberAdd({ id: OWNER, guild, user: { bot: false } } as never, context());
    await onMemberAdd({ id: 'somebot', guild, user: { bot: true } } as never, context());
    expect((await getProjectByName(db, 'join-b'))?.stage).toBe('created');
  });
});

describe('the payment watcher', () => {
  async function readyToPay(name: string) {
    await createProject(db, { name, channelId: `c-${name}`, repo: `o/${name}`, inviteCode: `i-${name}` }, { actor: 'owner', action: 'project.created', outcome: 'ok' });
    let project = (await getProjectByName(db, name))!;
    await moveStage(db, project, 'created', 'joined', { actor: 'client', action: 'test', outcome: 'ok' }, { client_id: CLIENT, client_wallet: SENDER });
    for (const [from, to] of [['joined', 'specs_agreed'], ['specs_agreed', 'quote_accepted']] as const) {
      project = (await getProjectByName(db, name))!;
      await moveStage(db, project, from, to, { actor: 'bot', action: 'test', outcome: 'ok' });
    }
    project = (await getProjectByName(db, name))!;
    const request = await createRequest(db, project, { quoteVersion: 1, amountMicro: 25_000_000, reference: `${REFERENCE}-${name}` }, { actor: 'client', action: 'payment.requested', outcome: 'ok' });
    return { project, request };
  }

  it('finds the payment by its reference, records it once, and tells both people', async () => {
    const { request } = await readyToPay('watch-a');
    const tx = paidTransaction();
    tx.transaction.message.accountKeys.at(-1).pubkey = request.reference;
    const projectChannel = fakeChannel('c-watch-a', 'watch-a');
    const ownerDesk = fakeChannel('owner', 'owner-desk');
    const guild = fakeGuild([fakeChannel('cat', 'Projects', ChannelType.GuildCategory, null), projectChannel, ownerDesk], []);
    const client = { guilds: { cache: new Collection([[GUILD, guild]]) } };
    let transactionCalls = 0;
    const ctx = context({
      signaturesFor: async (address) => (address === request.reference ? [{ signature: SIGNATURE, err: null }] : []),
      transaction: async () => {
        transactionCalls++;
        return tx;
      },
    });

    const judged = new Set<string>();
    await checkRequest(client as never, ctx, request, judged);

    expect((await getProjectByName(db, 'watch-a'))?.stage).toBe('paid');
    expect(await paymentBySignature(db, SIGNATURE)).toMatchObject({ amount_micro: 25_008_015, from_wallet: SENDER, to_wallet: RECIPIENT });
    expect(projectChannel.sent[0]).toContain('Payment received: **25.008015 USDC**');
    expect(ownerDesk.sent[0]).toContain('USDC sales are reported by hand');
    expect(remembered.some((text) => text.includes('watch-a was paid 25.008015 USDC'))).toBe(true);

    // The next tick must not record or announce it again.
    await checkRequest(client as never, ctx, request, judged);
    expect(projectChannel.sent).toHaveLength(1);
    expect(transactionCalls).toBe(1);
  });

  it("reports a transaction that doesn't count, once, and leaves the project unpaid", async () => {
    const { request } = await readyToPay('watch-b');
    const tx = paidTransaction();
    tx.transaction.signatures[0] = 'OtherSignature';
    tx.transaction.message.accountKeys.at(-1).pubkey = request.reference;
    // Paid from a wallet other than the declared one.
    for (const balance of [...tx.meta.preTokenBalances, ...tx.meta.postTokenBalances]) {
      if (balance.owner === SENDER) balance.owner = 'SomeoneElse111111111111111111111111111111111';
    }
    const ownerDesk = fakeChannel('owner', 'owner-desk');
    const guild = fakeGuild([fakeChannel('cat', 'Projects', ChannelType.GuildCategory, null), fakeChannel('c-watch-b', 'watch-b'), ownerDesk], []);
    const client = { guilds: { cache: new Collection([[GUILD, guild]]) } };
    const ctx = context({ signaturesFor: async () => [{ signature: 'OtherSignature', err: null }], transaction: async () => tx });

    const judged = new Set<string>();
    await checkRequest(client as never, ctx, request, judged);
    await checkRequest(client as never, ctx, request, judged);

    expect((await getProjectByName(db, 'watch-b'))?.stage).toBe('quote_accepted');
    expect(await paymentBySignature(db, 'OtherSignature')).toBeUndefined();
    expect(ownerDesk.sent).toHaveLength(1);
    expect(ownerDesk.sent[0]).toContain("the USDC didn't come from the declared wallet");
  });

  it('waits when the transaction is not final yet', async () => {
    const { request } = await readyToPay('watch-c');
    const guild = fakeGuild([], []);
    const client = { guilds: { cache: new Collection([[GUILD, guild]]) } };
    const judged = new Set<string>();
    await checkRequest(client as never, context({ signaturesFor: async () => [{ signature: 'Pending', err: null }], transaction: async () => null }), request, judged);
    expect(judged.has('Pending')).toBe(false);
    expect((await getProjectByName(db, 'watch-c'))?.stage).toBe('quote_accepted');
  });
});
