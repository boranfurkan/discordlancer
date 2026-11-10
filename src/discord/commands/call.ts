// /call start | stop | retry: Boran records a call in the project's voice channel. Each
// person agrees with a button first; the notes and transcript are posted here after.

import { ChannelType, MessageFlags, SlashCommandBuilder, type ButtonInteraction } from 'discord.js';
import { CONSENT_PREFIX, EMPTY_CALL_GRACE_MS } from '../../voice/calls.js';
import { requireProject, UserError, type BotContext, type Command } from '../command.js';
import { OWNER_NAME } from '../guards.js';

const description = "Record a call in this project's voice channel (each person agrees first)";

export const call: Command = {
  name: 'call',
  description,
  access: 'owner',
  where: 'project',
  stages: ['joined', 'specs_agreed', 'quote_accepted', 'paid', 'in_development', 'delivered', 'support'],
  definition: new SlashCommandBuilder()
    .setName('call')
    .setDescription(description)
    .addSubcommand((sub) => sub.setName('start').setDescription('Join the project voice channel and record, once each person agrees'))
    .addSubcommand((sub) => sub.setName('stop').setDescription('End the call; the notes and transcript are posted here'))
    .addSubcommand((sub) => sub.setName('retry').setDescription("Try again to transcribe a call that couldn't be transcribed"))
    .toJSON(),

  async execute(run) {
    const project = requireProject(run);
    const { interaction, ctx } = run;
    if (!ctx.calls) throw new UserError('Calls are not available right now.');
    if (interaction.channel?.type !== ChannelType.GuildText) throw new UserError('Run this in the project channel.');
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'start') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const voice = await ctx.calls.start(project, interaction.channel);
      await interaction.editReply(
        [
          `The bot is in <#${voice.id}> and recording you. Join it now.`,
          "The client is asked to press **Record me** first; until they do, they aren't recorded.",
          `End it with \`/call stop\`. It also ends by itself ${EMPTY_CALL_GRACE_MS / 60_000} minutes after everyone leaves.`,
        ].join('\n'),
      );
      return;
    }
    if (subcommand === 'stop') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (!(await ctx.calls.stop(project.name, `${OWNER_NAME} ended it`))) throw new UserError('No call is being recorded for this project.');
      await interaction.editReply('Call ended. The notes and transcript will be posted here in a minute or two.');
      return;
    }
    if (!ctx.calls.retry(project.name)) throw new UserError("There's no call waiting to be transcribed again for this project.");
    await interaction.reply({ content: 'Transcribing the call again. The notes will be posted here.', flags: MessageFlags.Ephemeral });
  },
};

/** The "Record me" and "Don't record me" buttons. */
export async function onCallConsent(interaction: ButtonInteraction<'cached'>, ctx: BotContext): Promise<void> {
  if (!ctx.calls) throw new UserError('That call has ended.');
  await ctx.calls.onConsent(interaction);
}

export { CONSENT_PREFIX };
