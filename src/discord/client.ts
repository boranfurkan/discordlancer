// The Discord client and the interaction handler. One failed command never stops
// the bot: the person gets a short, honest reply and the failure is recorded.

import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Interaction,
} from 'discord.js';
import { recordEvent, type EventInput } from '../db/events.js';
import { log } from '../log.js';
import type { BotContext } from './command.js';
import { actorFor, checkAccess } from './guards.js';

export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      // Privileged: to see when a client joins.
      GatewayIntentBits.GuildMembers,
      // To keep the invite cache current for join tracking.
      GatewayIntentBits.GuildInvites,
      // Privileged: so fetched messages include their text, for specs.
      GatewayIntentBits.MessageContent,
    ],
  });
}

export function handleInteractions(client: Client, ctx: BotContext): void {
  client.on(Events.InteractionCreate, (interaction) => {
    void onInteraction(interaction, ctx);
  });
}

/** Recording must never break a command, so a failed write is logged and dropped. */
export async function safeRecord(ctx: Pick<BotContext, 'db'>, input: EventInput): Promise<void> {
  try {
    await recordEvent(ctx.db, input);
  } catch (error) {
    log.error('could not record event', { action: input.action, error });
  }
}

async function safeReply(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch (error) {
    log.error('could not reply', { command: interaction.commandName, error });
  }
}

async function onInteraction(interaction: Interaction, ctx: BotContext): Promise<void> {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.guildId !== ctx.env.DISCORD_GUILD_ID) return;

  const userId = interaction.user.id;
  const base = {
    actor: actorFor(userId, ctx.env.DISCORD_OWNER_ID),
    actorId: userId,
    action: `command.${interaction.commandName}`,
  } as const;
  const data = { channel_id: interaction.channelId };

  const command = ctx.commands.find((candidate) => candidate.name === interaction.commandName);
  if (!command) {
    await safeReply(interaction, "I don't know that command any more. Try /help.");
    await safeRecord(ctx, { ...base, outcome: 'refused', data: { ...data, reason: 'unknown command' } });
    return;
  }

  const access = checkAccess(command, userId, ctx.env.DISCORD_OWNER_ID);
  if (!access.ok) {
    await safeReply(interaction, access.reply);
    await safeRecord(ctx, { ...base, outcome: 'refused', data: { ...data, reason: 'owner only' } });
    return;
  }

  try {
    await command.execute(interaction, ctx);
    await safeRecord(ctx, { ...base, outcome: 'ok', data });
  } catch (error) {
    log.error('command failed', { command: command.name, error });
    await safeReply(interaction, 'Something went wrong on my side. It has been logged; please try again in a minute.');
    const message = error instanceof Error ? error.message : String(error);
    await safeRecord(ctx, { ...base, outcome: 'failed', data: { ...data, error: message } });
  }
}
