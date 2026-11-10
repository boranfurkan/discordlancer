import { ChannelType } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../../src/discord/commands/index.js';
import { GUIDE_DETAILS, ownerGuide, syncOwnerGuide } from '../../src/discord/guide.js';
import { FakeGuild } from '../helpers/fakeDiscord.js';

describe('owner guide', () => {
  it('has an entry for every command, and none for commands that are gone', () => {
    expect(Object.keys(GUIDE_DETAILS).sort()).toEqual(COMMANDS.map((command) => command.name).sort());
  });

  it('fits Discord, shows how to type each command, and keeps yours apart', () => {
    const messages = ownerGuide(COMMANDS);
    expect(messages.every((message) => message.length <= 2_000)).toBe(true);
    const all = messages.join('\n');
    for (const command of COMMANDS) expect(all).toContain(`/${command.name}`);
    expect(all).toContain('**`/quote amount deadline`**');
    expect(all).toContain('**`/call start | stop | retry`**');
    expect(all).toContain('**`/confirm-delivery [note]`**');
    expect(all).toContain('**`/new-project name`** *(anywhere)*');
    const yours = all.slice(all.indexOf('**Your commands**'), all.indexOf('**Commands for everyone in a project**'));
    expect(yours).toContain('/sync-docs');
    expect(yours).not.toContain('`/ask question`');
    expect(all).toContain('npm run claude:connect');
  });

  it('is posted in a private channel once, then edited in place when commands change', async () => {
    const guild = new FakeGuild('g1', 'bot-1');
    guild.addChannel('Projects', ChannelType.GuildCategory);
    await syncOwnerGuide(guild as never, 'owner-1', COMMANDS);
    const channel = guild.channelNamed('owner-guide');
    const first = channel.botText();
    expect(first).toEqual(ownerGuide(COMMANDS));
    const ids = channel.history.map((message) => message.id);

    await syncOwnerGuide(guild as never, 'owner-1', COMMANDS);
    expect(channel.history.map((message) => message.id)).toEqual(ids); // nothing new

    const fewer = COMMANDS.filter((command) => command.access === 'everyone');
    await syncOwnerGuide(guild as never, 'owner-1', fewer);
    expect(channel.botText()).toEqual(ownerGuide(fewer));
    expect(channel.history[0]!.id).toBe(ids[0]); // edited, not reposted
  });
});

describe('permission overwrites', () => {
  it('always say whether they are for a member or a role, so nobody needs to be cached', async () => {
    const { OverwriteType } = await import('discord.js');
    const { ensureProjectChannel, ensureProjectVoice, grantClient, makeReadOnly, openProjectVoiceTo } = await import('../../src/discord/channels.js');
    const guild = new FakeGuild('g2', 'bot-2');
    const text = await ensureProjectChannel(guild as never, 'alpha', 'owner-1');
    await ensureProjectVoice(guild as never, 'alpha', 'owner-1', ['client-1']);
    await grantClient(text, 'client-2');
    await openProjectVoiceTo(guild as never, 'alpha', 'client-3');
    await makeReadOnly(text, ['client-2'], 'test');
    expect(guild.createdOverwrites.length).toBeGreaterThan(0);
    for (const overwrite of guild.createdOverwrites) {
      expect(overwrite.type, overwrite.id).toBe(overwrite.id === 'g2' ? OverwriteType.Role : OverwriteType.Member);
    }
    const edited = [...guild.channelsById.values()].flatMap((channel) => [...channel.overwriteTypes.values()]);
    expect(edited.length).toBeGreaterThan(0);
    expect(edited.every((type) => type === OverwriteType.Member)).toBe(true);
  });
});
