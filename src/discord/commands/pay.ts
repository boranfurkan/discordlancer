// /pay, /paid, /receipt and /start-development.

import { AttachmentBuilder, EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { latestQuote } from '../../db/deals.js';
import { createRequest, openRequest, paymentBySignature, paymentsFor } from '../../db/payments.js';
import { moveStage } from '../../db/projects.js';
import { formatUsdc } from '../../domain/money.js';
import { explorerUrl, solanaPayUrl, verifyPayment } from '../../domain/payment.js';
import { newReference, qrPng } from '../../services/solana.js';
import { requireProject, UserError, type Command } from '../command.js';
import { OWNER_NAME } from '../guards.js';
import { settlePayment } from '../payments.js';

const payDescription = 'Get the Solana Pay QR code for the accepted quote';

export const pay: Command = {
  name: 'pay',
  description: payDescription,
  access: 'everyone',
  where: 'project',
  stages: ['quote_accepted'],
  definition: new SlashCommandBuilder().setName('pay').setDescription(payDescription).toJSON(),

  async execute(run) {
    const project = requireProject(run);
    const { interaction, ctx, actor } = run;
    if (!project.client_wallet) throw new UserError('First declare the wallet you will pay from with /set-payment-wallet.');
    const current = await latestQuote(ctx.db, project);
    if (!current) throw new UserError('There is no accepted quote to pay.');
    await interaction.deferReply();

    const request =
      (await openRequest(ctx.db, project, current.version)) ??
      (await createRequest(
        ctx.db,
        project,
        { quoteVersion: current.version, amountMicro: current.amount_micro, reference: await newReference() },
        { actor, actorId: interaction.user.id, action: 'payment.requested', outcome: 'ok' },
      ));

    const amount = formatUsdc(request.amount_micro);
    const url = solanaPayUrl({
      recipient: ctx.env.SOLANA_WALLET_ADDRESS,
      amountMicro: request.amount_micro,
      reference: request.reference,
      label: 'Discordlancer',
      message: `${project.name} quote v${request.quote_version}`,
    });
    const qr = new AttachmentBuilder(await qrPng(url), { name: `pay-${project.name}-v${request.quote_version}.png` });
    await interaction.editReply({
      content: [
        `**Pay quote v${request.quote_version}: ${amount} USDC on Solana**`,
        'Scan the QR code with a Solana wallet app such as Phantom or Solflare. It fills in the amount, the token and a reference, so the bot finds your payment by itself.',
        `- Pay from your declared wallet: \`${project.client_wallet}\``,
        `- To: \`${ctx.env.SOLANA_WALLET_ADDRESS}\``,
        `- Amount: **${amount} USDC**. USDC on Solana only; other tokens or networks are not detected.`,
        'The bot checks the blockchain every 20 seconds and confirms here once the payment is final, usually within a minute.',
        `Paying without the QR code? Send exactly ${amount} USDC from your declared wallet to the address above, then run **/paid** with the transaction signature.`,
        '',
        `Payment link: \`${url}\``,
      ].join('\n'),
      files: [qr],
    });
  },
};

const paidDescription = 'Check a payment sent without the QR code, by its transaction signature';

export const paid: Command = {
  name: 'paid',
  description: paidDescription,
  access: 'everyone',
  where: 'project',
  stages: ['quote_accepted'],
  definition: new SlashCommandBuilder()
    .setName('paid')
    .setDescription(paidDescription)
    .addStringOption((option) => option.setName('signature').setDescription('The transaction signature from your wallet').setRequired(true))
    .toJSON(),

  async execute(run) {
    const project = requireProject(run);
    const { interaction, ctx } = run;
    const signature = interaction.options.getString('signature', true).trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature)) throw new UserError("That doesn't look like a Solana transaction signature.");
    if (!project.client_wallet) throw new UserError('First declare the wallet you paid from with /set-payment-wallet.');
    if (await paymentBySignature(ctx.db, signature)) throw new UserError('That payment is already recorded.');
    const current = await latestQuote(ctx.db, project);
    if (!current) throw new UserError('There is no accepted quote to pay.');
    await interaction.deferReply();

    const request = await openRequest(ctx.db, project, current.version);
    let tx: unknown;
    try {
      tx = await ctx.solana.transaction(signature);
    } catch {
      throw new UserError("Couldn't reach the Solana network right now. Please try again in a minute.");
    }
    if (!tx) throw new UserError("That transaction isn't final yet, or doesn't exist. Wait a minute and try again.");

    const verdict = verifyPayment(tx, {
      signature,
      recipient: ctx.env.SOLANA_WALLET_ADDRESS,
      sender: project.client_wallet,
      minAmountMicro: request?.amount_micro ?? current.amount_micro,
    });
    if (!verdict.ok) throw new UserError(`That transaction doesn't count as this payment: ${verdict.reason}.`);

    const result = await settlePayment(ctx, interaction.guild, project, request, verdict, 'paid-command', interaction.user.id);
    await interaction.editReply(
      result === 'recorded'
        ? `Verified: ${formatUsdc(verdict.amountMicro)} USDC received. See the confirmation above.`
        : 'That payment is already recorded.',
    );
  },
};

const receiptDescription = 'Show the receipt for this project';

export const receipt: Command = {
  name: 'receipt',
  description: receiptDescription,
  access: 'everyone',
  where: 'project',
  stages: ['paid', 'in_development', 'delivered', 'support', 'cancelled', 'archived'],
  definition: new SlashCommandBuilder().setName('receipt').setDescription(receiptDescription).toJSON(),

  async execute(run) {
    const project = requireProject(run);
    const payments = await paymentsFor(run.ctx.db, project);
    if (payments.length === 0) throw new UserError('No payment has been recorded for this project.');
    const embed = new EmbedBuilder().setTitle(`Receipt: ${project.name}`).addFields(
      payments.map((payment, index) => ({
        name: `Payment ${index + 1}: ${formatUsdc(payment.amount_micro)} USDC`,
        value: [
          `From \`${payment.from_wallet}\``,
          `To \`${payment.to_wallet}\``,
          `Confirmed <t:${Math.floor((payment.block_time ?? payment.verified_at).getTime() / 1000)}:f>`,
          explorerUrl(payment.signature),
        ].join('\n'),
      })),
    );
    await run.interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};

const startDescription = 'Mark that building has started';

export const startDevelopment: Command = {
  name: 'start-development',
  description: startDescription,
  access: 'owner',
  where: 'project',
  stages: ['paid'],
  definition: new SlashCommandBuilder().setName('start-development').setDescription(startDescription).toJSON(),
  async execute(run) {
    const project = requireProject(run);
    await moveStage(run.ctx.db, project, 'paid', 'in_development', {
      actor: 'owner',
      actorId: run.interaction.user.id,
      action: 'development.started',
      outcome: 'ok',
    });
    await run.interaction.reply(`${OWNER_NAME} has started building **${project.name}**. Check progress any time with /status.`);
  },
};
