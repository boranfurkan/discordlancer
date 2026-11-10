// /invoice billed_to [note] [correct]: a PDF invoice for a paid project, sent to
// #owner-desk for Boran to pass on (the organisers confirm payments with it). Issued
// invoices never change: running it again gives the same one, and `correct` issues a
// new number that replaces it.

import { AttachmentBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { listAgreements, listQuotes } from '../../db/deals.js';
import { issueInvoice, latestInvoice } from '../../db/issuedInvoices.js';
import { paymentsFor } from '../../db/payments.js';
import { invoicePdf, money, type InvoiceData } from '../../domain/invoice.js';
import { explorerUrl } from '../../domain/payment.js';
import { ensureOwnerChannel } from '../channels.js';
import { requireProject, UserError, type Command } from '../command.js';

const description = 'Make the PDF invoice for this paid project (sent to owner-desk)';

/** Pure: "Acme Ltd | 1 High St, London" → one line each, trimmed, at most six. */
export function billedToLines(input: string): string[] {
  return input
    .split('|')
    .map((line) => line.trim().replace(/\s+/g, ' ').slice(0, 120))
    .filter(Boolean)
    .slice(0, 6);
}

export const invoice: Command = {
  name: 'invoice',
  description,
  access: 'owner',
  where: 'project',
  stages: ['paid', 'in_development', 'delivered', 'support', 'cancelled', 'archived'],
  definition: new SlashCommandBuilder()
    .setName('invoice')
    .setDescription(description)
    .addStringOption((option) =>
      option.setName('billed_to').setDescription('Who it is billed to: name or company, then address; separate lines with |').setRequired(true).setMaxLength(400),
    )
    .addStringOption((option) => option.setName('note').setDescription('A short note printed on the invoice').setMaxLength(300))
    .addBooleanOption((option) => option.setName('correct').setDescription('Issue a corrected invoice with a new number, replacing the last one'))
    .toJSON(),

  async execute(run) {
    const project = requireProject(run);
    const { interaction, ctx } = run;
    const billedTo = billedToLines(interaction.options.getString('billed_to', true));
    if (billedTo.length === 0) throw new UserError('Say who the invoice is billed to, such as `Acme Ltd | 1 High Street, London`.');
    const note = interaction.options.getString('note')?.trim() || undefined;
    const correct = interaction.options.getBoolean('correct') ?? false;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const [payments, quotes, agreements, existing] = await Promise.all([
      paymentsFor(ctx.db, project),
      listQuotes(ctx.db, project),
      listAgreements(ctx.db, project),
      latestInvoice(ctx.db, project),
    ]);
    if (payments.length === 0) throw new UserError("Invoices are made once a payment is confirmed, and this project hasn't had one yet.");

    let record = existing;
    // After a deposit, the balance payment needs a new invoice listing both: it replaces the last one.
    const newPayment = existing !== undefined && payments.some((payment) => !existing.payments.includes(payment.signature));
    if (!record || correct || newPayment) {
      const accepted = [...quotes].reverse().find((quote) => agreements.some((item) => item.kind === 'quote' && item.version === quote.version && item.party === 'client'));
      if (!accepted) throw new UserError('This project has no accepted quote to invoice.');
      record = await issueInvoice(
        ctx.db,
        project,
        {
          billedTo,
          amountMicro: accepted.amount_micro,
          quoteVersion: accepted.version,
          specVersion: accepted.spec_version,
          payments: payments.map((payment) => payment.signature),
          note,
          replaces: existing?.number,
        },
        { actor: 'owner', actorId: interaction.user.id, action: 'invoice.issued', outcome: 'ok', data: { amount_micro: accepted.amount_micro, ...(existing ? { replaces: existing.number } : {}) } },
      );
    }

    const quote = quotes.find((item) => item.version === record.quote_version)!;
    const acceptedAt = agreements.find((item) => item.kind === 'quote' && item.version === record.quote_version && item.party === 'client')?.at;
    const data: InvoiceData = {
      number: record.number,
      issuedAt: record.issued_at,
      replaces: record.replaces,
      billedTo: record.billed_to,
      project: project.name,
      specVersion: record.spec_version,
      quoteVersion: record.quote_version,
      quoteAcceptedAt: acceptedAt,
      deadline: quote.deadline,
      amountMicro: record.amount_micro,
      payments: payments
        .filter((payment) => record.payments.includes(payment.signature))
        .map((payment) => ({
          amountMicro: payment.amount_micro,
          at: payment.block_time ?? payment.verified_at,
          from: payment.from_wallet,
          to: payment.to_wallet,
          signature: payment.signature,
          url: explorerUrl(payment.signature),
        })),
      note: record.note,
    };

    const desk = await ensureOwnerChannel(interaction.guild, ctx.env.DISCORD_OWNER_ID);
    const fresh = record !== existing;
    const posted = await desk.send({
      content: `🧾 Invoice **${record.number}** for **${project.name}**: ${money(record.amount_micro)} USDC, paid.${record.replaces ? ` It replaces ${record.replaces}.` : ''} Send it to the organisers in your team channel, and to the client if they'd like a copy.`,
      files: [new AttachmentBuilder(invoicePdf(data), { name: `${record.number}.pdf` })],
      allowedMentions: { parse: [] },
    });
    await interaction.editReply(
      fresh
        ? `Invoice **${record.number}** is in ${posted.url}${newPayment && !correct ? `\nIt replaces ${existing!.number}, which didn't include the latest payment.` : ''}`
        : `This project already has invoice **${record.number}**, so here it is again: ${posted.url}\nTo change it, run \`/invoice\` with \`correct: True\`; that issues a new number replacing it.`,
    );
  },
};
