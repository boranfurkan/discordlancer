// Starts Discordlancer: env, database and schema, commands, then the Discord client.

import { Events } from 'discord.js';
import { closeDatabase, connectDatabase } from './db/client.js';
import { applySchema } from './db/migrate.js';
import { createDiscordClient, handleInteractions, safeRecord } from './discord/client.js';
import { COMMANDS } from './discord/commands/index.js';
import { APPROVE_PREFIX, DECLINE_PREFIX, onApproveChange, onDeclineChange } from './discord/commands/afterDelivery.js';
import { CONFIRM_DELIVERY_BUTTON, onConfirmDeliveryButton } from './discord/commands/delivery.js';
import { onMemberAdd } from './discord/joins.js';
import { createGemini } from './services/gemini.js';
import { createGitHub } from './services/github.js';
import { createMemory } from './services/memory.js';
import { createSolana } from './services/solana.js';
import { startPaymentWatcher } from './discord/watcher.js';
import { registerCommands } from './discord/register.js';
import { loadEnv, secretValues } from './env.js';
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

  const db = await connectDatabase(env);
  await applySchema(db);
  await registerCommands(env, COMMANDS);

  const client = createDiscordClient();
  let stopWatcher: (() => void) | undefined;
  const ctx = {
    env,
    db,
    github: createGitHub(env),
    gemini: createGemini(env),
    solana: createSolana(env),
    memory: createMemory(env),
    commands: COMMANDS,
  };

  client.once(Events.ClientReady, (ready) => {
    log.info('discord ready', { user: ready.user.tag, guild: env.DISCORD_GUILD_ID });
    void safeRecord(ctx, { actor: 'bot', action: 'bot.started', outcome: 'ok' });
    stopWatcher = startPaymentWatcher(client, ctx);
  });
  handleInteractions(client, ctx, {
    [CONFIRM_DELIVERY_BUTTON]: onConfirmDeliveryButton,
    [APPROVE_PREFIX]: onApproveChange,
    [DECLINE_PREFIX]: onDeclineChange,
  });
  client.on(Events.GuildMemberAdd, (member) => {
    void onMemberAdd(member, ctx);
  });

  const shutdown = async (signal: string) => {
    log.info('shutting down', { signal });
    stopWatcher?.();
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
