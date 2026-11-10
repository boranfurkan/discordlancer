// Reports Tessl's pull requests back into the project channel. Every minute it looks
// at approved change requests: when Tessl's pull request appears it posts the link
// (and a review reminder in owner-desk); when Boran merges or closes it, it says so.

import { ChannelType, type Client, type Guild } from 'discord.js';
import { listChangeRequestsByStatus, updateChangeRequest, type ChangeRequest } from '../db/changes.js';
import { clientMembers, getProject, type Project } from '../db/projects.js';
import { log } from '../log.js';
import { projectScope, safeRemember } from '../services/memory.js';
import { ensureOwnerChannel, ensureProjectThread } from './channels.js';
import type { BotContext } from './command.js';
import { OWNER_NAME } from './guards.js';
import { createPreviewWatch } from './previews.js';

export const PR_WATCH_INTERVAL_MS = 60_000;
/** Previews are looked for every fifth tick: about every 5 minutes. */
const PREVIEW_EVERY = 5;

export function startPullRequestWatcher(client: Client, ctx: BotContext, intervalMs = PR_WATCH_INTERVAL_MS): () => void {
  let running = false;
  let ticks = 0;
  const previews = createPreviewWatch(ctx);
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const guild = client.guilds.cache.get(ctx.env.DISCORD_GUILD_ID);
      if (guild) {
        for (const request of await listChangeRequestsByStatus(ctx.db, ['issue_opened', 'pr_open'])) {
          await checkChangeRequest(guild, ctx, request);
        }
        if (ticks++ % PREVIEW_EVERY === 0) await previews.check(guild);
      }
    } catch (error) {
      log.warn('pull request watch failed', { error });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  void tick();
  return () => clearInterval(timer);
}

function titleOf(request: ChangeRequest): string {
  const title = request.triage?.title;
  return typeof title === 'string' && title ? title : 'the requested change';
}

/** Into the project's 🔧 Code changes thread, or the channel itself if the thread can't be made. */
async function post(guild: Guild, ctx: BotContext, project: Project, text: string): Promise<void> {
  const channel = await guild.channels.fetch(project.channel_id).catch(() => null);
  if (channel?.type !== ChannelType.GuildText) return;
  const thread = await ensureProjectThread(channel, 'code', [ctx.env.DISCORD_OWNER_ID, ...clientMembers(project)]).catch((error: unknown) => {
    log.warn('could not open the code changes thread', { project: project.name, error });
    return undefined;
  });
  await (thread ?? channel).send(text);
}

/** One change request: has its pull request appeared, been merged or been closed? */
export async function checkChangeRequest(guild: Guild, ctx: BotContext, request: ChangeRequest): Promise<void> {
  const project = await getProject(ctx.db, request.project);
  if (!project) return;
  const title = titleOf(request);
  const bot = { actor: 'bot', outcome: 'ok' } as const;

  try {
    if (request.status === 'issue_opened' && request.issue_number !== undefined) {
      const pull = await ctx.github.findPullForIssue(project.repo, request.issue_number);
      if (!pull) return;
      const moved = await updateChangeRequest(ctx.db, request, 'issue_opened', { status: 'pr_open', pr_number: pull.number }, {
        ...bot,
        action: 'change.pr_opened',
        data: { pr: pull.number, branch: pull.branch },
      });
      if (!moved) return;
      await post(guild, ctx, project, `Tessl has proposed **${title}** as pull request #${pull.number}: ${pull.url}\n${OWNER_NAME} reviews it before anything is merged.`);
      const desk = await ensureOwnerChannel(guild, ctx.env.DISCORD_OWNER_ID);
      await desk.send(`Review **${project.name}**: Tessl opened pull request #${pull.number} for "${title}". ${pull.url}`);
      return;
    }

    if (request.status === 'pr_open' && request.pr_number !== undefined) {
      const pull = await ctx.github.getPull(project.repo, request.pr_number);
      if (pull.state === 'open') return;
      const status = pull.merged ? 'merged' : 'closed';
      const moved = await updateChangeRequest(ctx.db, request, 'pr_open', { status }, {
        ...bot,
        action: pull.merged ? 'change.merged' : 'change.closed',
        data: { pr: pull.number },
      });
      if (!moved) return;
      if (pull.merged) {
        await post(guild, ctx, project, `**${title}** is done: pull request #${pull.number} has been merged.`);
        await safeRemember(ctx.memory, projectScope(project.name), `Change for ${project.name} merged: ${title} (pull request #${pull.number}).`);
      } else {
        await post(guild, ctx, project, `The proposed change **${title}** (pull request #${pull.number}) was closed without merging. ${OWNER_NAME} will follow up here.`);
      }
    }
  } catch (error) {
    log.warn('could not check a change request on GitHub', { project: project.name, error });
  }
}
