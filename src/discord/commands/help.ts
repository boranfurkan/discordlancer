import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../command.js';
import { OWNER_NAME } from '../guards.js';

/** The commands the caller can run. Stage-aware listing arrives with the project commands. */
export function helpText(commands: readonly Pick<Command, 'name' | 'description' | 'access'>[], isOwner: boolean): string {
  const lines = commands
    .filter((command) => isOwner || command.access === 'everyone')
    .map((command) => {
      const ownerOnly = command.access === 'owner' ? ` (${OWNER_NAME} only)` : '';
      return `- **/${command.name}**: ${command.description}${ownerOnly}`;
    });
  return ['Commands you can use:', ...lines].join('\n');
}

const description = 'Show the commands you can use';

export const help: Command = {
  name: 'help',
  description,
  access: 'everyone',
  where: 'anywhere',
  definition: new SlashCommandBuilder().setName('help').setDescription(description).toJSON(),
  async execute(interaction, ctx) {
    const isOwner = interaction.user.id === ctx.env.DISCORD_OWNER_ID;
    await interaction.reply({ content: helpText(ctx.commands, isOwner), flags: MessageFlags.Ephemeral });
  },
};
