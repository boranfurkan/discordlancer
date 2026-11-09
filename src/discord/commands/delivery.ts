// /confirm-delivery and its button. Boran marks the project delivered (with an
// optional note, such as a URL or branch); the client confirms with the button or by
// running the command. Both together move the project to delivered.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  SlashCommandBuilder,
  type ButtonInteraction,
  type Guild,
} from 'discord.js';
import { getProjectByChannel, moveStage, updateProject, type Project } from '../../db/projects.js';
import { log } from '../../log.js';
import { ensureOwnerChannel } from '../channels.js';
import { requireProject, UserError, type BotContext, type Command } from '../command.js';
import { OWNER_NAME } from '../guards.js';

export const CONFIRM_DELIVERY_BUTTON = 'dl:confirm-delivery';

function confirmRow(disabled: boolean) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(CONFIRM_DELIVERY_BUTTON)
      .setLabel(disabled ? 'Delivery confirmed' : 'Confirm delivery')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
  );
}

/** Pure check shared by the button and the command: may this person confirm now? */
export function canConfirm(project: Pick<Project, 'stage' | 'client_id' | 'delivery_marked_at'>, userId: string): string | undefined {
  if (project.stage !== 'in_development') return "This project isn't waiting for a delivery confirmation.";
  if (userId !== project.client_id) return 'Only the client confirms the delivery.';
  if (!project.delivery_marked_at) return `${OWNER_NAME} hasn't marked it as delivered yet.`;
  return undefined;
}

async function confirm(ctx: BotContext, guild: Guild, project: Project, userId: string): Promise<void> {
  await moveStage(ctx.db, project, 'in_development', 'delivered', {
    actor: 'client',
    actorId: userId,
    action: 'delivery.confirmed',
    outcome: 'ok',
  });
  try {
    const owner = await ensureOwnerChannel(guild, ctx.env.DISCORD_OWNER_ID);
    await owner.send(
      `**${project.name}** is delivered and confirmed by the client. Keep the confirmation for the audit, and run /export in the project channel for the evidence pack.`,
    );
  } catch (error) {
    log.error('could not notify the owner of a delivery', { error });
  }
}

const description = 'Mark the project delivered (Furkan), or confirm the delivery (client)';

export const confirmDelivery: Command = {
  name: 'confirm-delivery',
  description,
  access: 'everyone',
  where: 'project',
  stages: ['in_development'],
  definition: new SlashCommandBuilder()
    .setName('confirm-delivery')
    .setDescription(description)
    .addStringOption((option) =>
      option.setName('note').setDescription('Furkan only: what was delivered, such as a URL or branch').setMaxLength(500),
    )
    .toJSON(),

  async execute(run) {
    const project = requireProject(run);
    const { interaction, ctx, actor } = run;

    if (actor === 'owner') {
      const note = interaction.options.getString('note') ?? undefined;
      await updateProject(
        ctx.db,
        project,
        { delivery_marked_at: new Date(), ...(note ? { delivery_note: note } : {}) },
        { actor: 'owner', actorId: interaction.user.id, action: 'delivery.marked', outcome: 'ok', ...(note ? { data: { note } } : {}) },
      );
      const client = project.client_id ? `<@${project.client_id}>` : 'Client';
      await interaction.reply({
        content: [
          `${OWNER_NAME} has marked **${project.name}** as delivered.${note ? `\n> ${note}` : ''}`,
          `${client}, please check it against the agreed spec, then confirm with the button below or with /confirm-delivery. If something is missing, say so here instead.`,
        ].join('\n'),
        components: [confirmRow(false)],
      });
      return;
    }

    const problem = canConfirm(project, interaction.user.id);
    if (problem) throw new UserError(problem);
    await confirm(ctx, interaction.guild, project, interaction.user.id);
    await interaction.reply(`<@${interaction.user.id}> confirmed the delivery of **${project.name}**. Thank you! Small changes can be asked for later.`);
  },
};

/** The button. Answers only the project's client, and only when a delivery is marked. */
export async function onConfirmDeliveryButton(interaction: ButtonInteraction<'cached'>, ctx: BotContext): Promise<void> {
  if (interaction.channel?.type !== ChannelType.GuildText) return;
  const project = await getProjectByChannel(ctx.db, interaction.channelId);
  const problem = project ? canConfirm(project, interaction.user.id) : 'This only works in a project channel.';
  if (problem || !project) {
    await interaction.reply({ content: problem ?? 'This only works in a project channel.', flags: MessageFlags.Ephemeral });
    return;
  }
  await confirm(ctx, interaction.guild, project, interaction.user.id);
  await interaction.update({ components: [confirmRow(true)] });
  await interaction.followUp(`<@${interaction.user.id}> confirmed the delivery of **${project.name}**. Thank you! Small changes can be asked for later.`);
}
