// Answers a question about one project from everything the bot knows about it,
// gathered fresh each time so it is never out of date: the channel's whole conversation
// (read live from Discord), the spec, quote, payments and change requests (SurrealDB),
// Agent Memory, and the code on GitHub. Used by /ask and by Boran's "answer this".

import type { Guild, TextChannel } from 'discord.js';
import { callsFor, type Call } from '../db/calls.js';
import { fileNotesFor, type FileNote } from '../db/files.js';
import { renderFileNotes } from '../files/noteText.js';
import { referenceReviewsFor, type RepoReview } from '../db/references.js';
import { renderReferences } from './references.js';
import { changeRequestsFor, type ChangeRequest } from '../db/changes.js';
import { agreedParties, latestQuote, latestSpec, type Quote, type Spec } from '../db/deals.js';
import { eventsForProject, recordEvent, type Actor } from '../db/events.js';
import { paymentsFor, type Payment } from '../db/payments.js';
import { clientMembers, type Project } from '../db/projects.js';
import { formatDeadline } from '../domain/deadline.js';
import { formatUsdc } from '../domain/money.js';
import { log } from '../log.js';
import { ANSWER_PROMPT_VERSION, ANSWER_SCHEMA, ANSWER_SYSTEM, AnswerOutput } from '../prompts/answers.js';
import { GeminiError, SPEC_MODEL } from '../services/gemini.js';
import type { RepoSnapshot } from '../services/github.js';
import { projectScope, safeRecall } from '../services/memory.js';
import { ensureOwnerChannel } from './channels.js';
import { UserError, type BotContext } from './command.js';
import { OWNER_NAME } from './guards.js';
import { renderCalls } from '../voice/callText.js';
import { fitMessage, STAGE_LABEL } from './texts.js';
import { readConversation, renderConversation, type ChatMessage } from './transcript.js';

/** How much of the conversation goes in, newest kept: plenty for a project of a few weeks. */
export const ANSWER_CONVERSATION_CHARS = 150_000;
/** Answers a client can ask for per project per London day. Boran has no limit. */
export const ASKS_PER_DAY = 15;

const fence = (tag: string, text: string, attrs = '') => `<${tag}${attrs}>\n${text}\n</${tag}>`;

export interface AnswerContext {
  project: Project;
  spec?: { spec: Spec; agreedBy: readonly string[] } | undefined;
  quote?: { quote: Quote; agreedBy: readonly string[] } | undefined;
  payments: readonly Payment[];
  changes: readonly ChangeRequest[];
  calls?: readonly Call[];
  files?: readonly FileNote[];
  references?: readonly RepoReview[];
  updates?: ReadonlyArray<{ at: Date; summary: string }>;
  memory: string;
  messages: readonly ChatMessage[];
  code?: RepoSnapshot | undefined;
  ownerNote?: string | undefined;
  question: string;
}

function agreement(agreedBy: readonly string[]): string {
  if (agreedBy.includes('owner') && agreedBy.includes('client')) return 'agreed by both';
  if (agreedBy.length === 0) return 'not agreed yet';
  return `agreed by the ${agreedBy[0]} only`;
}

/** Pure: the whole input for Gemini, every part fenced as data. */
export function renderAnswerInput(context: AnswerContext): string {
  const { project, spec, quote, payments, changes } = context;
  const projectLines = [
    `Name: ${project.name}`,
    `Stage: ${STAGE_LABEL[project.stage]}`,
    `Started: ${project.created_at.toISOString().slice(0, 10)}`,
    quote
      ? `Latest quote: v${quote.quote.version}, ${formatUsdc(quote.quote.amount_micro)} USDC for spec v${quote.quote.spec_version}, delivery by ${formatDeadline(quote.quote.deadline)}; ${agreement(quote.agreedBy)}.`
      : 'Quote: none yet.',
    payments.length
      ? `Payments received: ${payments.map((payment) => `${formatUsdc(payment.amount_micro)} USDC on ${payment.verified_at.toISOString().slice(0, 10)}`).join('; ')}.`
      : 'Payments received: none.',
    project.delivery_marked_at ? `Marked delivered: ${project.delivery_marked_at.toISOString().slice(0, 10)}${project.delivery_note ? ` (${project.delivery_note})` : ''}.` : '',
  ].filter(Boolean);

  const noted = new Set((context.files ?? []).filter((note) => note.source === 'attachment' && note.status === 'read').map((note) => note.source_id));
  const conversation = renderConversation(context.messages, { images: [], textFiles: [], skipped: [] }, new Map(), noted);
  const trimmed =
    conversation.length > ANSWER_CONVERSATION_CHARS ? `<conversation truncated>\n${conversation.slice(-ANSWER_CONVERSATION_CHARS)}` : conversation;

  const code = context.code
    ? fence(
        'code',
        [fence('file_list', context.code.paths.slice(0, 300).join('\n')), ...context.code.files.map((file) => fence('file', file.content, ` path="${file.path}"`))].join('\n'),
        ` branch="${context.code.branch}" commit="${context.code.commit.slice(0, 7)}"`,
      )
    : '<code>The code could not be read just now.</code>';

  return [
    fence('project', projectLines.join('\n')),
    spec ? fence('spec', spec.spec.markdown, ` version="${spec.spec.version}" status="${agreement(spec.agreedBy)}"`) : '<spec>No spec written yet.</spec>',
    changes.length
      ? fence('change_requests', changes.map((change) => `- [${change.status}${change.pr_number ? `, pull request #${change.pr_number}` : ''}] ${change.text.slice(0, 300)}`).join('\n'))
      : '',
    context.memory ? fence('memory', context.memory) : '',
    context.updates?.length ? fence('progress_updates', context.updates.map((update) => `- ${update.at.toISOString().slice(0, 10)}: ${update.summary}`).join('\n')) : '',
    renderCalls(context.calls ?? []),
    renderFileNotes(context.files ?? [], { perFile: 8_000, total: 60_000 }),
    renderReferences(context.references ?? [], { perRepo: 10_000, total: 30_000 }),
    trimmed,
    code,
    context.ownerNote ? fence('owner_note', context.ownerNote) : '',
    fence('question', context.question),
  ]
    .filter(Boolean)
    .join('\n\n');
}

const SOURCE_LABEL: Record<AnswerOutput['based_on'][number], string> = {
  chat: 'the chat',
  calls: 'the call notes',
  files: 'the shared files',
  references: 'the reviewed codebases',
  updates: 'the progress updates',
  spec: 'the spec',
  quote: 'the quote',
  payments: 'the payments',
  changes: 'the change requests',
  memory: 'project memory',
  code: 'the code',
};

/** Pure: the message posted in the channel, always marked as an AI answer. */
export function formatAnswer(output: AnswerOutput, meta: { commit?: string | undefined; question?: string | undefined }): string {
  const sources = output.based_on.map((source) => (source === 'code' && meta.commit ? `the code at \`${meta.commit.slice(0, 7)}\`` : SOURCE_LABEL[source]));
  const basis = sources.length ? ` from ${sources.join(', ')}` : '';
  const lines = [
    meta.question ? `> ${meta.question.replace(/\s+/g, ' ').slice(0, 300)}` : '',
    output.answer,
    // The model usually says so itself, in the client's language; add it only when it didn't.
    output.needs_owner && !output.answer.includes(OWNER_NAME) ? `\n${OWNER_NAME} will follow up on this.` : '',
    `-# AI answer${basis}. Confidence: ${output.confidence}. ${OWNER_NAME} corrects anything that's wrong.`,
  ];
  return fitMessage(lines.filter(Boolean).join('\n'));
}

/** Gathers everything about the project now, then asks Gemini. Throws UserError on a Gemini failure. */
export async function answerQuestion(
  ctx: BotContext,
  project: Project,
  channel: TextChannel,
  question: string,
  ownerNote?: string,
): Promise<{ output: AnswerOutput; commit?: string | undefined }> {
  const [spec, quote, payments, changes, calls, files, references, events, memory, messages, code] = await Promise.all([
    latestSpec(ctx.db, project),
    latestQuote(ctx.db, project),
    paymentsFor(ctx.db, project),
    changeRequestsFor(ctx.db, project),
    callsFor(ctx.db, project),
    fileNotesFor(ctx.db, project).catch((error: unknown) => {
      log.warn('could not load the file notes for an answer', { project: project.name, error });
      return [];
    }),
    referenceReviewsFor(ctx.db, project).catch(() => []),
    eventsForProject(ctx.db, project.id),
    safeRecall(ctx.memory, projectScope(project.name), question),
    readConversation(channel, project.created_at, { ownerId: ctx.env.DISCORD_OWNER_ID, clientIds: clientMembers(project) }, { includeBot: true }),
    ctx.github.readRepo(project.repo).catch((error: unknown) => {
      log.warn('could not read the repo for an answer', { project: project.name, error });
      return undefined;
    }),
  ]);
  const specAgreed = spec ? [...(await agreedParties(ctx.db, project, 'spec', spec.version))] : [];
  const quoteAgreed = quote ? [...(await agreedParties(ctx.db, project, 'quote', quote.version))] : [];

  const input = renderAnswerInput({
    project,
    spec: spec ? { spec, agreedBy: specAgreed } : undefined,
    quote: quote ? { quote, agreedBy: quoteAgreed } : undefined,
    payments,
    changes,
    calls,
    files,
    references,
    updates: events
      .filter((event) => event.action === 'dev.update_posted' && event.outcome === 'ok' && typeof event.data?.summary === 'string')
      .slice(-10)
      .map((event) => ({ at: event.at, summary: String(event.data?.summary) })),
    memory,
    messages,
    code,
    ownerNote,
    question,
  });
  try {
    const output = await ctx.gemini.json({
      model: SPEC_MODEL,
      system: ANSWER_SYSTEM,
      input: [{ type: 'text', text: input }],
      schema: ANSWER_SCHEMA,
      parse: AnswerOutput,
      thinking: 'low',
    });
    return { output, commit: code?.commit };
  } catch (error) {
    if (error instanceof GeminiError) throw new UserError(`Couldn't answer just now: ${error.message}`);
    throw error;
  }
}

/** Records the answer, and tells Boran in owner-desk when it needs him. Never throws. */
export async function afterAnswer(
  guild: Guild,
  ctx: BotContext,
  project: Project,
  details: { actor: Actor; actorId: string; action: 'question.answered' | 'ask.answered'; via: 'ask' | 'mention' | 'menu'; question: string; output: AnswerOutput; commit?: string | undefined; link?: string | undefined },
): Promise<void> {
  try {
    await recordEvent(ctx.db, {
      actor: details.actor,
      actorId: details.actorId,
      action: details.action,
      outcome: 'ok',
      project: project.id,
      data: {
        via: details.via,
        needs_owner: details.output.needs_owner,
        confidence: details.output.confidence,
        based_on: details.output.based_on,
        commit: details.commit ?? null,
        model: SPEC_MODEL,
        prompt_version: ANSWER_PROMPT_VERSION,
      },
    });
  } catch (error) {
    log.error('could not record an answer', { error });
  }
  if (!details.output.needs_owner) return;
  try {
    const desk = await ensureOwnerChannel(guild, ctx.env.DISCORD_OWNER_ID);
    await desk.send(
      fitMessage(
        [
          `**${project.name}**: a question needs you${details.link ? ` (${details.link})` : ''}.`,
          `> ${details.question.replace(/\s+/g, ' ').slice(0, 400)}`,
          details.output.owner_note || 'The assistant could not answer it from the project context.',
        ].join('\n'),
      ),
    );
  } catch (error) {
    log.warn('could not tell the owner about a question', { error });
  }
}
