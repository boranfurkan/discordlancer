// /new-project name: a private channel, a single-use invite and a private repo, all
// named after the project. Safe to run twice: existing pieces are found and reused,
// and a project still waiting for its client just gets a fresh invite.

import { ChannelType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { createProject, getProjectByName, updateProject } from '../../db/projects.js';
import { checkProjectName } from '../../domain/names.js';
import { GitHubError } from '../../services/github.js';
import { createProjectInvite, ensureProjectChannel } from '../channels.js';
import { UserError, type Command } from '../command.js';

const description = 'Start a project: private channel, client invite and GitHub repo';

export const newProject: Command = {
  name: 'new-project',
  description,
  access: 'owner',
  where: 'anywhere',
  definition: new SlashCommandBuilder()
    .setName('new-project')
    .setDescription(description)
    .addStringOption((option) =>
      option.setName('name').setDescription('Project name, like atmaca-personal-website').setRequired(true).setMaxLength(80),
    )
    .toJSON(),

  async execute({ interaction, ctx }) {
    const check = checkProjectName(interaction.options.getString('name', true));
    if (!check.ok) throw new UserError(`That name won't work: ${check.reason}.`);
    const { name } = check;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const ownerId = ctx.env.DISCORD_OWNER_ID;
    const existing = await getProjectByName(ctx.db, name);
    if (existing && existing.stage !== 'created') {
      throw new UserError(`A project called **${name}** already exists: <#${existing.channel_id}>.`);
    }

    let channel;
    if (existing) {
      const found = await interaction.guild.channels.fetch(existing.channel_id).catch(() => null);
      if (found?.type !== ChannelType.GuildText) {
        throw new UserError(`The channel for **${name}** is missing. Ask for help before going on.`);
      }
      channel = found;
    } else {
      channel = await ensureProjectChannel(interaction.guild, name, ownerId);
    }

    let repo;
    try {
      repo = await ctx.github.ensureRepo(name, `Discordlancer project: ${name}`);
    } catch (error) {
      if (error instanceof GitHubError) throw new UserError(error.message);
      throw error;
    }

    const invite = await createProjectInvite(channel, name);
    const event = {
      actor: 'owner',
      actorId: interaction.user.id,
      outcome: 'ok',
      data: { repo: repo.fullName, repo_created: repo.created, channel_id: channel.id },
    } as const;

    if (existing) {
      await updateProject(ctx.db, existing, { invite_code: invite.code }, { ...event, action: 'project.invite_renewed' });
      // Retire the old invite, so only the new one can open this project.
      if (existing.invite_code && existing.invite_code !== invite.code) {
        await interaction.guild.invites.delete(existing.invite_code, 'Discordlancer: replaced by a fresh invite').catch(() => {
          // Already used up, expired or deleted: nothing to retire.
        });
      }
    } else {
      await createProject(
        ctx.db,
        { name, channelId: channel.id, repo: repo.fullName, inviteCode: invite.code },
        { ...event, action: 'project.created' },
      );
      await channel.send(`Project **${name}** started. Repo: ${repo.url}\nWaiting for the client to join.`);
    }

    await interaction.editReply(
      [
        existing ? `**${name}** was already set up, so here's a fresh invite.` : `Created **${name}**.`,
        `- Channel: <#${channel.id}>`,
        `- Repo: ${repo.url}`,
        `- Invite for the client (one use, valid 7 days): ${invite.url}`,
        '',
        'Send the invite to the client yourself. When they join, the bot opens this channel to them and welcomes them.',
      ].join('\n'),
    );
  },
};
