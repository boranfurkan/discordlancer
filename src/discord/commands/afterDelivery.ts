// /progress and /request-update, with the approve and decline buttons for change
// requests. Approving opens a GitHub issue with the `tessl` label; the Tessl factory
// then proposes a pull request, which Boran reviews before anything is merged.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  SlashCommandBuilder,
  type ButtonInteraction,
} from 'discord.js';
import { countChangeRequestsSince, createChangeRequest, getChangeRequest, updateChangeRequest, type ChangeStatus } from '../../db/changes.js';
import { latestSpec } from '../../db/deals.js';
import { countEventsSince, recordEvent } from '../../db/events.js';
import { getProject, moveStage } from '../../db/projects.js';
import { londonDayStart } from '../../domain/deadline.js';
import {
  issueBody,
  STATUS_PROMPT_VERSION,
  STATUS_SCHEMA,
  STATUS_SYSTEM,
  StatusOutput,
  TRIAGE_PROMPT_VERSION,
  TRIAGE_SCHEMA,
  TRIAGE_SYSTEM,
  TriageOutput,
} from '../../prompts/after-delivery.js';
import { FAST_MODEL, GeminiError, SPEC_MODEL } from '../../services/gemini.js';
import { GitHubError } from '../../services/github.js';
import { projectScope, safeRecall, safeRemember } from '../../services/memory.js';
import { ensureOwnerChannel } from '../channels.js';
import { requireProject, UserError, type BotContext, type Command } from '../command.js';
import { OWNER_NAME } from '../guards.js';
import { fitMessage } from '../texts.js';

export const STATUS_PER_DAY = 3;
export const REQUESTS_PER_30_DAYS = 10;
export const TESSL_LABEL = 'tessl';
export const APPROVE_PREFIX = 'dl:cr-approve:';
export const DECLINE_PREFIX = 'dl:cr-decline:';

const fence = (tag: string, text: string, attrs = '') => `<${tag}${attrs}>\n${text}\n</${tag}>`;

const statusDescription = 'Get an AI estimate of progress against the agreed spec';

// Named /progress, not /progress: other apps (Wordle, in our server) already use /progress.
export const status: Command = {
  name: 'progress',
  description: statusDescription,
  access: 'everyone',
  where: 'project',
  stages: ['in_development', 'delivered', 'support'],
  definition: new SlashCommandBuilder().setName('progress').setDescription(statusDescription).toJSON(),

  async execute(run) {
    const project = requireProject(run);
    const { interaction, ctx, actor } = run;
    const used = await countEventsSince(ctx.db, project.id, 'status.checked', londonDayStart());
    if (used >= STATUS_PER_DAY) throw new UserError(`Progress can be checked ${STATUS_PER_DAY} times a day. Please try again tomorrow.`);
    const spec = await latestSpec(ctx.db, project);
    if (!spec) throw new UserError('There is no agreed spec to compare with.');
    await interaction.deferReply();

    let snapshot;
    try {
      snapshot = await ctx.github.readRepo(project.repo);
    } catch {
      throw new UserError("Couldn't read the repo right now. Please try again in a few minutes.");
    }
    const memory = await safeRecall(ctx.memory, projectScope(project.name), 'Decisions, changes and preferences for this project');
    const input = [
      fence('spec', spec.markdown, ` version="${spec.version}"`),
      memory ? fence('memory', memory) : '',
      fence('file_list', snapshot.paths.slice(0, 500).join('\n')),
      ...snapshot.files.map((file) => fence('file', file.content, ` path="${file.path}"`)),
    ]
      .filter(Boolean)
      .join('\n\n');

    let output;
    try {
      output = await ctx.gemini.json({
        model: SPEC_MODEL,
        system: STATUS_SYSTEM,
        input: [{ type: 'text', text: input }],
        schema: STATUS_SCHEMA,
        parse: StatusOutput,
        thinking: 'low',
      });
    } catch (error) {
      if (error instanceof GeminiError) throw new UserError(`Couldn't estimate progress: ${error.message}`);
      throw error;
    }

    await recordEvent(ctx.db, {
      actor,
      actorId: interaction.user.id,
      action: 'status.checked',
      outcome: 'ok',
      project: project.id,
      data: { percent: output.percent, commit: snapshot.commit, spec_version: spec.version, model: SPEC_MODEL, prompt_version: STATUS_PROMPT_VERSION },
    });
    const lines = [
      `**Progress estimate: about ${output.percent}%**`,
      `AI estimate from the code on \`${snapshot.branch}\` at \`${snapshot.commit.slice(0, 7)}\`, compared with spec v${spec.version}. Not a measurement; confidence ${output.confidence}.`,
      '',
      output.summary,
    ];
    if (output.done.length) lines.push('', '**Done:**', ...output.done.map((item) => `- ${item}`));
    if (output.remaining.length) lines.push('', '**Still to do:**', ...output.remaining.map((item) => `- ${item}`));
    await interaction.editReply(fitMessage(lines.join('\n')));
  },
};

function decisionRow(key: string, disabled = false) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${APPROVE_PREFIX}${key}`).setLabel('Approve').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`${DECLINE_PREFIX}${key}`).setLabel('Decline').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
  );
}

const requestDescription = 'Ask for a small change after delivery';

export const requestUpdate: Command = {
  name: 'request-update',
  description: requestDescription,
  access: 'everyone',
  where: 'project',
  stages: ['delivered', 'support'],
  definition: new SlashCommandBuilder()
    .setName('request-update')
    .setDescription(requestDescription)
    .addStringOption((option) =>
      option.setName('details').setDescription('What should change, as clearly as you can').setRequired(true).setMaxLength(1500),
    )
    .toJSON(),

  async execute(run) {
    const project = requireProject(run);
    const { interaction, ctx, actor } = run;
    const text = interaction.options.getString('details', true).trim();
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    if ((await countChangeRequestsSince(ctx.db, project, monthAgo)) >= REQUESTS_PER_30_DAYS) {
      throw new UserError(`There have been ${REQUESTS_PER_30_DAYS} change requests in the last 30 days. Please talk to ${OWNER_NAME} directly.`);
    }
    await interaction.deferReply();

    const spec = await latestSpec(ctx.db, project);
    const scope = projectScope(project.name);
    const memory = await safeRecall(ctx.memory, scope, text);
    let triage;
    try {
      triage = await ctx.gemini.json({
        model: FAST_MODEL,
        system: TRIAGE_SYSTEM,
        input: [
          {
            type: 'text',
            text: [fence('request', text), spec ? fence('spec', spec.markdown, ` version="${spec.version}"`) : '', memory ? fence('memory', memory) : '']
              .filter(Boolean)
              .join('\n\n'),
          },
        ],
        schema: TRIAGE_SCHEMA,
        parse: TriageOutput,
        thinking: 'low',
      });
    } catch (error) {
      if (error instanceof GeminiError) throw new UserError(`Couldn't read the request: ${error.message}`);
      throw error;
    }

    const statusFor: Record<typeof triage.decision, ChangeStatus> = { small: 'triaged', needs_info: 'needs_info', quote: 'declined' };
    const request = await createChangeRequest(
      ctx.db,
      project,
      { text, triage: { ...triage, model: FAST_MODEL, prompt_version: TRIAGE_PROMPT_VERSION, spec_version: spec?.version ?? null }, status: statusFor[triage.decision] },
      { actor, actorId: interaction.user.id, action: 'change.requested', outcome: 'ok', data: { decision: triage.decision } },
    );
    if (project.stage === 'delivered') {
      await moveStage(ctx.db, project, 'delivered', 'support', { actor: 'bot', action: 'support.started', outcome: 'ok' });
    }
    await safeRemember(ctx.memory, scope, `Change request for ${project.name}: "${text}". Triaged as ${triage.decision}: ${triage.reason}`);

    const key = String(request.id.id);
    if (triage.decision === 'small') {
      await interaction.editReply({
        content: fitMessage(
          [`Change request noted: **${triage.title}**`, triage.reason, '', `${OWNER_NAME} reviews it before anything changes.`].join('\n'),
        ),
        components: [decisionRow(key)],
      });
    } else if (triage.decision === 'needs_info') {
      await interaction.editReply(
        fitMessage(
          ['A few questions first:', ...triage.questions.map((q) => `- ${q}`), '', 'Reply here, then run /request-update again with the details.'].join('\n'),
        ),
      );
    } else {
      await interaction.editReply(
        fitMessage([triage.reason, '', `This is more than a small change, so it needs a new quote. ${OWNER_NAME} will follow up.`].join('\n')),
      );
      try {
        const owner = await ensureOwnerChannel(interaction.guild, ctx.env.DISCORD_OWNER_ID);
        await owner.send(fitMessage(`**${project.name}**: a change request needs a new quote.\n> ${text}\n${triage.reason}`));
      } catch {
        // The reply in the project channel already says Furkan will follow up.
      }
    }
  },
};

async function decide(interaction: ButtonInteraction<'cached'>, ctx: BotContext, approve: boolean): Promise<void> {
  if (interaction.user.id !== ctx.env.DISCORD_OWNER_ID) {
    await interaction.reply({ content: `Only ${OWNER_NAME} can approve or decline changes.`, flags: MessageFlags.Ephemeral });
    return;
  }
  const key = interaction.customId.slice((approve ? APPROVE_PREFIX : DECLINE_PREFIX).length);
  const request = await getChangeRequest(ctx.db, key);
  const project = request ? await getProject(ctx.db, request.project) : undefined;
  if (!request || !project) throw new UserError('That change request no longer exists.');
  const owner = { actor: 'owner', actorId: interaction.user.id, outcome: 'ok' } as const;

  if (!approve) {
    if (!(await updateChangeRequest(ctx.db, request, 'triaged', { status: 'declined' }, { ...owner, action: 'change.declined' }))) {
      throw new UserError('This request has already been handled.');
    }
    await interaction.update({ components: [decisionRow(key, true)] });
    await interaction.followUp(`${OWNER_NAME} declined this change request.`);
    return;
  }

  // From triaged, approve first. From approved (an earlier attempt failed to open the issue), retry.
  if (request.status === 'triaged') {
    if (!(await updateChangeRequest(ctx.db, request, 'triaged', { status: 'approved' }, { ...owner, action: 'change.approved' }))) {
      throw new UserError('This request has already been handled.');
    }
  } else if (request.status !== 'approved') {
    throw new UserError('This request has already been handled.');
  }
  await interaction.deferUpdate();
  const triage = TriageOutput.partial().parse(request.triage ?? {});
  const spec = await latestSpec(ctx.db, project);
  let issue;
  try {
    issue = await ctx.github.openIssue(
      project.repo,
      triage.title ?? 'Change request',
      issueBody(project.name, triage.task || request.text, request.text, spec?.version),
      [TESSL_LABEL],
    );
  } catch (error) {
    const reason = error instanceof GitHubError ? error.message : 'GitHub did not respond as expected';
    throw new UserError(`Approved, but opening the GitHub issue failed (${reason}). Press Approve again to retry.`);
  }
  await updateChangeRequest(ctx.db, request, 'approved', { status: 'issue_opened', issue_number: issue.number }, {
    ...owner,
    action: 'change.issue_opened',
    data: { issue: issue.number, label: TESSL_LABEL },
  });
  await safeRemember(ctx.memory, projectScope(project.name), `Approved change for ${project.name}: ${triage.title ?? request.text} (GitHub issue #${issue.number}).`);
  await interaction.editReply({ components: [decisionRow(key, true)] });
  await interaction.followUp(
    `Approved. Opened issue #${issue.number}: ${issue.url}\nTessl will propose the change as a pull request, which ${OWNER_NAME} reviews before it's merged.`,
  );
}

export const onApproveChange = (interaction: ButtonInteraction<'cached'>, ctx: BotContext) => decide(interaction, ctx, true);
export const onDeclineChange = (interaction: ButtonInteraction<'cached'>, ctx: BotContext) => decide(interaction, ctx, false);
