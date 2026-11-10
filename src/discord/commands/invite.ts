// /invite: an invite for one more person on the client's team (a CEO, a CTO, a
// marketing lead). One use, seven days, one per person. Whoever joins with it is on
// the client's side: they can chat, use /ask, join calls, and agree for their team.

import { ChannelType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { saveInvite } from '../../db/invites.js';
import { createProjectInvite } from '../channels.js';
import { requireProject, UserError, type Command } from '../command.js';

const description = "Make an invite for one more person on the client's team (one use, 7 days)";

export const teamInvite: Command = {
  name: 'invite',
  description,
  access: 'owner',
  where: 'project',
  stages: ['created', 'joined', 'specs_agreed', 'quote_accepted', 'paid', 'in_development', 'delivered', 'support'],
  definition: new SlashCommandBuilder().setName('invite').setDescription(description).toJSON(),

  async execute(run) {
    const project = requireProject(run);
    const { interaction, ctx } = run;
    if (interaction.channel?.type !== ChannelType.GuildText) throw new UserError('Run this in the project channel.');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const invite = await createProjectInvite(interaction.channel, project.name);
    await saveInvite(ctx.db, project, invite.code, { actor: 'owner', actorId: interaction.user.id, action: 'project.team_invite_created', outcome: 'ok' });
    await interaction.editReply(
      [
        `Invite for one more person on **${project.name}**'s team (one use, valid 7 days): ${invite.url}`,
        'Make one per person. Whoever joins with it sees this channel and its threads, can use /ask and join calls, and can agree specs, quotes and the delivery for their team.',
      ].join('\n'),
    );
  },
};
