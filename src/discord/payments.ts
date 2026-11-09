// What happens once a payment is verified, shared by the watcher and /paid:
// record it once, tell both people in the project channel, and remind Boran in
// owner-desk to report the sale to the organisers.

import { ChannelType, type Guild } from 'discord.js';
import { recordPayment, type PaymentRequest } from '../db/payments.js';
import type { Project } from '../db/projects.js';
import { formatUsdc } from '../domain/money.js';
import { explorerUrl, type Verdict } from '../domain/payment.js';
import { log } from '../log.js';
import { ensureOwnerChannel } from './channels.js';
import type { BotContext } from './command.js';
import { OWNER_NAME } from './guards.js';

type Verified = Extract<Verdict, { ok: true }>;

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

  const amount = formatUsdc(verdict.amountMicro);
  const link = explorerUrl(verdict.signature);
  const extra = request && verdict.amountMicro > request.amount_micro ? ` (${formatUsdc(request.amount_micro)} USDC was due)` : '';
  try {
    const channel = await guild.channels.fetch(project.channel_id);
    if (channel?.type === ChannelType.GuildText) {
      await channel.send(
        [
          `Payment received: **${amount} USDC**${extra}, confirmed on Solana. Thank you!`,
          `Transaction: ${link}`,
          `Next, ${OWNER_NAME} starts building with /start-development. Use /receipt any time for a receipt.`,
        ].join('\n'),
      );
    }
    const owner = await ensureOwnerChannel(guild, ctx.env.DISCORD_OWNER_ID);
    await owner.send(
      [
        `Payment received for **${project.name}**: ${amount} USDC. ${link}`,
        'Hackathon: USDC sales are reported by hand. Before 6pm on the day of the sale, send the organisers your running total with this transaction hash. The receiving wallet must have been declared to them before this payment.',
      ].join('\n'),
    );
  } catch (error) {
    // The payment is recorded; a failed announcement must not hide that.
    log.error('could not announce a payment', { project: project.name, error });
  }
  return result;
}
