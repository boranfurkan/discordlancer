// What happens once a payment is verified, shared by the watcher and /paid:
// record it once, tell both people in the project channel, and remind Boran in
// owner-desk to report the sale to the organisers.

import { ChannelType, type Guild } from 'discord.js';
import { latestQuote } from '../db/deals.js';
import { paymentsFor, recordPayment, type PaymentRequest } from '../db/payments.js';
import { amountDue, type Due } from '../domain/deposit.js';
import type { Project } from '../db/projects.js';
import { formatUsdc } from '../domain/money.js';
import { explorerUrl, type Verdict } from '../domain/payment.js';
import { log } from '../log.js';
import { projectScope, safeRemember } from '../services/memory.js';
import { ensureOwnerChannel } from './channels.js';
import type { BotContext } from './command.js';
import { OWNER_NAME } from './guards.js';

type Verified = Extract<Verdict, { ok: true }>;

/** What the client pays next for the latest quote, or undefined when it's paid in full (or there's no quote). */
export async function dueNow(ctx: Pick<BotContext, 'db'>, project: Pick<Project, 'id'>): Promise<Due | undefined> {
  const [quote, payments] = await Promise.all([latestQuote(ctx.db, project), paymentsFor(ctx.db, project)]);
  if (!quote) return undefined;
  return amountDue(quote, payments.reduce((sum, payment) => sum + payment.amount_micro, 0));
}

export async function settlePayment(
  ctx: BotContext,
  guild: Guild,
  project: Project,
  request: PaymentRequest | undefined,
  verdict: Verified,
  how: 'watcher' | 'paid-command',
  actorId?: string,
): Promise<'recorded' | 'duplicate' | 'request_closed'> {
  const result = await recordPayment(
    ctx.db,
    project,
    request,
    {
      signature: verdict.signature,
      fromWallet: verdict.from,
      toWallet: verdict.to,
      amountMicro: verdict.amountMicro,
      slot: verdict.slot,
      blockTime: verdict.blockTime,
    },
    {
      actor: how === 'watcher' ? 'bot' : actorId === ctx.env.DISCORD_OWNER_ID ? 'owner' : 'client',
      ...(actorId ? { actorId } : {}),
      action: 'payment.verified',
      outcome: 'ok',
      data: { how, ...(request ? { quote_version: request.quote_version, reference: request.reference } : {}) },
    },
  );
  if (result !== 'recorded') return result;
  await safeRemember(ctx.memory, projectScope(project.name), `${project.name} was paid ${formatUsdc(verdict.amountMicro)} USDC on Solana, transaction ${verdict.signature}.`);

  const amount = formatUsdc(verdict.amountMicro);
  const link = explorerUrl(verdict.signature);
  const extra = request && verdict.amountMicro > request.amount_micro ? ` (${formatUsdc(request.amount_micro)} USDC was due)` : '';
  // What's left decides what the message says: a deposit, the final payment, or the whole price.
  const left = await dueNow(ctx, project).catch(() => undefined);
  const first = project.stage === 'quote_accepted';
  const label = left ? 'Deposit received' : first ? 'Payment received' : 'Final payment received';
  const next = left
    ? `Next, ${OWNER_NAME} starts building with /start-development. The remaining **${formatUsdc(left.amountMicro)} USDC** is due on delivery, with /pay.`
    : first
      ? `Next, ${OWNER_NAME} starts building with /start-development. Use /receipt any time for a receipt.`
      : `The project is now paid in full.${project.delivery_marked_at ? ' Once you have checked the delivery, confirm it with /confirm-delivery.' : ''} Use /receipt any time for a receipt.`;
  try {
    const channel = await guild.channels.fetch(project.channel_id);
    if (channel?.type === ChannelType.GuildText) {
      await channel.send([`${label}: **${amount} USDC**${extra}, confirmed on Solana. Thank you!`, `Transaction: ${link}`, next].join('\n'));
    }
    const owner = await ensureOwnerChannel(guild, ctx.env.DISCORD_OWNER_ID);
    await owner.send(
      [
        `${label} for **${project.name}**: ${amount} USDC.${left ? ` ${formatUsdc(left.amountMicro)} USDC is still due on delivery.` : ''} ${link}`,
        'Hackathon: USDC sales are reported by hand. Before 6pm on the day of the sale, send the organisers your running total with this transaction hash. The receiving wallet must have been declared to them before this payment.',
      ].join('\n'),
    );
  } catch (error) {
    // The payment is recorded; a failed announcement must not hide that.
    log.error('could not announce a payment', { project: project.name, error });
  }
  return result;
}
