// Pure builders for the evidence pack, the daily sales report and the touch line.
// Test projects (dl-test-*) are left out of the report and the touches.

import type { Agreement, Quote, Spec } from '../db/deals.js';
import type { EventRecord } from '../db/events.js';
import type { Payment } from '../db/payments.js';
import type { Project } from '../db/projects.js';
import { formatDeadline } from '../domain/deadline.js';
import { formatUsdc } from '../domain/money.js';
import { explorerUrl } from '../domain/payment.js';
import { STAGE_LABEL } from './texts.js';

export const TEST_PREFIX = 'dl-test-';

export function isTestProject(name: string | undefined): boolean {
  return Boolean(name?.startsWith(TEST_PREFIX));
}

/** The project name from a record ID like project:⟨alpha⟩. */
export function projectNameOf(id: { id: unknown } | undefined): string | undefined {
  return id ? String(id.id) : undefined;
}

const iso = (date: Date) => date.toISOString().replace('.000Z', 'Z');

export interface ExportInput {
  project: Project;
  specs: Spec[];
  quotes: Quote[];
  agreements: Agreement[];
  payments: Payment[];
  events: EventRecord[];
  generatedAt: Date;
}

export function exportSummary(input: ExportInput): string {
  const { project, specs, quotes, agreements, payments, events } = input;
  const lines = [
    `# Evidence pack: ${project.name}`,
    '',
    `Generated ${iso(input.generatedAt)} by Discordlancer. Times are UTC.`,
    '',
    '## Project',
    `- Stage: ${STAGE_LABEL[project.stage]} (\`${project.stage}\`)`,
    `- Started: ${iso(project.created_at)}`,
    `- Client Discord ID: ${project.client_id ?? 'none'}`,
    `- Client GitHub: ${project.client_github ?? 'none'}`,
    `- Client's declared wallet: ${project.client_wallet ?? 'none'}`,
    `- Repo: https://github.com/${project.repo}`,
    ...(project.delivery_marked_at ? [`- Marked delivered: ${iso(project.delivery_marked_at)}${project.delivery_note ? ` (${project.delivery_note})` : ''}`] : []),
    '',
    '## Specs',
    ...(specs.length
      ? specs.map((spec) => `- v${spec.version}: ${iso(spec.created_at)}, from ${spec.message_count} messages, ${spec.model}, prompt ${spec.prompt_version}`)
      : ['- none']),
    '',
    '## Quotes',
    ...(quotes.length
      ? quotes.map((quote) => `- v${quote.version}: ${formatUsdc(quote.amount_micro)} USDC for spec v${quote.spec_version}, delivery by ${formatDeadline(quote.deadline)}, posted ${iso(quote.created_at)}`)
      : ['- none']),
    '',
    '## Agreements',
    ...(agreements.length
      ? agreements.map((agreement) => `- ${agreement.kind} v${agreement.version}: ${agreement.party} (${agreement.user_id}) at ${iso(agreement.at)}`)
      : ['- none']),
    '',
    '## Payments',
    ...(payments.length
      ? payments.map(
          (payment) =>
            `- ${formatUsdc(payment.amount_micro)} USDC from ${payment.from_wallet} to ${payment.to_wallet}, confirmed ${iso(payment.block_time ?? payment.verified_at)}: ${explorerUrl(payment.signature)}`,
        )
      : ['- none']),
    '',
    `## Event log (${events.length} events)`,
    ...events.map((event) => `- ${iso(event.at)} ${event.actor} ${event.action} ${event.outcome}`),
  ];
  return `${lines.join('\n')}\n`;
}

export interface TranscriptLine {
  at: Date;
  author: string;
  bot: boolean;
  text: string;
  attachments: string[];
}

export function transcriptMarkdown(projectName: string, messages: readonly TranscriptLine[]): string {
  const lines = [`# Channel transcript: ${projectName}`, '', `${messages.length} messages, oldest first. Times are UTC.`, ''];
  for (const message of messages) {
    lines.push(`**${iso(message.at)} ${message.author}${message.bot ? ' (bot)' : ''}:** ${message.text}`);
    for (const url of message.attachments) lines.push(`  - attachment: ${url}`);
  }
  return `${lines.join('\n')}\n`;
}

export function salesReport(payments: readonly Payment[], since: Date, wallet: string, now: Date): string {
  const real = payments.filter((payment) => !isTestProject(projectNameOf(payment.project)));
  const today = real.filter((payment) => payment.verified_at.getTime() >= since.getTime());
  const total = real.reduce((sum, payment) => sum + payment.amount_micro, 0);
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', dateStyle: 'full' }).format(now);
  const lines = [`Sales report for ${day}. Paid in USDC on Solana to ${wallet}.`];
  if (today.length) {
    lines.push('Today:');
    for (const payment of today) {
      lines.push(`- ${projectNameOf(payment.project)}: ${formatUsdc(payment.amount_micro)} USDC, transaction ${payment.signature} (${explorerUrl(payment.signature)})`);
    }
  } else {
    lines.push('No sales today.');
  }
  lines.push(`Running total: ${formatUsdc(total)} USDC from ${real.length} payment(s).`);
  if (today.length) lines.push('Proof: the transaction hashes above, on the public Solana chain.');
  return lines.join('\n');
}

const PHRASES: Record<string, (project: string, data: Record<string, unknown>) => string> = {
  'project.created': (p) => `set up ${p}`,
  'project.invite_renewed': (p) => `renewed the invite for ${p}`,
  'project.client_linked': (p) => `linked the client of ${p}`,
  'project.github_added': (p) => `gave the client repo access on ${p}`,
  'spec.created': (p, d) => `wrote specs v${String(d.version ?? '?')} for ${p} with Gemini`,
  'spec.agreed': (p, d) => `agreed specs v${String(d.version ?? '?')} for ${p}`,
  'quote.created': (p, d) => `posted quote v${String(d.version ?? '?')} for ${p}`,
  'payment.requested': (p) => `opened a payment request for ${p}`,
  'development.started': (p) => `started building ${p}`,
  'delivery.marked': (p) => `marked ${p} delivered`,
  'project.cancelled': (p) => `cancelled ${p}`,
  'project.archived': (p) => `archived ${p}`,
};

/** A draft /touch line from Boran's own recorded actions today. */
export function touchLine(events: readonly EventRecord[]): string {
  const phrases: string[] = [];
  for (const event of events) {
    if (event.actor !== 'owner' || event.outcome !== 'ok') continue;
    const name = projectNameOf(event.project);
    if (isTestProject(name)) continue;
    const phrase = PHRASES[event.action];
    if (!phrase) continue;
    const text = phrase(name ?? 'a project', event.data ?? {});
    if (!phrases.includes(text)) phrases.push(text);
  }
  if (phrases.length === 0) return 'No owner actions recorded today (test projects are left out).';
  return `Discordlancer: ${phrases.join('; ')}.`;
}
