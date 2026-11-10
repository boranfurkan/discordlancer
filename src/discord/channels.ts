// Channels and their permissions. Project channels live under a hidden `Projects`
// category: invisible to @everyone, visible to the bot and Boran, and opened to one
// client each. Every function here is safe to run twice.

import {
  ChannelType,
  PermissionFlagsBits,
  ThreadAutoArchiveDuration,
  type CategoryChannel,
  type Guild,
  type Invite,
  type OverwriteResolvable,
  type TextChannel,
  type ThreadChannel,
  type VoiceChannel,
} from 'discord.js';

export const PROJECTS_CATEGORY = 'Projects';
export const CLIENT_ROLE = 'Client';
export const OWNER_CHANNEL = 'owner-desk';
export const INVITE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

const PERSON = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.UseApplicationCommands,
  // Replies in the project's threads (calls, code changes, progress updates).
  PermissionFlagsBits.SendMessagesInThreads,
];

// Manage Roles is left out on purpose: only an Administrator can grant it in an
// overwrite. The bot's server-wide Manage Roles is enough to edit overwrites.
const BOT = [
  ...PERSON,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.CreateInstantInvite,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.ManageThreads,
];

function botId(guild: Guild): string {
  const me = guild.members.me;
  if (!me) throw new Error('The bot is not a member of this server');
  return me.id;
}

function privateOverwrites(guild: Guild, ownerId: string): OverwriteResolvable[] {
  return [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: botId(guild), allow: BOT },
    { id: ownerId, allow: PERSON },
  ];
}

export async function ensureProjectsCategory(guild: Guild, ownerId: string): Promise<CategoryChannel> {
  const channels = await guild.channels.fetch();
  const existing = channels.find(
    (channel): channel is CategoryChannel => channel?.type === ChannelType.GuildCategory && channel.name === PROJECTS_CATEGORY,
  );
  if (existing) return existing;
  return guild.channels.create({
    name: PROJECTS_CATEGORY,
    type: ChannelType.GuildCategory,
    permissionOverwrites: privateOverwrites(guild, ownerId),
    reason: 'Discordlancer: category for private project channels',
  });
}

async function ensurePrivateText(guild: Guild, name: string, ownerId: string, topic: string): Promise<TextChannel> {
  const category = await ensureProjectsCategory(guild, ownerId);
  const channels = await guild.channels.fetch();
  const existing = channels.find(
    (channel): channel is TextChannel =>
      channel?.type === ChannelType.GuildText && channel.name === name && channel.parentId === category.id,
  );
  if (existing) return existing;
  return guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: category.id,
    topic,
    permissionOverwrites: privateOverwrites(guild, ownerId),
    reason: `Discordlancer: channel for ${name}`,
  });
}

export function ensureProjectChannel(guild: Guild, name: string, ownerId: string): Promise<TextChannel> {
  return ensurePrivateText(guild, name, ownerId, `Discordlancer project: ${name}`);
}

/** A channel only Boran and the bot can see: notices, ambiguous joins, evidence exports. */
export function ensureOwnerChannel(guild: Guild, ownerId: string): Promise<TextChannel> {
  return ensurePrivateText(guild, OWNER_CHANNEL, ownerId, 'Discordlancer notices for the owner only');
}

const VOICE_PERSON = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
  PermissionFlagsBits.UseVAD,
  PermissionFlagsBits.Stream,
];

/**
 * The project's private voice channel, named like its text channel: Boran, the bot
 * and the client (once joined) can see it. Made the first time a call starts.
 */
export async function ensureProjectVoice(guild: Guild, name: string, ownerId: string, clientIds: readonly string[] = []): Promise<VoiceChannel> {
  const category = await ensureProjectsCategory(guild, ownerId);
  const channels = await guild.channels.fetch();
  let voice = channels.find(
    (channel): channel is VoiceChannel => channel?.type === ChannelType.GuildVoice && channel.name === name && channel.parentId === category.id,
  );
  voice ??= await guild.channels.create({
    name,
    type: ChannelType.GuildVoice,
    parent: category.id,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: botId(guild), allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] },
      { id: ownerId, allow: VOICE_PERSON },
    ],
    reason: `Discordlancer: voice channel for ${name}`,
  });
  for (const clientId of clientIds) {
    if (voice.permissionOverwrites.cache.has(clientId)) continue;
    await voice.permissionOverwrites.edit(clientId, Object.fromEntries(VOICE_PERSON.map((flag) => [permissionName(flag), true])), {
      reason: 'Discordlancer: the client can join project calls',
    });
  }
  return voice;
}

/** Lets someone who joined later into the project's voice channel, if it exists yet. */
export async function openProjectVoiceTo(guild: Guild, name: string, userId: string): Promise<void> {
  const channels = await guild.channels.fetch();
  const voice = channels.find((channel): channel is VoiceChannel => channel?.type === ChannelType.GuildVoice && channel.name === name);
  await voice?.permissionOverwrites.edit(userId, Object.fromEntries(VOICE_PERSON.map((flag) => [permissionName(flag), true])), {
    reason: 'Discordlancer: a client team member joined',
  });
}

/** Threads in each project channel, so the main chat stays a conversation. */
export type ThreadKind = 'calls' | 'code' | 'updates';
export const THREAD_NAMES: Record<ThreadKind, string> = {
  calls: '📞 Calls',
  code: '🔧 Code changes',
  updates: '📈 Progress updates',
};

async function findThread(channel: TextChannel, name: string): Promise<ThreadChannel | undefined> {
  const active = await channel.threads.fetchActive();
  const found = active.threads.find((thread) => thread.parentId === channel.id && thread.name === name);
  if (found) return found;
  const archived = await channel.threads.fetchArchived({ type: 'public', limit: 50 });
  return archived.threads.find((thread) => thread.name === name);
}

/**
 * The project's thread for one kind of post, made the first time (or reopened if it
 * was archived), with everyone on the project added so they are notified.
 */
export async function ensureProjectThread(channel: TextChannel, kind: ThreadKind, memberIds: readonly string[]): Promise<ThreadChannel> {
  const name = THREAD_NAMES[kind];
  let thread = await findThread(channel, name);
  if (thread?.archived) await thread.setArchived(false, 'Discordlancer: a new post');
  thread ??= await channel.threads.create({
    name,
    type: ChannelType.PublicThread,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    reason: `Discordlancer: ${name} for ${channel.name}`,
  });
  for (const id of memberIds) await thread.members.add(id).catch(() => undefined);
  return thread;
}

/** Adds someone who joined later to the project's threads that exist already. */
export async function addToProjectThreads(channel: TextChannel, userId: string): Promise<void> {
  for (const name of Object.values(THREAD_NAMES)) {
    const thread = await findThread(channel, name).catch(() => undefined);
    await thread?.members.add(userId).catch(() => undefined);
  }
}

/** One use, seven days, always a new code, so each invite points at exactly one project. */
export function createProjectInvite(channel: TextChannel, projectName: string): Promise<Invite> {
  return channel.createInvite({
    maxAge: INVITE_MAX_AGE_SECONDS,
    maxUses: 1,
    unique: true,
    reason: `Discordlancer: client invite for ${projectName}`,
  });
}

export async function grantClient(channel: TextChannel, userId: string): Promise<void> {
  await channel.permissionOverwrites.edit(
    userId,
    Object.fromEntries(PERSON.map((flag) => [permissionName(flag), true])),
    { reason: 'Discordlancer: client joined their project' },
  );
}

/** Lets these people keep reading but stops them sending messages. */
export async function makeReadOnly(channel: TextChannel, userIds: readonly string[], reason: string): Promise<void> {
  for (const userId of userIds) {
    await channel.permissionOverwrites.edit(
      userId,
      { SendMessages: false, AddReactions: false, UseApplicationCommands: false },
      { reason },
    );
  }
}

// PermissionFlagsBits maps names to bits; overwrites edit by name.
function permissionName(flag: bigint): string {
  const entry = Object.entries(PermissionFlagsBits).find(([, bit]) => bit === flag);
  if (!entry) throw new Error(`Unknown permission bit ${flag}`);
  return entry[0];
}

/**
 * Gives a member the Client role (created by scripts/setup-server.mjs). Best-effort:
 * the role is a label, and channel access never depends on it.
 */
export async function giveClientRole(guild: Guild, userId: string): Promise<boolean> {
  const roles = await guild.roles.fetch();
  const role = roles.find((candidate) => candidate.name === CLIENT_ROLE);
  if (!role) return false;
  await guild.members.addRole({ user: userId, role: role.id, reason: 'Discordlancer: client joined their project' });
  return true;
}
