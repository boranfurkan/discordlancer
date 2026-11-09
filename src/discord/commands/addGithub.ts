// /add-github username: gives a GitHub account read-only access to the project repo.

import { SlashCommandBuilder } from 'discord.js';
import { updateProject } from '../../db/projects.js';
import { GitHubError } from '../../services/github.js';
import { requireProject, UserError, type Command } from '../command.js';

const description = "Add a GitHub account to this project's repo";

export const addGithub: Command = {
  name: 'add-github',
  description,
  access: 'everyone',
  where: 'project',
  stages: ['created', 'joined', 'specs_agreed', 'quote_accepted', 'paid', 'in_development', 'delivered', 'support'],
  definition: new SlashCommandBuilder()
    .setName('add-github')
    .setDescription(description)
    .addStringOption((option) =>
      option.setName('username').setDescription('GitHub username, like octocat').setRequired(true).setMaxLength(39),
    )
    .toJSON(),

  async execute(run) {
    const project = requireProject(run);
    const { interaction, ctx, actor } = run;
    const username = interaction.options.getString('username', true).trim().replace(/^@/, '');
    await interaction.deferReply();

    let result;
    try {
      result = await ctx.github.addCollaborator(project.repo, username);
    } catch (error) {
      if (error instanceof GitHubError) throw new UserError(error.message);
      throw error;
    }

    await updateProject(
      ctx.db,
      project,
      { client_github: username },
      { actor, actorId: interaction.user.id, action: 'project.github_added', outcome: 'ok', data: { username, result } },
    );
    await interaction.editReply(
      result === 'invited'
        ? `Invited **${username}** to \`${project.repo}\` with read-only access (they can see and clone the code). GitHub has emailed them an invitation to accept.`
        : `**${username}** already has access to \`${project.repo}\`.`,
    );
  },
};
