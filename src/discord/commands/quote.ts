// /quote amount deadline and /accept-quote. Posting a quote counts as Boran's
// acceptance, so only the client has to accept it.

import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { addAgreement, agreedParties, latestQuote, latestSpec, saveQuote, VersionTakenError } from '../../db/deals.js';
import { moveStage } from '../../db/projects.js';
import { DeadlineError, formatDeadline, isAfterFreeze, parseDeadline } from '../../domain/deadline.js';
import { formatUsdc, MoneyError, parseUsdc } from '../../domain/money.js';
import { requireProject, UserError, type Command } from '../command.js';
import { OWNER_NAME } from '../guards.js';
import { clientMentions, quoteTerms } from '../texts.js';
import { projectScope, safeRemember } from '../../services/memory.js';
import { depositFor, paymentPlan } from '../../domain/deposit.js';

const quoteDescription = 'Post a quote for the agreed spec, in USDC';

export const quote: Command = {
  name: 'quote',
  description: quoteDescription,
  access: 'owner',
  where: 'project',
  stages: ['specs_agreed', 'quote_accepted'],
  definition: new SlashCommandBuilder()
    .setName('quote')
    .setDescription(quoteDescription)
    .addStringOption((option) => option.setName('amount').setDescription('Price in USDC, like 250 or 250.50').setRequired(true))
    .addStringOption((option) =>
      option.setName('deadline').setDescription('London time: YYYY-MM-DD (6pm) or YYYY-MM-DD HH:MM').setRequired(true),
    )
    .addIntegerOption((option) =>
      option.setName('deposit').setDescription('Optional: a deposit, as a % of the price, paid before work starts; the rest on delivery').setMinValue(10).setMaxValue(90),
    )
    .toJSON(),

  async execute(run) {
    const project = requireProject(run);
    const { interaction, ctx } = run;
    let amountMicro: number;
    let deadline: Date;
    try {
      amountMicro = parseUsdc(interaction.options.getString('amount', true));
      deadline = parseDeadline(interaction.options.getString('deadline', true));
    } catch (error) {
      if (error instanceof MoneyError || error instanceof DeadlineError) throw new UserError(error.message);
      throw error;
    }
    const spec = await latestSpec(ctx.db, project);
    if (!spec) throw new UserError('There is no agreed spec to quote for.');
    const percent = interaction.options.getInteger('deposit');
    if (percent !== null && amountMicro < 20_000) throw new UserError('That price is too small to split into a deposit and a balance.');
    const depositMicro = percent === null ? undefined : depositFor(amountMicro, percent);

    const amount = formatUsdc(amountMicro);
    const when = formatDeadline(deadline);
    const terms = quoteTerms(spec.version, amount, when, depositMicro ? { deposit: formatUsdc(depositMicro), balance: formatUsdc(amountMicro - depositMicro) } : undefined);
    let version;
    try {
      version = await saveQuote(
        ctx.db,
        project,
        { amountMicro, deadline, specVersion: spec.version, terms: terms.join('\n'), depositMicro },
        ctx.env.DISCORD_OWNER_ID,
        { actor: 'owner', actorId: interaction.user.id, action: 'quote.created', outcome: 'ok', data: { spec_version: spec.version, ...(percent !== null ? { deposit_percent: percent } : {}) } },
      );
    } catch (error) {
      if (error instanceof VersionTakenError) throw new UserError(error.message);
      throw error;
    }

    const client = clientMentions(project);
    const lines = [
      `**Quote v${version}** for **${project.name}** (spec v${spec.version})`,
      depositMicro
        ? `- Price: **${amount} USDC** on Solana: **${formatUsdc(depositMicro)} USDC** deposit (${percent}%) before work starts, **${formatUsdc(amountMicro - depositMicro)} USDC** on delivery`
        : `- Price: **${amount} USDC**, paid on Solana`,
      `- Delivery by: **${when}**`,
      '',
      '**Terms**',
      ...terms.map((term) => `- ${term}`),
      '',
      project.stage === 'quote_accepted' ? 'This replaces the quote accepted earlier, so it needs accepting again.' : '',
      `${client}, if you agree, run **/accept-quote**. Posting it counts as ${OWNER_NAME}'s acceptance.`,
    ].filter((line, index, all) => line !== '' || all[index - 1] !== '');
    await interaction.reply(lines.join('\n'));

    if (isAfterFreeze(deadline)) {
      await interaction.followUp({
        content:
          "Heads up: this deadline is after the hackathon freeze (Wed 18 Nov, 6pm). The sale only counts if it's paid **and delivered** before then.",
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};

const acceptDescription = 'Accept the current quote';

export const acceptQuote: Command = {
  name: 'accept-quote',
  description: acceptDescription,
  access: 'everyone',
  where: 'project',
  stages: ['specs_agreed'],
  definition: new SlashCommandBuilder().setName('accept-quote').setDescription(acceptDescription).toJSON(),

  async execute(run) {
    const project = requireProject(run);
    const { interaction, ctx, actor } = run;
    if (actor === 'owner') throw new UserError('Posting the quote already counts as your acceptance. The client accepts it.');
    const current = await latestQuote(ctx.db, project);
    if (!current) throw new UserError(`There is no quote yet. ${OWNER_NAME} posts one with /quote.`);
    const spec = await latestSpec(ctx.db, project);
    if (!spec || current.spec_version !== spec.version) {
      throw new UserError(`This quote is for an older spec. Ask ${OWNER_NAME} for a new quote.`);
    }

    const result = await addAgreement(ctx.db, project, 'quote', current.version, 'client', interaction.user.id, {
      actor,
      actorId: interaction.user.id,
      action: 'quote.accepted',
      outcome: 'ok',
    });
    // Anyone on the client's team accepts for the whole team, once.
    if (result === 'already') throw new UserError(`Your side has already accepted quote v${current.version}.`);

    const parties = await agreedParties(ctx.db, project, 'quote', current.version);
    const stillLatest = (await latestQuote(ctx.db, project))?.version === current.version;
    if (!parties.has('owner') || !parties.has('client') || !stillLatest) {
      throw new UserError('The quote changed while you were accepting it. Check the newest quote and try again.');
    }
    await moveStage(ctx.db, project, 'specs_agreed', 'quote_accepted', {
      actor: 'bot',
      action: 'quote.accepted_by_both',
      outcome: 'ok',
      data: { version: current.version, amount_micro: current.amount_micro },
    });
    await interaction.reply(
      [
        `<@${interaction.user.id}> accepted **quote v${current.version}**: ${paymentPlan(current)}; delivery by ${formatDeadline(current.deadline)}.`,
        `Next: declare the Solana wallet you will pay from with **/set-payment-wallet**, then pay ${current.deposit_micro ? 'the deposit ' : ''}with **/pay**.`,
      ].join('\n'),
    );
    await safeRemember(
      ctx.memory,
      projectScope(project.name),
      `Quote v${current.version} for ${project.name} was accepted: ${paymentPlan(current)}; delivery by ${formatDeadline(current.deadline)}.`,
    );
  },
};
