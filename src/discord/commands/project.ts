// /project: the project card. Specs, quote and payment lines fill in as those phases land.

import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Project } from '../../db/projects.js';
import { requireProject, type Command } from '../command.js';
import { NEXT_STEP, STAGE_LABEL } from '../texts.js';

/** Pure: the card's fields, so the wording can be tested. */
export function projectCard(project: Project): { title: string; fields: Array<{ name: string; value: string }> } {
  return {
    title: project.name,
    fields: [
      { name: 'Stage', value: STAGE_LABEL[project.stage] },
      { name: 'Next', value: NEXT_STEP[project.stage] },
      { name: 'Client', value: project.client_id ? `<@${project.client_id}>` : 'Not joined yet' },
      { name: 'Repo', value: `https://github.com/${project.repo}` },
      { name: 'GitHub access', value: project.client_github ?? 'No GitHub account added yet (use /add-github)' },
      { name: 'Started', value: `<t:${Math.floor(project.created_at.getTime() / 1000)}:D>` },
    ],
  };
}

const description = 'Show where this project stands';

export const projectInfo: Command = {
  name: 'project',
  description,
  access: 'everyone',
  where: 'project',
  definition: new SlashCommandBuilder().setName('project').setDescription(description).toJSON(),
  async execute(run) {
    const card = projectCard(requireProject(run));
    const embed = new EmbedBuilder().setTitle(card.title).addFields(card.fields);
    await run.interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
