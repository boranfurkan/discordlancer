// /create-specs and /agree-specs.

import { AttachmentBuilder, ChannelType, SlashCommandBuilder } from 'discord.js';
import { callsFor } from '../../db/calls.js';
import { renderCalls } from '../../voice/callText.js';
import { addAgreement, agreedParties, latestSpec, saveSpec, VersionTakenError } from '../../db/deals.js';
import { moveStage } from '../../db/projects.js';
import { log } from '../../log.js';
import { SPEC_PROMPT_VERSION, SPEC_SCHEMA, SPEC_SYSTEM, SpecOutput } from '../../prompts/specs.js';
import { GeminiError, SPEC_MODEL } from '../../services/gemini.js';
import { projectScope, safeRecall, safeRemember } from '../../services/memory.js';
import { requireProject, UserError, type Command } from '../command.js';
import { OWNER_NAME } from '../guards.js';
import { fitMessage } from '../texts.js';
import { buildSpecInput, readConversation } from '../transcript.js';

const createDescription = 'Write the next spec version from this conversation (AI-drafted)';

export const createSpecs: Command = {
  name: 'create-specs',
  description: createDescription,
  access: 'owner',
  where: 'project',
  stages: ['joined', 'specs_agreed', 'quote_accepted'],
  definition: new SlashCommandBuilder().setName('create-specs').setDescription(createDescription).toJSON(),

  async execute(run) {
    const project = requireProject(run);
    const { interaction, ctx } = run;
    if (interaction.channel?.type !== ChannelType.GuildText) throw new UserError('Run this in the project channel.');
    await interaction.deferReply();

    const messages = await readConversation(interaction.channel, project.created_at, {
      ownerId: ctx.env.DISCORD_OWNER_ID,
      clientId: project.client_id,
    });
    if (messages.length === 0) {
      throw new UserError('There are no messages to write specs from yet. Talk about the project here first.');
    }
    const previous = await latestSpec(ctx.db, project);
    const memory = await safeRecall(ctx.memory, projectScope(project.name), 'Decisions, preferences and constraints agreed for this project');
    const calls = renderCalls(await callsFor(ctx.db, project));
    const { input, plan } = await buildSpecInput(messages, previous, memory, calls);

    let output;
    try {
      output = await ctx.gemini.json({
        model: SPEC_MODEL,
        system: SPEC_SYSTEM,
        input,
        schema: SPEC_SCHEMA,
        parse: SpecOutput,
        maxOutputTokens: 16_000,
        thinking: 'medium',
      });
    } catch (error) {
      if (error instanceof GeminiError) throw new UserError(`Couldn't write the specs: ${error.message}`);
      throw error;
    }

    let version;
    try {
      version = await saveSpec(
        ctx.db,
        project,
        {
          markdown: output.markdown,
          changes: output.changes,
          openQuestions: output.open_questions,
          messageCount: messages.length,
          model: SPEC_MODEL,
          promptVersion: SPEC_PROMPT_VERSION,
        },
        {
          actor: 'owner',
          actorId: interaction.user.id,
          action: 'spec.created',
          outcome: 'ok',
          data: { messages: messages.length, images: plan.images.length, skipped: plan.skipped.map((item) => item.name) },
        },
      );
    } catch (error) {
      if (error instanceof VersionTakenError) throw new UserError(error.message);
      throw error;
    }

    const reset = project.stage !== 'joined';
    const lines = [
      `**Spec v${version}** for **${project.name}**, drafted with AI from ${messages.length} message(s). ${OWNER_NAME} checks it before agreeing.`,
      '',
      output.summary,
    ];
    if (previous && output.changes.length) lines.push('', `**Changes since v${previous.version}:**`, ...output.changes.map((c) => `- ${c}`));
    if (output.open_questions.length) lines.push('', '**Open questions:**', ...output.open_questions.map((q) => `- ${q}`));
    if (plan.skipped.length) lines.push('', `Not read: ${plan.skipped.map((item) => `${item.name} (${item.reason})`).join(', ')}`);
    if (reset) lines.push('', 'This is a new version, so any earlier agreement or accepted quote no longer applies.');
    lines.push('', `Both of you: read the attached file, then run **/agree-specs** to agree to v${version}.`);

    const file = new AttachmentBuilder(Buffer.from(output.markdown, 'utf8'), { name: `${project.name}-spec-v${version}.md` });
    const message = await interaction.editReply({ content: fitMessage(lines.join('\n')), files: [file] });
    await message.pin().catch((error: unknown) => log.warn('could not pin the spec', { error }));
  },
};

const agreeDescription = 'Agree to the current spec version';

export const agreeSpecs: Command = {
  name: 'agree-specs',
  description: agreeDescription,
  access: 'everyone',
  where: 'project',
  stages: ['joined'],
  definition: new SlashCommandBuilder().setName('agree-specs').setDescription(agreeDescription).toJSON(),

  async execute(run) {
    const project = requireProject(run);
    const { interaction, ctx, actor } = run;
    const spec = await latestSpec(ctx.db, project);
    if (!spec) throw new UserError(`There are no specs yet. ${OWNER_NAME} writes them with /create-specs.`);
    const party = actor === 'owner' ? 'owner' : 'client';

    const result = await addAgreement(ctx.db, project, 'spec', spec.version, party, interaction.user.id, {
      actor,
      actorId: interaction.user.id,
      action: 'spec.agreed',
      outcome: 'ok',
    });
    if (result === 'already') throw new UserError(`You've already agreed to spec v${spec.version}.`);

    const parties = await agreedParties(ctx.db, project, 'spec', spec.version);
    const stillLatest = (await latestSpec(ctx.db, project))?.version === spec.version;
    if (parties.has('owner') && parties.has('client') && stillLatest) {
      await moveStage(ctx.db, project, 'joined', 'specs_agreed', {
        actor: 'bot',
        action: 'specs.agreed_by_both',
        outcome: 'ok',
        data: { version: spec.version },
      });
      await interaction.reply(`Both sides agreed to **spec v${spec.version}**. Next, ${OWNER_NAME} posts a quote with /quote.`);
      await safeRemember(ctx.memory, projectScope(project.name), `Both sides agreed spec v${spec.version} for ${project.name}:\n${spec.markdown.slice(0, 3_000)}`);
      return;
    }
    const waitingFor = party === 'owner' ? (project.client_id ? `<@${project.client_id}>` : 'the client') : OWNER_NAME;
    await interaction.reply(`<@${interaction.user.id}> agreed to **spec v${spec.version}**. Waiting for ${waitingFor}.`);
  },
};
