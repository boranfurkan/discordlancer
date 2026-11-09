// Boran's "answer this for me", two ways, in a project channel:
// - reply to the client's message and tag the bot (any text after the tag is a note
//   for the answer, such as "mention we use Stripe"), or tag the bot with a question;
// - right-click the client's message, Apps, "Answer with AI" (only Boran sees it).
// The answer is posted as a reply to the client's message, marked as an AI answer.

import {
  ApplicationCommandType,
  ChannelType,
  MessageFlags,
  type Message,
  type MessageContextMenuCommandInteraction,
  type RESTPostAPIContextMenuApplicationCommandsJSONBody,
} from 'discord.js';
import { getProjectByChannel, type Project } from '../db/projects.js';
import { log } from '../log.js';
import { afterAnswer, answerQuestion, formatAnswer } from './answers.js';
import { safeRecord } from './client.js';
import { UserError, type BotContext } from './command.js';
import { OWNER_NAME } from './guards.js';

export const ANSWER_MENU_NAME = 'Answer with AI';

/** A message menu command. "0" hides it from everyone but server admins, that is Boran. */
export const ANSWER_MENU: RESTPostAPIContextMenuApplicationCommandsJSONBody = {
  name: ANSWER_MENU_NAME,
  type: ApplicationCommandType.Message,
  default_member_permissions: '0',
};

/** Pure: whether the text explicitly tags the bot (a reply's automatic ping doesn't count). */
export function tagsBot(content: string, botId: string): boolean {
  return content.includes(`<@${botId}>`) || content.includes(`<@!${botId}>`);
}

/** Pure: Boran's words around the tag. */
export function withoutTag(content: string, botId: string): string {
  return content.replaceAll(`<@${botId}>`, '').replaceAll(`<@!${botId}>`, '').replace(/\s+/g, ' ').trim();
}

const HOW_TO = "Reply to the client's message and tag me, and I'll answer it. Or tag me with a question.";
const replyQuietly = { allowedMentions: { parse: [], repliedUser: true } } as const;

async function projectFor(ctx: BotContext, channelId: string): Promise<Project | undefined> {
  try {
    return await getProjectByChannel(ctx.db, channelId);
  } catch (error) {
    log.error('could not look up the project', { error });
    return undefined;
  }
}

/** A message in our server: answers it if Boran tagged the bot in a project channel. */
export async function onOwnerMention(message: Message, ctx: BotContext, botId: string): Promise<void> {
  if (!message.inGuild() || message.guildId !== ctx.env.DISCORD_GUILD_ID) return;
  if (message.author.bot || message.author.id !== ctx.env.DISCORD_OWNER_ID) return;
  if (!tagsBot(message.content, botId)) return;
  if (message.channel.type !== ChannelType.GuildText) return;
  const project = await projectFor(ctx, message.channelId);
  if (!project) return;

  const ownerText = withoutTag(message.content, botId);
  let target: Message | undefined;
  if (message.reference?.messageId) {
    const referenced = await message.fetchReference().catch(() => undefined);
    // Tagging the bot under its own post is a question about it, not a question to answer.
    if (referenced && !referenced.author.bot && referenced.content.trim()) target = referenced;
  }
  const question = target ? target.content.trim() : ownerText;
  const ownerNote = target && ownerText ? ownerText : undefined;
  const base = { actor: 'owner', actorId: message.author.id, action: 'question.answered', project: project.id } as const;
  if (!question) {
    await message.reply(HOW_TO).catch(() => undefined);
    return;
  }

  await message.channel.sendTyping().catch(() => undefined);
  try {
    const { output, commit } = await answerQuestion(ctx, project, message.channel, question, ownerNote);
    const posted = await (target ?? message).reply({ content: formatAnswer(output, { commit }), ...replyQuietly });
    await afterAnswer(message.guild, ctx, project, { ...base, via: 'mention', question, output, commit, link: posted.url });
  } catch (error) {
    const known = error instanceof UserError;
    if (!known) log.error('answering a tagged question failed', { error });
    await message.reply(known ? error.message : 'Something went wrong on my side. It has been logged; please try again in a minute.').catch(() => undefined);
    await safeRecord(ctx, { ...base, outcome: known ? 'refused' : 'failed', data: { via: 'mention' } });
  }
}

/** Right-click, Apps, "Answer with AI": answers that message as a reply to it. */
export async function onAnswerMenu(interaction: MessageContextMenuCommandInteraction, ctx: BotContext): Promise<void> {
  if (!interaction.inCachedGuild() || interaction.guildId !== ctx.env.DISCORD_GUILD_ID) return;
  if (interaction.commandName !== ANSWER_MENU_NAME) return;
  const base = { actor: 'owner', actorId: interaction.user.id, action: 'question.answered' } as const;
  const refuse = async (content: string, reason: string) => {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
    await safeRecord(ctx, { ...base, actor: interaction.user.id === ctx.env.DISCORD_OWNER_ID ? 'owner' : 'client', outcome: 'refused', data: { via: 'menu', reason } });
  };
  if (interaction.user.id !== ctx.env.DISCORD_OWNER_ID) return refuse(`Only ${OWNER_NAME} can do this.`, 'owner only');
  const project = await projectFor(ctx, interaction.channelId);
  if (!project || interaction.channel?.type !== ChannelType.GuildText) return refuse('This only works in a project channel.', 'not a project channel');
  const target = interaction.targetMessage;
  if (target.author.bot) return refuse("That's the bot's own message. Pick a message from the client.", 'bot message');
  const question = target.content.trim();
  if (!question) return refuse('That message has no text to answer.', 'empty message');

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const { output, commit } = await answerQuestion(ctx, project, interaction.channel, question);
    const posted = await target.reply({ content: formatAnswer(output, { commit }), ...replyQuietly });
    await afterAnswer(interaction.guild, ctx, project, { ...base, via: 'menu', question, output, commit, link: posted.url });
    await interaction.editReply(output.needs_owner ? `Answered, and flagged in #owner-desk: it needs you. ${posted.url}` : `Answered: ${posted.url}`);
  } catch (error) {
    const known = error instanceof UserError;
    if (!known) log.error('answering from the menu failed', { error });
    await interaction.editReply(known ? error.message : 'Something went wrong on my side. It has been logged; please try again in a minute.').catch(() => undefined);
    await safeRecord(ctx, { ...base, project: project.id, outcome: known ? 'refused' : 'failed', data: { via: 'menu' } });
  }
}
