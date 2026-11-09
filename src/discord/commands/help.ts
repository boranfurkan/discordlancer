import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Stage } from '../../domain/stages.js';
import type { Command } from '../command.js';
import { OWNER_NAME } from '../guards.js';
import { NEXT_STEP, STAGE_LABEL } from '../texts.js';

type Listed = Pick<Command, 'name' | 'description' | 'access' | 'where' | 'stages'>;

/** Pure: the commands this person can run here and now. */
export function helpText(commands: readonly Listed[], isOwner: boolean, stage?: Stage): string {
  const inProject = stage !== undefined;
  const usable = commands.filter((command) => {
    if (!isOwner && command.access === 'owner') return false;
    if (command.where === 'project' && !inProject) return false;
    if (command.stages && stage && !command.stages.includes(stage)) return false;
    return true;
  });
  const lines = usable.map((command) => {
    const ownerOnly = command.access === 'owner' ? ` (${OWNER_NAME} only)` : '';
    return `- **/${command.name}**: ${command.description}${ownerOnly}`;
  });
  const header = inProject
    ? [`**Stage:** ${STAGE_LABEL[stage]}`, `**Next:** ${NEXT_STEP[stage]}`, '', 'Commands you can use here now:']
    : ['Commands you can use here:'];
  return [...header, ...lines].join('\n');
}

const description = 'Show the commands you can use here';

export const help: Command = {
  name: 'help',
  description,
  access: 'everyone',
  where: 'anywhere',
  definition: new SlashCommandBuilder().setName('help').setDescription(description).toJSON(),
  async execute({ interaction, ctx, project }) {
    const isOwner = interaction.user.id === ctx.env.DISCORD_OWNER_ID;
    await interaction.reply({ content: helpText(ctx.commands, isOwner, project?.stage), flags: MessageFlags.Ephemeral });
  },
};
