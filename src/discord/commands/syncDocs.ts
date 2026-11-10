// /sync-docs: Boran refreshes the project's docs in its repo, as a pull request he
// reviews and merges. See src/discord/docs.ts for how they are written and checked.

import { ChannelType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { recordEvent } from '../../db/events.js';
import { log } from '../../log.js';
import { DOCS_PROMPT_VERSION } from '../../prompts/docs.js';
import { GeminiError, SPEC_MODEL } from '../../services/gemini.js';
import { GitHubError } from '../../services/github.js';
import { ensureOwnerChannel } from '../channels.js';
import { requireProject, UserError, type Command } from '../command.js';
import { DOCS_BRANCH, pullBody, secretInDocs, writeDocs } from '../docs.js';

const description = "Update the project docs in the repo from the chat, calls and specs (as a pull request)";

/** One sync per project at a time: a second click would race the first one's branch. */
const running = new Set<string>();

function githubStatus(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : undefined;
}

export const syncDocs: Command = {
  name: 'sync-docs',
  description,
  access: 'owner',
  where: 'project',
  stages: ['joined', 'specs_agreed', 'quote_accepted', 'paid', 'in_development', 'delivered', 'support'],
  definition: new SlashCommandBuilder().setName('sync-docs').setDescription(description).toJSON(),

  async execute(run) {
    const project = requireProject(run);
    const { interaction, ctx } = run;
    if (interaction.channel?.type !== ChannelType.GuildText) throw new UserError('Run this in the project channel.');
    if (running.has(project.name)) throw new UserError('The docs are already being updated. The result will appear here in a minute or two.');
    running.add(project.name);
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      let result;
      try {
        result = await writeDocs(ctx, project, interaction.channel);
      } catch (error) {
        if (error instanceof GeminiError) throw new UserError(`Couldn't write the docs: ${error.message}`);
        throw error;
      }
      const secret = secretInDocs(result.files);
      if (secret) {
        log.warn('docs not committed: they looked like they held a secret', { project: project.name });
        throw new UserError(`Nothing was committed: the docs seem to contain ${secret}. Remove it from the chat or ask me to look into it.`);
      }

      let commit;
      let pull;
      try {
        commit = await ctx.github.commitToBranch(project.repo, DOCS_BRANCH, result.files, `Update project docs from Discordlancer\n\nAI-written (${SPEC_MODEL}, ${DOCS_PROMPT_VERSION}) from the project's chat, calls and specs.`);
        if (commit.changed) {
          pull = await ctx.github.upsertPull(project.repo, DOCS_BRANCH, `Project docs: ${project.name}`, pullBody(result, { changedPaths: commit.paths }));
        }
      } catch (error) {
        if (githubStatus(error) === 403) {
          throw new UserError("GitHub refused: the bot's GitHub token needs **Contents: Read and write** and **Pull requests: Read and write** for this repo. Add them to the token, then try again.");
        }
        if (error instanceof GitHubError) throw new UserError(error.message);
        throw error;
      }

      const data = {
        changed: commit.changed,
        ...(commit.changed ? { commit: commit.sha, files: commit.paths.length } : {}),
        ...(pull ? { pr: pull.number } : {}),
        unmatched_citations: result.citations.unmatched.length,
        model: SPEC_MODEL,
        prompt_version: DOCS_PROMPT_VERSION,
      };
      await recordEvent(ctx.db, { actor: 'owner', actorId: interaction.user.id, action: 'docs.synced', outcome: 'ok', project: project.id, data }).catch((error: unknown) =>
        log.error('could not record a docs sync', { error }),
      );

      if (!commit.changed || !pull) {
        await interaction.editReply('The docs in the repo are already up to date; nothing changed.');
        return;
      }
      const check = result.citations.unmatched.length ? ` ${result.citations.unmatched.length} citation(s) couldn't be matched to a source: they're listed in the pull request.` : '';
      const summary = [
        `${pull.created ? 'Opened' : 'Updated'} the docs pull request for **${project.name}**: ${pull.url}`,
        `${commit.paths.length} file(s) changed.${check} Review it and merge it; Claude Code reads the docs from the main branch.`,
      ].join('\n');
      await interaction.editReply(summary);
      const desk = await ensureOwnerChannel(interaction.guild, ctx.env.DISCORD_OWNER_ID).catch(() => undefined);
      await desk?.send(summary).catch(() => undefined);
    } finally {
      running.delete(project.name);
    }
  },
};
