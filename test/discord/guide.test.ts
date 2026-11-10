import type { APIEmbed } from 'discord.js';
import { ChannelType, OverwriteType } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../../src/discord/commands/index.js';
import { clientGuide, GUIDE, ownerGuide, syncGuides } from '../../src/discord/guide.js';
import { FakeGuild } from '../helpers/fakeDiscord.js';

/** Discord's embed limits: a message holding one of these must be accepted. */
function withinLimits(embed: APIEmbed): boolean {
  const fields = embed.fields ?? [];
  const total = (embed.title ?? '').length + (embed.description ?? '').length + (embed.footer?.text ?? '').length + fields.reduce((sum, item) => sum + item.name.length + item.value.length, 0);
  return (
    (embed.title ?? '').length <= 256 &&
    (embed.description ?? '').length <= 4096 &&
    fields.length <= 25 &&
    fields.every((item) => item.name.length <= 256 && item.value.length <= 1024) &&
    (embed.footer?.text ?? '').length <= 2048 &&
    total <= 6000
  );
}

const text = (embeds: readonly APIEmbed[]) => JSON.stringify(embeds);
const fieldNames = (embeds: readonly APIEmbed[]) => embeds.flatMap((embed) => (embed.fields ?? []).map((item) => item.name));

describe('guides', () => {
  it('have an entry for every command, and client wording exactly for what clients can run', () => {
    expect(Object.keys(GUIDE).sort()).toEqual(COMMANDS.map((command) => command.name).sort());
    for (const command of COMMANDS) expect(Boolean(GUIDE[command.name]!.client), command.name).toBe(command.access === 'everyone');
  });

  it('fit within Discord embed limits', () => {
    for (const embed of [...ownerGuide(COMMANDS), ...clientGuide(COMMANDS)]) expect(withinLimits(embed), embed.title).toBe(true);
  });

  it('the owner guide shows every command, how to type it, and marks yours', () => {
    const names = fieldNames(ownerGuide(COMMANDS));
    for (const command of COMMANDS) expect(names.some((name) => name.includes(`/${command.name}`)), command.name).toBe(true);
    expect(names).toContain('🔒 /quote amount deadline');
    expect(names).toContain('🔒 /call start | stop | retry');
    expect(names).toContain('🔒 /new-project name  ·  anywhere');
    expect(names).toContain('/ask question');
    expect(text(ownerGuide(COMMANDS))).toContain('npm run claude:connect');
  });

  it('the client guide shows only what clients can run, and explains calls, privacy and AI', () => {
    const embeds = clientGuide(COMMANDS);
    const names = fieldNames(embeds);
    for (const command of COMMANDS.filter((item) => item.access === 'everyone')) expect(names.some((name) => name.startsWith(`/${command.name}`)), command.name).toBe(true);
    for (const command of COMMANDS.filter((item) => item.access === 'owner')) expect(names.some((name) => name.startsWith(`/${command.name}`)), command.name).toBe(false);
    expect(names.some((name) => name.includes('🔒'))).toBe(false);
    expect(embeds.map((embed) => embed.title)).toEqual(expect.arrayContaining(['👋 How your project works', '📞 Calls', '🔒 Privacy and AI']));
    expect(text(embeds)).toContain('Record me');
    expect(text(embeds)).not.toContain('owner-desk');
  });

  it('are posted as embeds in their channels once, then edited in place', async () => {
    const guild = new FakeGuild('g1', 'bot-1');
    guild.addChannel('Projects', ChannelType.GuildCategory);
    const start = guild.addChannel('Start here', ChannelType.GuildCategory);
    // An older plain-text guide is turned into embeds, not left behind.
    const old = guild.addChannel('owner-guide', ChannelType.GuildText, guild.channelNamed('Projects').id);
    for (let i = 0; i < 9; i++) await old.send(`old guide part ${i}`);

    await syncGuides(guild as never, 'owner-1', COMMANDS);
    const owner = guild.channelNamed('owner-guide');
    const client = guild.channelNamed('how-it-works');
    expect(client.parentId).toBe(start.id);
    expect(owner.history.map((message) => message.embeds)).toEqual(ownerGuide(COMMANDS).map((embed) => [embed]));
    expect(owner.history.every((message) => message.content === '')).toBe(true);
    expect(client.history.map((message) => message.embeds)).toEqual(clientGuide(COMMANDS).map((embed) => [embed]));

    const everyone = guild.createdOverwrites.find((overwrite) => overwrite.id === 'g1') as { type?: number; deny?: bigint[] } | undefined;
    expect(everyone?.type).toBe(OverwriteType.Role);

    const ids = [...owner.history, ...client.history].map((message) => message.id);
    await syncGuides(guild as never, 'owner-1', COMMANDS);
    expect([...owner.history, ...client.history].map((message) => message.id)).toEqual(ids); // nothing reposted

    const fewer = COMMANDS.filter((command) => command.name !== 'ask');
    await syncGuides(guild as never, 'owner-1', fewer);
    expect(client.history.map((message) => message.embeds)).toEqual(clientGuide(fewer).map((embed) => [embed]));
    expect(client.history[0]!.id).toBe(ids[owner.history.length]); // edited, not reposted
  });
});

describe('permission overwrites', () => {
  it('always say whether they are for a member or a role, so nobody needs to be cached', async () => {
    const { ensureProjectChannel, ensureProjectVoice, grantClient, makeReadOnly, openProjectVoiceTo } = await import('../../src/discord/channels.js');
    const guild = new FakeGuild('g2', 'bot-2');
    const channel = await ensureProjectChannel(guild as never, 'alpha', 'owner-1');
    await ensureProjectVoice(guild as never, 'alpha', 'owner-1', ['client-1']);
    await grantClient(channel, 'client-2');
    await openProjectVoiceTo(guild as never, 'alpha', 'client-3');
    await makeReadOnly(channel, ['client-2'], 'test');
    expect(guild.createdOverwrites.length).toBeGreaterThan(0);
    for (const overwrite of guild.createdOverwrites) {
      expect(overwrite.type, overwrite.id).toBe(overwrite.id === 'g2' ? OverwriteType.Role : OverwriteType.Member);
    }
    const edited = [...guild.channelsById.values()].flatMap((item) => [...item.overwriteTypes.values()]);
    expect(edited.length).toBeGreaterThan(0);
    expect(edited.every((type) => type === OverwriteType.Member)).toBe(true);
  });
});
