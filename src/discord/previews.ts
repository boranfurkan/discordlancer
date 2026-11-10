// Live previews of pull requests, posted in the project's 🔧 Code changes thread. When a
// project's repo is connected to a host such as Vercel, Netlify or Cloudflare Pages, the
// host builds each pull request and reports its address to GitHub; the bot reads it there
// (no keys of its own) so the client can try the change before it's merged.

import { ChannelType, type Guild } from 'discord.js';
import { eventsForProject, recordEvent } from '../db/events.js';
import { clientMembers, listProjectsInStage, type Project } from '../db/projects.js';
import type { Stage } from '../domain/stages.js';
import { log } from '../log.js';
import type { PullPreview } from '../services/github.js';
import { fetchPublic, LinkError } from '../files/links.js';
import { ensureOwnerChannel, ensureProjectThread } from './channels.js';
import type { BotContext } from './command.js';
import { OWNER_NAME } from './guards.js';

/** Stages where work is being built or changed. */
export const PREVIEW_STAGES: readonly Stage[] = ['paid', 'in_development', 'delivered', 'support'];
export const PREVIEW_ACTION = 'preview.posted';
/** A pull request's preview is posted again for a newer build only after this long, so pushes don't flood the thread. */
export const REPOST_AFTER_MS = 2 * 60 * 60 * 1000;

export interface PostedPreview {
  url: string;
  at: Date;
}

/** Pure: whether to post this preview, given what was last posted for the pull request. */
export function shouldPost(preview: Pick<PullPreview, 'url'>, last: PostedPreview | undefined, now: Date): boolean {
  if (!last) return true;
  return last.url !== preview.url && now.getTime() - last.at.getTime() >= REPOST_AFTER_MS;
}

/** Pure: the post in the 🔧 thread. */
export function previewPost(preview: PullPreview, again: boolean): string {
  return [
    `🔗 **${again ? 'Updated preview' : 'Preview'} of pull request #${preview.number}:** ${preview.title}`,
    preview.url,
    `Try it here before it's merged, and say in the channel if anything looks wrong. ${OWNER_NAME} merges it once it's right.`,
    `-# A live preview built by the hosting service (${preview.environment}) from the latest change. It may use test data. Pull request: ${preview.pullUrl}`,
  ].join('\n');
}

export type Reachability = 'open' | 'protected' | 'unknown';

/** Pure: whether a preview's final address is a sign-in page (Vercel's protection, Cloudflare Access). */
export function isSignInPage(finalUrl: string): boolean {
  const url = new URL(finalUrl);
  return url.hostname === 'vercel.com' || url.hostname.endsWith('.cloudflareaccess.com') || /\/(login|sso|signin)/i.test(url.pathname);
}

/** Opens the preview as a signed-out visitor would. */
export async function probePreview(url: string): Promise<Reachability> {
  try {
    const page = await fetchPublic(url);
    return isSignInPage(page.url) ? 'protected' : 'open';
  } catch (error) {
    if (error instanceof LinkError && /sign-in/.test(error.message)) return 'protected';
    return 'unknown';
  }
}

export interface PreviewWatch {
  /** Checks every active project once. Never throws. */
  check(guild: Guild): Promise<void>;
}

export function createPreviewWatch(ctx: BotContext, now: () => Date = () => new Date(), probe: (url: string) => Promise<Reachability> = probePreview): PreviewWatch {
  // What was posted per project and pull request; loaded from the event log the first time.
  const posted = new Map<string, Map<number, PostedPreview>>();
  const refused = new Set<string>();
  const heldBack = new Set<string>();

  async function postedFor(project: Project): Promise<Map<number, PostedPreview>> {
    const known = posted.get(project.name);
    if (known) return known;
    const map = new Map<number, PostedPreview>();
    for (const event of await eventsForProject(ctx.db, project.id)) {
      if (event.action !== PREVIEW_ACTION || typeof event.data?.pr !== 'number' || typeof event.data.url !== 'string') continue;
      map.set(event.data.pr, { url: event.data.url, at: event.at });
    }
    posted.set(project.name, map);
    return map;
  }

  async function checkProject(guild: Guild, project: Project): Promise<void> {
    let previews: PullPreview[];
    try {
      previews = await ctx.github.previewsFor(project.repo);
    } catch (error) {
      const status = typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : undefined;
      if (status === 403 && !refused.has(project.name)) {
        refused.add(project.name);
        const desk = await ensureOwnerChannel(guild, ctx.env.DISCORD_OWNER_ID).catch(() => undefined);
        await desk
          ?.send(`GitHub refused to show **${project.name}**'s deployments to the bot, so preview links can't be posted. The bot's token needs the classic \`repo\` scope (it covers deployments and commit statuses).`)
          .catch(() => undefined);
      }
      log.warn('could not check previews', { project: project.name, status });
      return;
    }
    if (previews.length === 0) return;
    const map = await postedFor(project);
    const channel = await guild.channels.fetch(project.channel_id).catch(() => null);
    if (channel?.type !== ChannelType.GuildText) return;
    for (const preview of previews) {
      const last = map.get(preview.number);
      if (!shouldPost(preview, last, now())) continue;
      // A link the client can't open is no use to them: hold it back, and tell Boran once how to open it up.
      if ((await probe(preview.url)) === 'protected') {
        const key = `${project.name}:${preview.number}`;
        if (!heldBack.has(key)) {
          heldBack.add(key);
          const desk = await ensureOwnerChannel(guild, ctx.env.DISCORD_OWNER_ID).catch(() => undefined);
          await desk
            ?.send(
              `**${project.name}**: the preview of pull request #${preview.number} is behind a sign-in, so the client can't open it, and I haven't posted it. On Vercel: the project's **Settings → Deployment Protection**, turn off **Vercel Authentication** (or use a shareable link). It's posted by itself once it opens. ${preview.url}`,
            )
            .catch(() => undefined);
        }
        continue;
      }
      const thread = await ensureProjectThread(channel, 'code', [ctx.env.DISCORD_OWNER_ID, ...clientMembers(project)]);
      await thread.send({ content: previewPost(preview, last !== undefined), allowedMentions: { parse: [] } });
      map.set(preview.number, { url: preview.url, at: now() });
      await recordEvent(ctx.db, { actor: 'bot', action: PREVIEW_ACTION, outcome: 'ok', project: project.id, data: { pr: preview.number, sha: preview.sha, url: preview.url } }).catch((error: unknown) =>
        log.error('could not record a preview', { error }),
      );
    }
  }

  return {
    async check(guild) {
      try {
        const projects = (await Promise.all(PREVIEW_STAGES.map((stage) => listProjectsInStage(ctx.db, stage)))).flat();
        for (const project of projects) await checkProject(guild, project).catch((error: unknown) => log.warn('preview check failed', { project: project.name, error }));
      } catch (error) {
        log.warn('preview watch failed', { error });
      }
    },
  };
}
