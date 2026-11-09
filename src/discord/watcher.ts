// Watches open payment requests. Every 20 seconds it asks the chain which finalized
// transactions mention each request's reference key, checks each one, and settles a
// valid payment. No answer from the RPC is not proof of non-payment, so requests
// simply stay open; nothing here expires them.

import type { Client } from 'discord.js';
import { listOpenRequests, paymentBySignature, type PaymentRequest } from '../db/payments.js';
import { getProject } from '../db/projects.js';
import { verifyPayment } from '../domain/payment.js';
import { log } from '../log.js';
import { ensureOwnerChannel } from './channels.js';
import { safeRecord } from './client.js';
import type { BotContext } from './command.js';
import { settlePayment } from './payments.js';

export const WATCH_INTERVAL_MS = 20_000;

export function startPaymentWatcher(client: Client, ctx: BotContext, intervalMs = WATCH_INTERVAL_MS): () => void {
  // Signatures already judged in this run, so a bad one is reported once, not every tick.
  const judged = new Set<string>();
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const requests = await listOpenRequests(ctx.db);
      for (const request of requests) await checkRequest(client, ctx, request, judged);
    } catch (error) {
      log.warn('payment watch failed', { error });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  void tick();
  return () => clearInterval(timer);
}

async function checkRequest(client: Client, ctx: BotContext, request: PaymentRequest, judged: Set<string>): Promise<void> {
  const project = await getProject(ctx.db, request.project);
  if (!project || project.stage !== 'quote_accepted' || !project.client_wallet) return;
  const guild = client.guilds.cache.get(ctx.env.DISCORD_GUILD_ID);
  if (!guild) return;

  const signatures = await ctx.solana.signaturesFor(request.reference, 10);
  for (const { signature, err } of signatures) {
    if (err !== null || judged.has(signature)) continue;
    if (await paymentBySignature(ctx.db, signature)) {
      judged.add(signature);
      continue;
    }
    const tx = await ctx.solana.transaction(signature);
    if (!tx) continue; // Not finalized yet; look again next tick.
    judged.add(signature);

    const verdict = verifyPayment(tx, {
      signature,
      recipient: ctx.env.SOLANA_WALLET_ADDRESS,
      sender: project.client_wallet,
      minAmountMicro: request.amount_micro,
      reference: request.reference,
    });
    if (verdict.ok) {
      const result = await settlePayment(ctx, guild, project, request, verdict, 'watcher');
      log.info('payment settled', { project: project.name, result });
      if (result === 'recorded') return;
      continue;
    }

    log.warn('payment rejected', { project: project.name, reason: verdict.reason });
    await safeRecord(ctx, {
      actor: 'bot',
      action: 'payment.rejected',
      outcome: 'refused',
      project: project.id,
      data: { signature, reason: verdict.reason, reference: request.reference },
    });
    try {
      const owner = await ensureOwnerChannel(guild, ctx.env.DISCORD_OWNER_ID);
      await owner.send(
        `A transaction for **${project.name}**'s payment request doesn't count as payment: ${verdict.reason}. https://explorer.solana.com/tx/${signature}`,
      );
    } catch (error) {
      log.error('could not report a rejected payment', { error });
    }
  }
}
