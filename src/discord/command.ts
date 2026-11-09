import type { ChatInputCommandInteraction, RESTPostAPIChatInputApplicationCommandsJSONBody } from 'discord.js';
import type { Surreal } from 'surrealdb';
import type { Actor } from '../db/events.js';
import type { Project } from '../db/projects.js';
import type { Stage } from '../domain/stages.js';
import type { Env } from '../env.js';
import type { GitHubApi } from '../services/github.js';

export interface BotContext {
  env: Env;
  db: Surreal;
  github: GitHubApi;
  commands: readonly Command[];
}

/** Who may run a command. Every command is visible to everyone. */
export type Access = 'everyone' | 'owner';

/** Where a command works: anywhere in our server, or only in a project channel. */
export type Where = 'anywhere' | 'project';

export interface CommandRun {
  interaction: ChatInputCommandInteraction<'cached'>;
  ctx: BotContext;
  actor: Actor;
  /** The project behind this channel, if there is one. Always set when `where` is 'project'. */
  project: Project | undefined;
}

export interface Command {
  name: string;
  description: string;
  access: Access;
  where: Where;
  /** When set, the command only works while the project is in one of these stages. */
  stages?: readonly Stage[];
  definition: RESTPostAPIChatInputApplicationCommandsJSONBody;
  execute(run: CommandRun): Promise<void>;
}

/**
 * A refusal or problem the person can fix. Its message is shown to them as is, and
 * the event is recorded as `refused`. Never put secrets or internal details in it.
 */
export class UserError extends Error {
  override name = 'UserError';
}

/** For commands that need a project: narrows `run.project` after the handler's check. */
export function requireProject(run: CommandRun): Project {
  if (!run.project) throw new UserError('This only works in a project channel.');
  return run.project;
}
