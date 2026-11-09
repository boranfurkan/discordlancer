// /export, /report and /touches: Boran's evidence and hackathon paperwork.

import { AttachmentBuilder, ChannelType, MessageFlags, SlashCommandBuilder, type TextChannel } from 'discord.js';
import { listAgreements, listQuotes, listSpecs } from '../../db/deals.js';
import { eventsForProject, eventsSince } from '../../db/events.js';
import { allPayments, paymentsFor } from '../../db/payments.js';
import { londonDayStart } from '../../domain/deadline.js';
import { ensureOwnerChannel } from '../channels.js';
import { requireProject, type Command } from '../command.js';
import { exportSummary, salesReport, touchLine, transcriptMarkdown, type TranscriptLine } from '../evidence.js';

const MAX_MESSAGES = 5_000;
const MAX_SPEC_FILES = 6; // Discord allows 10 files per message.

async function readAll(channel: TextChannel): Promise<TranscriptLine[]> {
  const lines: TranscriptLine[] = [];
  let before: string | undefined;
  while (lines.length < MAX_MESSAGES) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (batch.size === 0) break;
    for (const message of batch.values()) {
      lines.push({
        at: message.createdAt,
        author: message.member?.displayName ?? message.author.username,
        bot: message.author.bot,
        text: message.content || (message.embeds.length ? '[embed]' : ''),
        attachments: [...message.attachments.values()].map((attachment) => attachment.url),
      });
    }
    before = batch.last()?.id;
    if (batch.size < 100) break;
  }
  return lines.sort((a, b) => a.at.getTime() - b.at.getTime());
}

const exportDescription = 'Build the evidence pack for this project (sent to owner-desk)';

export const exportEvidence: Command = {
  name: 'export',
  description: exportDescription,
  access: 'owner',
  where: 'project',
  definition: new SlashCommandBuilder().setName('export').setDescription(exportDescription).toJSON(),

  async execute(run) {
    const project = requireProject(run);
    const { interaction, ctx } = run;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const [specs, quotes, agreements, payments, events] = await Promise.all([
      listSpecs(ctx.db, project),
      listQuotes(ctx.db, project),
      listAgreements(ctx.db, project),
      paymentsFor(ctx.db, project),
      eventsForProject(ctx.db, project.id),
    ]);
    const generatedAt = new Date();
    const stamp = generatedAt.toISOString().slice(0, 10);
    const transcript = interaction.channel?.type === ChannelType.GuildText ? await readAll(interaction.channel) : [];

    const files = [
      new AttachmentBuilder(Buffer.from(exportSummary({ project, specs, quotes, agreements, payments, events, generatedAt })), {
        name: `${project.name}-evidence-${stamp}.md`,
      }),
      new AttachmentBuilder(Buffer.from(transcriptMarkdown(project.name, transcript)), { name: `${project.name}-transcript-${stamp}.md` }),
      new AttachmentBuilder(Buffer.from(`${JSON.stringify(events, null, 2)}\n`), { name: `${project.name}-events-${stamp}.json` }),
      ...specs.slice(-MAX_SPEC_FILES).map(
        (spec) => new AttachmentBuilder(Buffer.from(spec.markdown), { name: `${project.name}-spec-v${spec.version}.md` }),
      ),
    ];
    const owner = await ensureOwnerChannel(interaction.guild, ctx.env.DISCORD_OWNER_ID);
    const skipped = specs.length > MAX_SPEC_FILES ? ` Only the latest ${MAX_SPEC_FILES} spec versions are attached.` : '';
    await owner.send({
      content: `Evidence pack for **${project.name}**: summary, transcript (${transcript.length} messages), ${events.length} events and specs.${skipped}`,
      files,
    });
    await interaction.editReply(`Evidence pack sent to <#${owner.id}>.`);
  },
};

const reportDescription = "Draft today's USDC sales report for the organisers";

export const report: Command = {
  name: 'report',
  description: reportDescription,
  access: 'owner',
  where: 'anywhere',
  definition: new SlashCommandBuilder().setName('report').setDescription(reportDescription).toJSON(),
  async execute({ interaction, ctx }) {
    const now = new Date();
    const text = salesReport(await allPayments(ctx.db), londonDayStart(now), ctx.env.SOLANA_WALLET_ADDRESS, now);
    await interaction.reply({
      content: `Copy this into your team channel before 6pm (test projects are left out):\n\`\`\`\n${text}\n\`\`\``,
      flags: MessageFlags.Ephemeral,
    });
  },
};

const touchesDescription = "Draft today's /touch line from your recorded actions";

export const touches: Command = {
  name: 'touches',
  description: touchesDescription,
  access: 'owner',
  where: 'anywhere',
  definition: new SlashCommandBuilder().setName('touches').setDescription(touchesDescription).toJSON(),
  async execute({ interaction, ctx }) {
    const line = touchLine(await eventsSince(ctx.db, londonDayStart(), 'owner'));
    await interaction.reply({
      content: [
        `Draft for the hackathon's /touch (one sitting is one touch):\n\`\`\`\n${line}\n\`\`\``,
        'Add your own build sessions and calls; the bot only sees what happened in Discord.',
      ].join('\n'),
      flags: MessageFlags.Ephemeral,
    });
  },
};
