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
import { discordFileReader, onSharedMessage } from './discord/files.js';
import { CONSENT_PREFIX, onCallConsent } from './discord/commands/call.js';
import type { BotContext } from './discord/command.js';
import { createCallManager } from './voice/calls.js';
import { syncGuides } from './discord/guide.js';
import { ensureProjectThread } from './discord/channels.js';
import { clientMembers } from './db/projects.js';
import { createElevenLabs } from './services/elevenlabs.js';
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
  // Set once connected; until then the status page says the database is starting.
  let database: Awaited<ReturnType<typeof connectDatabase>> | undefined;
  const health = startHealthServer(healthPort(process.env.PORT), () => client.isReady(), { [MCP_PATH]: () => mcp }, () => database?.status);

  const db = await connectDatabase(env);
  database = db;
  await applySchema(db);
  await registerCommands(env, COMMANDS);

  let stopWatcher: (() => void) | undefined;
  let stopPullWatcher: (() => void) | undefined;
  const ctx: BotContext = {
    env,
    db,
    github: createGitHub(env),
    gemini: createGemini(env),
    solana: createSolana(env),
    memory: createMemory(env),
    commands: COMMANDS,
    ...(env.ELEVENLABS_API_KEY ? { stt: createElevenLabs(env) } : {}),
  };
  log.info('call transcription', { service: ctx.stt ? 'ElevenLabs' : 'Gemini' });
  ctx.calls = createCallManager(ctx);
  ctx.files = discordFileReader(ctx, client);

  // Claude Code's progress updates: posted in the project's channel, pinging nobody.
  mcp = createMcpHandler({
    db,
    memory: ctx.memory,
    ownerId: env.DISCORD_OWNER_ID,
    async post(project, content) {
      const channel = await client.channels.fetch(project.channel_id);
      if (channel?.type !== ChannelType.GuildText || channel.guildId !== env.DISCORD_GUILD_ID) {
        throw new Error(`project channel ${project.channel_id} not found`);
      }
      const thread = await ensureProjectThread(channel, 'updates', [env.DISCORD_OWNER_ID, ...clientMembers(project)]);
      const message = await thread.send({ content, allowedMentions: { parse: [] } });
      return { url: message.url };
    },
  });

  client.once(Events.ClientReady, (ready) => {
    log.info('discord ready', { user: ready.user.tag, guild: env.DISCORD_GUILD_ID });
    ctx.botId = ready.user.id;
    void safeRecord(ctx, { actor: 'bot', action: 'bot.started', outcome: 'ok' });
    stopWatcher = startPaymentWatcher(client, ctx);
    stopPullWatcher = startPullRequestWatcher(client, ctx);
    void ready.guilds.fetch(env.DISCORD_GUILD_ID).then((guild) => syncGuides(guild, env.DISCORD_OWNER_ID, COMMANDS)).catch((error: unknown) => {
      log.warn('could not reach the server for the guides', { error });
    });
  });
  handleInteractions(client, ctx, {
    [CONFIRM_DELIVERY_BUTTON]: onConfirmDeliveryButton,
    [APPROVE_PREFIX]: onApproveChange,
    [DECLINE_PREFIX]: onDeclineChange,
    [CONSENT_PREFIX]: onCallConsent,
  });
  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    ctx.calls?.onVoiceStateUpdate(oldState, newState);
  });
  client.on(Events.GuildMemberAdd, (member) => {
    void onMemberAdd(member, ctx);
  });
  client.on(Events.MessageCreate, (message) => {
    if (!client.user) return;
    void onOwnerMention(message, ctx, client.user.id);
    // Files and links shared in a project channel are read once, into notes.
    if (ctx.files) void onSharedMessage(message, ctx, ctx.files, client.user.id).catch((error: unknown) => log.warn('could not read a shared message', { error }));
  });

  const shutdown = async (signal: string) => {
    log.info('shutting down', { signal });
    stopWatcher?.();
    stopPullWatcher?.();
    // A call in progress is ended and transcribed if there's time; Replit allows a few seconds.
    const active = ctx.calls?.activeProject();
    if (active) {
      await ctx.calls?.stop(active, 'the bot is restarting');
      await Promise.race([ctx.calls?.idle(), new Promise((resolve) => setTimeout(resolve, 20_000))]);
    }
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
