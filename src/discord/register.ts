// Registers the slash commands on our server only, so changes show up at once.
// A bulk overwrite: commands that are no longer in the list are removed.
// Run by hand with `npm run commands:register`; the bot also does it at startup.

import { REST, Routes } from 'discord.js';
import { pathToFileURL } from 'node:url';
import { loadEnv, secretValues, type Env } from '../env.js';
import { log, registerSecrets } from '../log.js';
import type { Command } from './command.js';
import { COMMANDS } from './commands/index.js';

export async function registerCommands(env: Env, commands: readonly Command[]): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(env.DISCORD_APPLICATION_ID, env.DISCORD_GUILD_ID), {
    body: commands.map((command) => command.definition),
  });
  log.info('commands registered', { count: commands.length, names: commands.map((command) => command.name) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = loadEnv();
  registerSecrets(secretValues(env));
  registerCommands(env, COMMANDS).catch((error: unknown) => {
    log.error('registering commands failed', { error });
    process.exit(1);
  });
}
