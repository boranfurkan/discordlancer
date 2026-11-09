// /cancel and /archive. Both need `confirm: True`. Nothing is deleted: the channel
// stays, the client can still read it but no longer write, and history is kept.

import { ChannelType, SlashCommandBuilder } from 'discord.js';
import { moveStage } from '../../db/projects.js';
import { isClosed, STAGES, type Stage } from '../../domain/stages.js';
import { makeReadOnly } from '../channels.js';
import { requireProject, UserError, type Command, type CommandRun } from '../command.js';

async function close(run: CommandRun, to: 'cancelled' | 'archived'): Promise<void> {
  const project = requireProject(run);
  const { interaction, ctx } = run;
  if (!interaction.options.getBoolean('confirm', true)) {
    throw new UserError('Nothing changed. Run it again with confirm set to True if you mean it.');
  }
  const reason = interaction.options.getString('reason') ?? undefined;
  await interaction.deferReply();

  await moveStage(ctx.db, project, project.stage, to, {
    actor: 'owner',
    actorId: interaction.user.id,
    action: `project.${to}`,
    outcome: 'ok',
    ...(reason ? { data: { reason } } : {}),
  });
  if (project.client_id && interaction.channel?.type === ChannelType.GuildText) {
    await makeReadOnly(interaction.channel, [project.client_id], `Discordlancer: project ${to}`);
  }
  // A project closed before its client joined: retire the invite so it can't be used.
  if (project.stage === 'created' && project.invite_code) {
    await interaction.guild.invites.delete(project.invite_code, `Discordlancer: project ${to}`).catch(() => {
      // Already used up, expired or deleted.
    });
  }
  const why = reason ? ` Reason: ${reason}` : '';
  await interaction.editReply(
    to === 'cancelled'
      ? `This project has been cancelled.${why} The channel stays readable; nothing has been deleted.`
      : `This project is archived.${why} The channel stays readable; nothing has been deleted.`,
  );
}

function definition(name: string, description: string) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .addBooleanOption((option) => option.setName('confirm').setDescription('Set to True to go ahead').setRequired(true))
    .addStringOption((option) => option.setName('reason').setDescription('Optional reason, kept in the record').setMaxLength(300))
    .toJSON();
}

const openStages: Stage[] = STAGES.filter((stage) => !isClosed(stage));

export const cancel: Command = {
  name: 'cancel',
  description: 'Cancel this project (the channel stays readable)',
  access: 'owner',
  where: 'project',
  stages: openStages,
  definition: definition('cancel', 'Cancel this project (the channel stays readable)'),
  execute: (run) => close(run, 'cancelled'),
};

export const archive: Command = {
  name: 'archive',
  description: 'Archive this finished or cancelled project',
  access: 'owner',
  where: 'project',
  stages: STAGES.filter((stage) => stage !== 'archived'),
  definition: definition('archive', 'Archive this finished or cancelled project'),
  execute: (run) => close(run, 'archived'),
};
