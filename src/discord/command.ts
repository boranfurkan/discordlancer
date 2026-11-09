import type { ChatInputCommandInteraction, RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';
import type { Surreal } from 'surrealdb';
import type { Env } from '../env.js';

export interface BotContext {
  env: Env;
  db: Surreal;
  commands: readonly Command[];
}

/** Who may run a command. Every command is visible to everyone. */
export type Access = 'everyone' | 'owner';

/** Where a command works. Project-channel checks arrive in phase 2. */
export type Where = 'anywhere' | 'project';

export interface Command {
  name: string;
  description: string;
  access: Access;
  where: Where;
  definition: RESTPostAPIChatInputApplicationCommandsJSONBody;
  execute(interaction: ChatInputCommandInteraction, ctx: BotContext): Promise<void>;
}
