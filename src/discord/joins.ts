// Join tracking. Each project invite is single-use, so Discord deletes it once it's
// used. When someone joins, the project whose invite has just disappeared (and
// hadn't expired) is theirs. The database is the source of truth, so this keeps
// working across restarts. If it isn't clear, Boran links the client by hand.

import { ChannelType, type GuildMember, type TextChannel } from 'discord.js';
import { listProjectsInStage, moveStage, type Project } from '../db/projects.js';
import { log } from '../log.js';
import { ensureOwnerChannel, grantClient, INVITE_MAX_AGE_SECONDS } from './channels.js';
import { safeRecord } from './client.js';
import type { BotContext } from './command.js';
import { welcomeText } from './texts.js';

export interface JoinCandidate {
  name: string;
  inviteCode: string;
  createdAt: Date;
}

export type JoinMatch = { kind: 'one'; name: string } | { kind: 'none' } | { kind: 'many'; names: string[] };

/** Pure: which project's invite was just used, given the invites that still exist. */
export function matchJoin(
  candidates: readonly JoinCandidate[],
  liveCodes: ReadonlySet<string>,
  now: Date,
  maxAgeMs = INVITE_MAX_AGE_SECONDS * 1000,
): JoinMatch {
  const used = candidates.filter(
    (candidate) => !liveCodes.has(candidate.inviteCode) && now.getTime() - candidate.createdAt.getTime() < maxAgeMs,
  );
  if (used.length === 1 && used[0]) return { kind: 'one', name: used[0].name };
  if (used.length === 0) return { kind: 'none' };
  return { kind: 'many', names: used.map((candidate) => candidate.name) };
}

function candidatesFrom(projects: readonly Project[]): JoinCandidate[] {
  return projects.flatMap((project) =>
    project.invite_code ? [{ name: project.name, inviteCode: project.invite_code, createdAt: project.created_at }] : [],
  );
}

/** Opens the project to its client and records the join. Shared with /link-client. */
export async function attachClient(
  ctx: BotContext,
  project: Project,
  channel: TextChannel,
  clientId: string,
  how: 'invite' | 'linked',
  linkedBy?: string,
): Promise<void> {
  await grantClient(channel, clientId);
  await moveStage(
    ctx.db,
    project,
    'created',
    'joined',
    how === 'invite'
      ? { actor: 'client', actorId: clientId, action: 'project.client_joined', outcome: 'ok', data: { how } }
      : { actor: 'owner', actorId: linkedBy, action: 'project.client_linked', outcome: 'ok', data: { how, client_id: clientId } },
    { client_id: clientId },
  );
  await channel.send(welcomeText(clientId));
}

export async function onMemberAdd(member: GuildMember, ctx: BotContext): Promise<void> {
  if (member.guild.id !== ctx.env.DISCORD_GUILD_ID || member.user.bot || member.id === ctx.env.DISCORD_OWNER_ID) return;
  try {
    const projects = await listProjectsInStage(ctx.db, 'created');
    const invites = await member.guild.invites.fetch();
    const match = matchJoin(candidatesFrom(projects), new Set(invites.keys()), new Date());
    log.info('member joined', { member: member.id, match: match.kind });

    if (match.kind === 'one') {
      const project = projects.find((candidate) => candidate.name === match.name);
      const channel = project ? await member.guild.channels.fetch(project.channel_id) : null;
      if (project && channel?.type === ChannelType.GuildText) {
        await attachClient(ctx, project, channel, member.id, 'invite');
        return;
      }
    }

    const owner = await ensureOwnerChannel(member.guild, ctx.env.DISCORD_OWNER_ID);
    const detail =
      match.kind === 'many'
        ? `More than one project invite was used at about the same time (${match.names.join(', ')}).`
        : "No project invite matched, so they may have used another invite.";
    await owner.send(
      `<@${member.id}> joined the server. ${detail} If they're a client, run /link-client in their project channel.`,
    );
    await safeRecord(ctx, {
      actor: 'bot',
      action: 'member.join_unmatched',
      outcome: 'refused',
      data: { member_id: member.id, match: match.kind, ...(match.kind === 'many' ? { projects: match.names } : {}) },
    });
  } catch (error) {
    log.error('handling a join failed', { member: member.id, error });
    await safeRecord(ctx, { actor: 'bot', action: 'member.join_failed', outcome: 'failed', data: { member_id: member.id } });
  }
}
