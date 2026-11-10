// Starts Discordlancer: env, database and schema, commands, then the Discord client.

import { ChannelType, Events } from 'discord.js';
import { closeDatabase, connectDatabase } from './db/client.js';
import { applySchema } from './db/migrate.js';
import { createDiscordClient, handleInteractions, safeRecord } from './discord/client.js';
import { COMMANDS } from './discord/commands/index.js';
import { APPROVE_PREFIX, DECLINE_PREFIX, onApproveChange, onDeclineChange } from './discord/commands/afterDelivery.js';
import { CONFIRM_DELIVERY_BUTTON, onConfirmDeliveryButton } from './discord/commands/delivery.js';
import { onMemberAdd } from './discord/joins.js';
import { onOwnerMention } from './discord/ownerAnswer.js';
import { createGemini } from './services/gemini.js';
import { createGitHub } from './services/github.js';
import { createMemory } from './services/memory.js';
import { createSolana } from './services/solana.js';
import { startPaymentWatcher } from './discord/watcher.js';
import { startPullRequestWatcher } from './discord/prWatcher.js';
import { registerCommands } from './discord/register.js';
import { loadEnv, secretValues } from './env.js';
import { healthPort, startHealthServer, type RouteHandler } from './health.js';
import { createMcpHandler, MCP_PATH } from './mcp/server.js';
import { log, registerSecrets } from './log.js';

process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', { error: reason });
});
process.on('uncaughtException', (error) => {
  // State may be broken after this, so exit and let the host restart the bot.
  log.error('uncaught exception', { error });
  process.exit(1);
});

async function main(): Promise<void> {
  const env = loadEnv();
  registerSecrets(secretValues(env));

  // Opened first, so the host sees the app is up while the rest starts.
  const client = createDiscordClient();
  let mcp: RouteHandler | undefined;
  const health = startHealthServer(healthPort(process.env.PORT), () => client.isReady(), { [MCP_PATH]: () => mcp });

  const db = await connectDatabase(env);
  await applySchema(db);
  await registerCommands(env, COMMANDS);

  let stopWatcher: (() => void) | undefined;
  let stopPullWatcher: (() => void) | undefined;
  const ctx = {
    env,
    db,
    github: createGitHub(env),
    gemini: createGemini(env),
    solana: createSolana(env),
    memory: createMemory(env),
    commands: COMMANDS,
  };

  // Claude Code's progress updates: posted in the project's channel, pinging nobody.
  mcp = createMcpHandler({
    db,
    memory: ctx.memory,
    ownerId: env.DISCORD_OWNER_ID,
    async post(channelId, content) {
      const channel = await client.channels.fetch(channelId);
      if (channel?.type !== ChannelType.GuildText || channel.guildId !== env.DISCORD_GUILD_ID) {
        throw new Error(`project channel ${channelId} not found`);
      }
      const message = await channel.send({ content, allowedMentions: { parse: [] } });
      return { url: message.url };
    },
  });

  client.once(Events.ClientReady, (ready) => {
    log.info('discord ready', { user: ready.user.tag, guild: env.DISCORD_GUILD_ID });
    void safeRecord(ctx, { actor: 'bot', action: 'bot.started', outcome: 'ok' });
    stopWatcher = startPaymentWatcher(client, ctx);
    stopPullWatcher = startPullRequestWatcher(client, ctx);
  });
  handleInteractions(client, ctx, {
    [CONFIRM_DELIVERY_BUTTON]: onConfirmDeliveryButton,
    [APPROVE_PREFIX]: onApproveChange,
    [DECLINE_PREFIX]: onDeclineChange,
  });
  client.on(Events.GuildMemberAdd, (member) => {
    void onMemberAdd(member, ctx);
  });
  client.on(Events.MessageCreate, (message) => {
    if (client.user) void onOwnerMention(message, ctx, client.user.id);
  });

  const shutdown = async (signal: string) => {
    log.info('shutting down', { signal });
    stopWatcher?.();
    stopPullWatcher?.();
    health.close();
    await client.destroy();
    await closeDatabase(db);
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await client.login(env.DISCORD_TOKEN);
}

main().catch((error: unknown) => {
  log.error('startup failed', { error });
  process.exit(1);
});
