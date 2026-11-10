// Join tracking. Each project invite is single-use, so Discord deletes it once it's
// used. When someone joins, the project whose invite has just disappeared (and
// hadn't expired) is theirs: the project's first invite (from /new-project) makes
// them its client, and a team invite (from /invite) adds them to the client's team.
// The database is the source of truth, so this keeps working across restarts. If it
// isn't clear, Boran links them by hand with /link-client.

import { ChannelType, type Guild, type GuildMember, type TextChannel } from 'discord.js';
import { markInviteUsed, openInvites, type Invite } from '../db/invites.js';
import { addClientMember, getProjectByName, isClientMember, listProjectsInStage, moveStage, type Project } from '../db/projects.js';
import { isClosed } from '../domain/stages.js';
import { log } from '../log.js';
import { addToProjectThreads, ensureOwnerChannel, giveClientRole, grantClient, INVITE_MAX_AGE_SECONDS, openProjectVoiceTo } from './channels.js';
import { safeRecord } from './client.js';
import type { BotContext } from './command.js';
import { teamWelcomeText, welcomeText } from './texts.js';

export interface JoinCandidate {
  name: string;
  inviteCode: string;
  createdAt: Date;
  /** Set for a team invite (from /invite). */
  invite?: Invite;
}

export type JoinMatch = { kind: 'one'; name: string; inviteCode: string } | { kind: 'none' } | { kind: 'many'; names: string[] };

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
  if (used.length === 1 && used[0]) return { kind: 'one', name: used[0].name, inviteCode: used[0].inviteCode };
  if (used.length === 0) return { kind: 'none' };
  return { kind: 'many', names: used.map((candidate) => candidate.name) };
}

function candidatesFrom(projects: readonly Project[]): JoinCandidate[] {
  return projects.flatMap((project) =>
    project.invite_code ? [{ name: project.name, inviteCode: project.invite_code, createdAt: project.created_at }] : [],
  );
}

/** Team invites as join candidates, under their project's name. */
function teamCandidates(invites: readonly Invite[]): JoinCandidate[] {
  return invites.map((invite) => ({ name: String(invite.project.id), inviteCode: invite.code, createdAt: invite.created_at, invite }));
}

/**
 * Adds one more person to the client's team: the channel, the voice channel and the
 * threads open to them, they get the Client role, and are welcomed. Shared with /link-client.
 */
export async function addTeamMember(
  ctx: BotContext,
  guild: Guild,
  project: Project,
  channel: TextChannel,
  userId: string,
  how: 'invite' | 'linked',
  linkedBy?: string,
): Promise<void> {
  if (isClientMember(project, userId)) return;
  await grantClient(channel, userId);
  await openProjectVoiceTo(guild, project.name, userId).catch((error: unknown) => log.warn('could not open the voice channel to a team member', { error }));
  await addToProjectThreads(channel, userId).catch((error: unknown) => log.warn('could not add a team member to the threads', { error }));
  await addClientMember(
    ctx.db,
    project,
    userId,
    how === 'invite'
      ? { actor: 'client', actorId: userId, action: 'project.member_joined', outcome: 'ok', data: { how } }
      : { actor: 'owner', actorId: linkedBy, action: 'project.member_linked', outcome: 'ok', data: { how, member_id: userId } },
  );
  await channel.send({ content: teamWelcomeText(userId, project.name), allowedMentions: { users: [userId] } });
  try {
    if (!(await giveClientRole(guild, userId))) log.warn('no Client role to give; run scripts/setup-server.mjs');
  } catch (error) {
    log.warn('could not give the Client role', { error });
  }
}

/** Opens the project to its client and records the join. Shared with /link-client. */
export async function attachClient(
  ctx: BotContext,
  guild: Guild,
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
  try {
    if (!(await giveClientRole(guild, clientId))) log.warn('no Client role to give; run scripts/setup-server.mjs');
  } catch (error) {
    log.warn('could not give the Client role', { error });
  }
}

export async function onMemberAdd(member: GuildMember, ctx: BotContext): Promise<void> {
  if (member.guild.id !== ctx.env.DISCORD_GUILD_ID || member.user.bot || member.id === ctx.env.DISCORD_OWNER_ID) return;
  try {
    const projects = await listProjectsInStage(ctx.db, 'created');
    const candidates = [...candidatesFrom(projects), ...teamCandidates(await openInvites(ctx.db))];
    const invites = await member.guild.invites.fetch();
    const match = matchJoin(candidates, new Set(invites.keys()), new Date());
    log.info('member joined', { member: member.id, match: match.kind });

    if (match.kind === 'one') {
      const teamInvite = candidates.find((candidate) => candidate.inviteCode === match.inviteCode)?.invite;
      const project = await getProjectByName(ctx.db, match.name);
      const channel = project ? await member.guild.channels.fetch(project.channel_id) : null;
      if (project && !isClosed(project.stage) && channel?.type === ChannelType.GuildText) {
        if (project.stage === 'created') await attachClient(ctx, member.guild, project, channel, member.id, 'invite');
        else await addTeamMember(ctx, member.guild, project, channel, member.id, 'invite');
        if (teamInvite) await markInviteUsed(ctx.db, teamInvite, member.id).catch((error: unknown) => log.warn('could not mark a team invite used', { error }));
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
