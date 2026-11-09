// /ask question: anyone in the project asks about it, and the assistant answers in the
// channel from the chat, the agreed spec and quote, payments, memory and the code.

import { ChannelType, SlashCommandBuilder } from 'discord.js';
import { countEventsSince } from '../../db/events.js';
import { londonDayStart } from '../../domain/deadline.js';
import { afterAnswer, answerQuestion, ASKS_PER_DAY, formatAnswer } from '../answers.js';
import { requireProject, UserError, type Command } from '../command.js';
import { OWNER_NAME } from '../guards.js';

const description = 'Ask anything about this project; the AI assistant answers from the chat, specs and code';

export const ask: Command = {
  name: 'ask',
  description,
  access: 'everyone',
  where: 'project',
  stages: ['created', 'joined', 'specs_agreed', 'quote_accepted', 'paid', 'in_development', 'delivered', 'support'],
  definition: new SlashCommandBuilder()
    .setName('ask')
    .setDescription(description)
    .addStringOption((option) => option.setName('question').setDescription('Your question').setRequired(true).setMaxLength(1000))
    .toJSON(),

  async execute(run) {
    const project = requireProject(run);
    const { interaction, ctx, actor } = run;
    if (interaction.channel?.type !== ChannelType.GuildText) throw new UserError('Run this in the project channel.');
    const question = interaction.options.getString('question', true).trim();
    if (!question) throw new UserError('Please write a question.');
    if (actor !== 'owner' && (await countEventsSince(ctx.db, project.id, 'ask.answered', londonDayStart())) >= ASKS_PER_DAY) {
      throw new UserError(`That's ${ASKS_PER_DAY} questions today. Please ask ${OWNER_NAME} directly here, or try again tomorrow.`);
    }
    await interaction.deferReply();

    const { output, commit } = await answerQuestion(ctx, project, interaction.channel, question);
    const posted = await interaction.editReply(formatAnswer(output, { commit, question }));
    await afterAnswer(interaction.guild, ctx, project, {
      actor,
      actorId: interaction.user.id,
      action: 'ask.answered',
      via: 'ask',
      question,
      output,
      commit,
      link: posted && 'url' in posted ? String(posted.url) : `<#${project.channel_id}>`,
    });
  },
};
