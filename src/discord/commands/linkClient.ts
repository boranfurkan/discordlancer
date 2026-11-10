// /link-client user: the fallback when join tracking missed a client, for example
// because the bot was restarting when they joined.

import { ChannelType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { requireProject, UserError, type Command } from '../command.js';
import { isClientMember } from '../../db/projects.js';
import { addTeamMember, attachClient } from '../joins.js';

const description = "Give a member access to this project as its client, or as one more person on the client's team";

export const linkClient: Command = {
  name: 'link-client',
  description,
  access: 'owner',
  where: 'project',
  stages: ['created', 'joined', 'specs_agreed', 'quote_accepted', 'paid', 'in_development', 'delivered', 'support'],
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

    if (isClientMember(project, user.id)) throw new UserError(`<@${user.id}> is already on this project.`);

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (project.stage === 'created') {
      await attachClient(ctx, interaction.guild, project, interaction.channel, user.id, 'linked', interaction.user.id);
      await interaction.editReply(`Linked <@${user.id}> as the client of **${project.name}**.`);
    } else {
      await addTeamMember(ctx, interaction.guild, project, interaction.channel, user.id, 'linked', interaction.user.id);
      await interaction.editReply(`Added <@${user.id}> to the client's team on **${project.name}**.`);
    }
  },
};
