import { ChannelType } from 'discord.js';
import { RecordId, type Surreal } from 'surrealdb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BotContext } from '../../src/discord/command.js';
import { createPreviewWatch, isSignInPage, previewPost, REPOST_AFTER_MS, shouldPost, type Reachability } from '../../src/discord/previews.js';
import { previewFrom, type PullPreview } from '../../src/services/github.js';
import { memoryDb } from '../helpers/db.js';
import { FakeGuild } from '../helpers/fakeDiscord.js';

describe('previewFrom', () => {
  it("takes the newest successful non-production deployment's address", () => {
    const found = previewFrom(
      [
        { environment: 'Production', statuses: [{ state: 'success', environment_url: 'https://app.vercel.app' }] },
        { environment: 'Preview', statuses: [{ state: 'pending' }, { state: 'success', environment_url: 'https://app-git-login-me.vercel.app' }] },
      ],
      [],
    );
    expect(found).toEqual({ url: 'https://app-git-login-me.vercel.app', environment: 'Preview' });
  });

  it("falls back to a commit status that names a preview (Netlify), but not a dashboard link", () => {
    expect(previewFrom([], [{ state: 'success', context: 'netlify/app/deploy-preview', target_url: 'https://deploy-preview-3--app.netlify.app' }])).toEqual({
      url: 'https://deploy-preview-3--app.netlify.app',
      environment: 'netlify/app/deploy-preview',
    });
    expect(previewFrom([], [{ state: 'success', context: 'Vercel – preview', target_url: 'https://vercel.com/me/app/AbC123xyz' }])).toBeUndefined();
    expect(previewFrom([], [{ state: 'pending', context: 'deploy-preview', target_url: 'https://x.netlify.app' }])).toBeUndefined();
  });
});

describe('when to post', () => {
  const now = new Date('2026-11-14T12:00:00Z');
  it('posts the first preview, and a newer one only after a while', () => {
    expect(shouldPost({ url: 'https://a' }, undefined, now)).toBe(true);
    expect(shouldPost({ url: 'https://a' }, { url: 'https://a', at: new Date(0) }, now)).toBe(false);
    expect(shouldPost({ url: 'https://b' }, { url: 'https://a', at: new Date(now.getTime() - 10 * 60_000) }, now)).toBe(false);
    expect(shouldPost({ url: 'https://b' }, { url: 'https://a', at: new Date(now.getTime() - REPOST_AFTER_MS) }, now)).toBe(true);
  });
});

let db: Surreal;
beforeAll(async () => {
  db = await memoryDb();
});
afterAll(async () => {
  await db.close();
});

describe('the preview watch', () => {
  it('posts a new preview in the 🔧 thread once, again for a newer build later, and remembers across restarts', async () => {
    const guild = new FakeGuild('g', 'bot');
    const channel = guild.addChannel('shop', ChannelType.GuildText);
    await db.query('CREATE $id CONTENT $content', {
      id: new RecordId('project', 'shop'),
      content: { name: 'shop', channel_id: channel.id, repo: 'me/shop', stage: 'in_development', client_id: 'client-1' },
    });
    let previews: PullPreview[] = [{ number: 3, title: 'Booking calendar', pullUrl: 'https://github.com/me/shop/pull/3', branch: 'calendar', sha: 'a1', url: 'https://shop-git-calendar.vercel.app', environment: 'Preview' }];
    let clock = new Date('2026-11-14T12:00:00Z');
    const ctx = { db, env: { DISCORD_OWNER_ID: 'owner' }, github: { previewsFor: async () => previews } } as unknown as BotContext;

    const watch = createPreviewWatch(ctx, () => clock, async () => 'open');
    await watch.check(guild as never);
    await watch.check(guild as never);
    const thread = guild.channelNamed('🔧 Code changes');
    expect(thread.botText()).toHaveLength(1);
    expect(thread.botText()[0]).toContain('🔗 **Preview of pull request #3:** Booking calendar\nhttps://shop-git-calendar.vercel.app');
    expect(thread.threadMembers.has('client-1')).toBe(true);

    previews = [{ ...previews[0]!, sha: 'a2', url: 'https://shop-abc.vercel.app' }];
    await watch.check(guild as never);
    expect(thread.botText()).toHaveLength(1);
    clock = new Date(clock.getTime() + REPOST_AFTER_MS);
    await watch.check(guild as never);
    expect(thread.botText()).toHaveLength(2);
    expect(thread.botText()[1]).toContain('Updated preview');

    // A restart: the new watch reads what was posted from the event log.
    await createPreviewWatch(ctx, () => clock, async () => 'open').check(guild as never);
    expect(thread.botText()).toHaveLength(2);
  });

  it("holds back a preview behind a sign-in, tells the owner once, and posts it once it opens", async () => {
    const guild = new FakeGuild('g2', 'bot');
    const channel = guild.addChannel('cafe', ChannelType.GuildText);
    await db.query('CREATE $id CONTENT $content', { id: new RecordId('project', 'cafe'), content: { name: 'cafe', channel_id: channel.id, repo: 'me/cafe', stage: 'paid' } });
    const ctx = {
      db,
      env: { DISCORD_OWNER_ID: 'owner' },
      github: { previewsFor: async () => [{ number: 5, title: 'Menu', pullUrl: 'p', branch: 'menu', sha: 's', url: 'https://cafe-x.vercel.app', environment: 'Preview' }] },
    } as unknown as BotContext;
    let reach: Reachability = 'protected';
    const watch = createPreviewWatch(ctx, () => new Date(), async () => reach);
    await watch.check(guild as never);
    await watch.check(guild as never);
    expect(() => guild.channelNamed('🔧 Code changes')).toThrow();
    expect(guild.channelNamed('owner-desk').botText()).toHaveLength(1);
    expect(guild.channelNamed('owner-desk').botText()[0]).toContain('Deployment Protection');
    reach = 'open';
    await watch.check(guild as never);
    expect(guild.channelNamed('🔧 Code changes').botText()).toHaveLength(1);
  });

  it("knows Vercel's and Cloudflare's sign-in pages", () => {
    expect(isSignInPage('https://vercel.com/login?next=x')).toBe(true);
    expect(isSignInPage('https://me.cloudflareaccess.com/cdn-cgi/access/login')).toBe(true);
    expect(isSignInPage('https://cafe-x.vercel.app/menu')).toBe(false);
  });

  it('marks the post as a preview that may use test data', () => {
    expect(previewPost({ number: 1, title: 't', pullUrl: 'p', branch: 'b', sha: 's', url: 'https://x', environment: 'Preview' }, false)).toContain('may use test data');
  });
});
