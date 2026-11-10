// /read-files: reads anything shared in the channel that has no notes yet: files posted
// while the bot was down, reads that failed, or what was left over a daily limit.
// Specs and docs do this by themselves for a few files; this reads up to 30 messages' worth.

import { ChannelType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { fileNotesFor } from '../../db/files.js';
import { recordEvent } from '../../db/events.js';
import { log } from '../../log.js';
import { requireProject, UserError, type Command } from '../command.js';
import { READ_STAGES, readUnreadFiles } from '../files.js';

const description = 'Read the files and links shared here that have no notes yet';

const running = new Set<string>();

export const readFiles: Command = {
  name: 'read-files',
  description,
  access: 'owner',
  where: 'project',
  stages: READ_STAGES,
  definition: new SlashCommandBuilder().setName('read-files').setDescription(description).toJSON(),

  async execute(run) {
    const project = requireProject(run);
    const { interaction, ctx } = run;
    if (interaction.channel?.type !== ChannelType.GuildText) throw new UserError('Run this in the project channel.');
    if (!ctx.files || !ctx.botId) throw new UserError("The file reader isn't running. Try again in a minute.");
    if (running.has(project.name)) throw new UserError('The files are already being read.');
    running.add(project.name);
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const totals = await readUnreadFiles(ctx, ctx.files, project, interaction.channel, ctx.botId, 30);
      const all = await fileNotesFor(ctx.db, project);
      await recordEvent(ctx.db, { actor: 'owner', actorId: interaction.user.id, action: 'files.read_requested', outcome: 'ok', project: project.id, data: totals }).catch((error: unknown) =>
        log.error('could not record a file read', { error }),
      );
      const done = totals.read + totals.skipped + totals.failed === 0 ? 'Everything shared here already has notes.' : `Read ${totals.read}, couldn't read ${totals.skipped}${totals.failed ? `, failed ${totals.failed} (see owner-desk)` : ''}.`;
      await interaction.editReply(
        [
          done,
          totals.left ? `${totals.left} message(s) with files are still waiting; run /read-files again${totals.read + totals.skipped + totals.failed === 0 ? ' tomorrow (today\'s limit is reached)' : ''}.` : '',
          `This project has notes on ${all.filter((note) => note.status === 'read').length} file(s) and link(s); they're in the 📎 Files thread.`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    } finally {
      running.delete(project.name);
    }
  },
};
