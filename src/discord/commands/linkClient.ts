// /link-client user: the fallback when join tracking missed a client, for example
// because the bot was restarting when they joined.

import { ChannelType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { requireProject, UserError, type Command } from '../command.js';
import { attachClient } from '../joins.js';

const description = "Give a member access to this project as its client";

export const linkClient: Command = {
  name: 'link-client',
  description,
  access: 'owner',
  where: 'project',
  stages: ['created'],
  definition: new SlashCommandBuilder()
    .setName('link-client')
    .setDescription(description)
    .addUserOption((option) => option.setName('user').setDescription('The client').setRequired(true))
    .toJSON(),

  async execute(run) {
    const project = requireProject(run);
    const { interaction, ctx } = run;
    const user = interaction.options.getUser('user', true);
    if (user.bot) throw new UserError("A bot can't be a client.");
    if (user.id === ctx.env.DISCORD_OWNER_ID) throw new UserError("You can't be the client of your own project.");

    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) throw new UserError(`<@${user.id}> isn't in this server yet. Send them the invite first.`);
    if (interaction.channel?.type !== ChannelType.GuildText) throw new UserError('Run this in the project channel.');

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await attachClient(ctx, interaction.guild, project, interaction.channel, user.id, 'linked', interaction.user.id);
    await interaction.editReply(`Linked <@${user.id}> as the client of **${project.name}**.`);
  },
};
