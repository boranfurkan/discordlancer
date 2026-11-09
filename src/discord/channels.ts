// Channels and their permissions. Project channels live under a hidden `Projects`
// category: invisible to @everyone, visible to the bot and Boran, and opened to one
// client each. Every function here is safe to run twice.

import {
  ChannelType,
  PermissionFlagsBits,
  type CategoryChannel,
  type Guild,
  type Invite,
  type OverwriteResolvable,
  type TextChannel,
} from 'discord.js';

export const PROJECTS_CATEGORY = 'Projects';
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
];

// Manage Roles is left out on purpose: only an Administrator can grant it in an
// overwrite. The bot's server-wide Manage Roles is enough to edit overwrites.
const BOT = [
  ...PERSON,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.CreateInstantInvite,
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
