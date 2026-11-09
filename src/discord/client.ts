// The Discord client and the interaction handler. One failed command never stops
// the bot: the person gets a short, honest reply and the outcome is recorded.

import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
} from 'discord.js';
import { recordEvent, type EventInput } from '../db/events.js';
import { getProjectByChannel, StageConflictError, type Project } from '../db/projects.js';
import { log } from '../log.js';
import { UserError, type BotContext, type Command } from './command.js';
import { actorFor, checkAccess } from './guards.js';
import { onAnswerMenu } from './ownerAnswer.js';
import { STAGE_LABEL } from './texts.js';

export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      // Privileged: to see when a client joins.
      GatewayIntentBits.GuildMembers,
      // To be told about invites; join tracking itself reads them fresh from Discord.
      GatewayIntentBits.GuildInvites,
      // To hear Boran tag the bot in a project channel ("answer this").
      GatewayIntentBits.GuildMessages,
      // Privileged: so messages include their text, for specs and answers.
      GatewayIntentBits.MessageContent,
    ],
  });
}

/** Button handlers, by custom ID. Each checks for itself who may press it. */
export type ButtonHandler = (interaction: ButtonInteraction<'cached'>, ctx: BotContext) => Promise<void>;

export function handleInteractions(client: Client, ctx: BotContext, buttons: Record<string, ButtonHandler> = {}): void {
  client.on(Events.InteractionCreate, (interaction) => {
    void routeInteraction(interaction, ctx, buttons);
  });
}

/** Handles one interaction to completion. The bot calls it per event; tests await it. */
export function routeInteraction(interaction: Interaction, ctx: BotContext, buttons: Record<string, ButtonHandler> = {}): Promise<void> {
  if (interaction.isButton()) return onButton(interaction, ctx, buttons);
  if (interaction.isMessageContextMenuCommand()) return onAnswerMenu(interaction, ctx);
  return onInteraction(interaction, ctx);
}

async function onButton(interaction: ButtonInteraction, ctx: BotContext, buttons: Record<string, ButtonHandler>): Promise<void> {
  if (!interaction.inCachedGuild() || interaction.guildId !== ctx.env.DISCORD_GUILD_ID) return;
  const handler =
    buttons[interaction.customId] ??
    Object.entries(buttons).find(([key]) => key.endsWith(':') && interaction.customId.startsWith(key))?.[1];
  const base = {
    actor: actorFor(interaction.user.id, ctx.env.DISCORD_OWNER_ID),
    actorId: interaction.user.id,
    // Prefix buttons carry an ID after the last colon; record the button's kind.
    action: `button.${interaction.customId.split(':').slice(0, 2).join(':')}`,
  } as const;
  if (!handler) return;
  try {
    await handler(interaction, ctx);
    await safeRecord(ctx, { ...base, outcome: 'ok', data: { channel_id: interaction.channelId } });
  } catch (error) {
    const known = error instanceof UserError || error instanceof StageConflictError;
    if (!known) log.error('button failed', { button: interaction.customId, error });
    const content = known ? (error as Error).message : 'Something went wrong on my side. It has been logged; please try again in a minute.';
    try {
      if (interaction.replied || interaction.deferred) await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    } catch (replyError) {
      log.error('could not reply to a button', { error: replyError });
    }
    await safeRecord(ctx, { ...base, outcome: known ? 'refused' : 'failed', data: { channel_id: interaction.channelId } });
  }
}

/** Recording must never break a command, so a failed write is logged and dropped. */
export async function safeRecord(ctx: Pick<BotContext, 'db'>, input: EventInput): Promise<void> {
  try {
    await recordEvent(ctx.db, input);
  } catch (error) {
    log.error('could not record event', { action: input.action, error });
  }
}

/** Replies privately, whatever state the interaction is in. */
export async function safeReply(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  try {
    if (interaction.deferred && !interaction.replied) {
      await interaction.editReply({ content });
    } else if (interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch (error) {
    log.error('could not reply', { command: interaction.commandName, error });
  }
}

export type Gate = { ok: true } | { ok: false; reason: string; reply: string };

/** Pure: whether this person may run this command here, at this stage. */
export function checkGate(
  command: Pick<Command, 'access' | 'where' | 'stages'>,
  userId: string,
  ownerId: string,
  project: Pick<Project, 'client_id' | 'stage'> | undefined,
): Gate {
  const access = checkAccess(command, userId, ownerId);
  if (!access.ok) return { ok: false, reason: 'owner only', reply: access.reply };
  if (command.where === 'project') {
    if (!project) return { ok: false, reason: 'not a project channel', reply: 'This only works in a project channel.' };
    if (userId !== ownerId && userId !== project.client_id) {
      return { ok: false, reason: 'not their project', reply: "This isn't your project channel." };
    }
  }
  if (command.stages && project && !command.stages.includes(project.stage)) {
    return {
      ok: false,
      reason: `stage ${project.stage}`,
      reply: `That can't be done at this stage (${STAGE_LABEL[project.stage]}). Try /project to see what's next.`,
    };
  }
  return { ok: true };
}

async function onInteraction(interaction: Interaction, ctx: BotContext): Promise<void> {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inCachedGuild() || interaction.guildId !== ctx.env.DISCORD_GUILD_ID) return;

  const userId = interaction.user.id;
  const actor = actorFor(userId, ctx.env.DISCORD_OWNER_ID);
  const action = `command.${interaction.commandName}`;
  let project: Project | undefined;
  let command: Command | undefined;
  // Only project commands are filed under the channel's project. A command that works
  // anywhere, like /new-project, may be about a different project altogether.
  const event = (outcome: EventInput['outcome'], data: Record<string, unknown> = {}): EventInput => ({
    actor,
    actorId: userId,
    action,
    outcome,
    ...(project && command?.where === 'project' ? { project: project.id } : {}),
    data: { channel_id: interaction.channelId, ...data },
  });

  try {
    project = await getProjectByChannel(ctx.db, interaction.channelId);
  } catch (error) {
    log.error('could not look up the project', { error });
    await safeReply(interaction, 'Something went wrong on my side. It has been logged; please try again in a minute.');
    await safeRecord(ctx, event('failed', { error: 'project lookup failed' }));
    return;
  }

  command = ctx.commands.find((candidate) => candidate.name === interaction.commandName);
  if (!command) {
    await safeReply(interaction, "I don't know that command any more. Try /help.");
    await safeRecord(ctx, event('refused', { reason: 'unknown command' }));
    return;
  }

  const gate = checkGate(command, userId, ctx.env.DISCORD_OWNER_ID, project);
  if (!gate.ok) {
    await safeReply(interaction, gate.reply);
    await safeRecord(ctx, event('refused', { reason: gate.reason }));
    return;
  }

  try {
    await command.execute({ interaction, ctx, actor, project });
    await safeRecord(ctx, event('ok'));
  } catch (error) {
    if (error instanceof UserError || error instanceof StageConflictError) {
      await safeReply(interaction, error.message);
      await safeRecord(ctx, event('refused', { reason: error.message }));
      return;
    }
    log.error('command failed', { command: command.name, error });
    await safeReply(interaction, 'Something went wrong on my side. It has been logged; please try again in a minute.');
    const message = error instanceof Error ? error.message : String(error);
    await safeRecord(ctx, event('failed', { error: message }));
  }
}
