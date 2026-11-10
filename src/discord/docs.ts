// /sync-docs: writes the project's docs into its repo from everything recorded about it
// (chat with images and files, calls, specs, quote, change requests, progress updates,
// memory), as one pull request Boran reviews. Two AI passes: a writer, then a reviewer
// that checks every statement against the sources; then every citation is checked
// against the real sources by code, and anything unmatched is listed in the pull request.

import type { TextChannel } from 'discord.js';
import { callLabel, callsFor, type Call } from '../db/calls.js';
import { changeRequestsFor, type ChangeRequest } from '../db/changes.js';
import { agreedParties, latestQuote, listSpecs, type Quote, type Spec } from '../db/deals.js';
import { eventsForProject } from '../db/events.js';
import { paymentsFor, type Payment } from '../db/payments.js';
import type { Project } from '../db/projects.js';
import { formatDeadline } from '../domain/deadline.js';
import { formatUsdc } from '../domain/money.js';
import { findSecret } from '../mcp/updates.js';
import { DOCS_DRAFT_SCHEMA, DOCS_PROMPT_VERSION, DOCS_REVIEW_SCHEMA, DOCS_REVIEW_SYSTEM, DOCS_SYSTEM, DocsDraft, DocsReview } from '../prompts/docs.js';
import { SPEC_MODEL, type Part } from '../services/gemini.js';
import type { RepoFile } from '../services/github.js';
import { projectScope, safeRecall } from '../services/memory.js';
import { renderCalls } from '../voice/callText.js';
import type { BotContext } from './command.js';
import { OWNER_NAME } from './guards.js';
import { STAGE_LABEL } from './texts.js';
import { conversationParts, readConversation, type ChatMessage } from './transcript.js';

export const DOCS_FOLDER = 'docs/project';
export const DOCS_BRANCH = 'discordlancer/project-docs';
export const DOC_PATHS = {
  overview: `${DOCS_FOLDER}/README.md`,
  requirements: `${DOCS_FOLDER}/requirements.md`,
  decisions: `${DOCS_FOLDER}/decisions.md`,
  open_questions: `${DOCS_FOLDER}/open-questions.md`,
} as const;
type DocKey = keyof typeof DOC_PATHS;
const DOC_KEYS = Object.keys(DOC_PATHS) as DocKey[];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const fence = (tag: string, text: string, attrs = '') => `<${tag}${attrs}>\n${text}\n</${tag}>`;
const day = (date: Date) => date.toISOString().slice(0, 10);
const minute = (date: Date) => date.toISOString().slice(0, 16).replace('T', ' ');

function agreement(agreedBy: readonly string[]): string {
  if (agreedBy.includes('owner') && agreedBy.includes('client')) return 'agreed by both';
  if (agreedBy.length === 0) return 'not agreed yet';
  return `agreed by the ${agreedBy[0]} only`;
}

export interface DocsSources {
  project: Project;
  specs: readonly Spec[];
  specAgreedBy: readonly string[];
  quote?: { quote: Quote; agreedBy: readonly string[] } | undefined;
  payments: readonly Payment[];
  changes: readonly ChangeRequest[];
  updates: ReadonlyArray<{ at: Date; summary: string }>;
  calls: readonly Call[];
  memory: string;
  messages: readonly ChatMessage[];
  conversation: string;
  images: readonly Part[];
  currentDocs: ReadonlyMap<string, string>;
}

/** Pure: everything the writer and reviewer read, each part fenced as data. */
export function renderSources(sources: DocsSources): string {
  const { project, specs, quote, payments, changes, updates } = sources;
  const latest = specs.at(-1);
  const projectLines = [
    `Name: ${project.name}`,
    `Stage: ${STAGE_LABEL[project.stage]}`,
    `Started: ${day(project.created_at)}`,
    quote
      ? `Latest quote: v${quote.quote.version}, ${formatUsdc(quote.quote.amount_micro)} USDC for spec v${quote.quote.spec_version}, delivery by ${formatDeadline(quote.quote.deadline)}; ${agreement(quote.agreedBy)}.`
      : 'Quote: none yet.',
    payments.length ? `Payments: ${payments.map((payment) => `${formatUsdc(payment.amount_micro)} USDC on ${day(payment.verified_at)}`).join('; ')}.` : 'Payments: none yet.',
    project.delivery_marked_at ? `Marked delivered: ${day(project.delivery_marked_at)}.` : '',
  ].filter(Boolean);
  const current = [...sources.currentDocs].map(([path, text]) => fence('doc', text, ` path="${path}"`));
  return [
    fence('project', projectLines.join('\n')),
    latest ? fence('spec', latest.markdown, ` version="${latest.version}" status="${agreement(sources.specAgreedBy)}" written="${day(latest.created_at)}"`) : '<spec>No spec written yet.</spec>',
    specs.length > 1 ? fence('spec_history', specs.map((spec) => `v${spec.version} (${day(spec.created_at)}): ${spec.changes.join('; ') || 'first version'}`).join('\n')) : '',
    changes.length ? fence('change_requests', changes.map((change) => `- ${day(change.created_at)} [${change.status}] ${change.text.slice(0, 600)}`).join('\n')) : '',
    updates.length ? fence('progress_updates', updates.map((update) => `- ${day(update.at)}: ${update.summary}`).join('\n')) : '',
    renderCalls(sources.calls),
    sources.memory ? fence('memory', sources.memory) : '',
    sources.conversation,
    current.length ? fence('current_docs', current.join('\n')) : '<current_docs>There are no docs in the repository yet.</current_docs>',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export interface KnownSources {
  chat: ReadonlySet<string>;
  calls: ReadonlyMap<string, number>;
  specs: ReadonlySet<number>;
  quotes: ReadonlySet<number>;
  changes: ReadonlySet<string>;
  updates: ReadonlySet<string>;
}

const CITATION = /\[(chat|call|spec|quote|change|update) ([^\]]+)\]/g;

const seconds = (clock: string) => clock.split(':').reduce((total, part) => total * 60 + Number(part), 0);

/** Pure: checks each citation against the real sources. Returns how many there were and those that don't match. */
export function checkCitations(texts: readonly string[], known: KnownSources): { total: number; unmatched: string[] } {
  let total = 0;
  const unmatched = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(CITATION)) {
      total++;
      const [whole, kind, value] = match as unknown as [string, string, string];
      let ok = false;
      if (kind === 'chat') ok = known.chat.has(value.trim());
      else if (kind === 'spec' || kind === 'quote') {
        const version = /^v(\d+)$/.exec(value.trim())?.[1];
        ok = version !== undefined && (kind === 'spec' ? known.specs : known.quotes).has(Number(version));
      } else if (kind === 'change') ok = known.changes.has(value.trim());
      else if (kind === 'update') ok = known.updates.has(value.trim());
      else {
        const call = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}), (\d{2}:\d{2}:\d{2})$/.exec(value.trim());
        const length = call ? known.calls.get(call[1]!) : undefined;
        ok = call !== null && length !== undefined && seconds(call[2]!) <= length + 60;
      }
      if (!ok) unmatched.add(whole);
    }
  }
  return { total, unmatched: [...unmatched] };
}

/** Pure: what the citations may point at. */
export function knownSources(sources: Pick<DocsSources, 'messages' | 'calls' | 'specs' | 'quote' | 'changes' | 'updates'>, quotes: readonly number[]): KnownSources {
  return {
    chat: new Set(sources.messages.map((message) => minute(message.at))),
    calls: new Map(sources.calls.map((call) => [callLabel(call), (call.ended_at.getTime() - call.started_at.getTime()) / 1000])),
    specs: new Set(sources.specs.map((spec) => spec.version)),
    quotes: new Set(quotes),
    changes: new Set(sources.changes.map((change) => day(change.created_at))),
    updates: new Set(sources.updates.map((update) => day(update.at))),
  };
}

/** Pure: a call's notes as a doc (no transcript: that stays in the project record). */
export function callDoc(call: Call): RepoFile {
  const label = callLabel(call);
  const list = (items: readonly string[]) => (items.length ? items.map((item) => `- ${item}`).join('\n') : '- none');
  const recorded = call.participants.filter((person) => person.recorded).map((person) => person.name);
  return {
    path: `${DOCS_FOLDER}/calls/${label.replace(' ', '-').replace(':', '')}.md`,
    content: [
      `# Call on ${label} UTC`,
      '',
      `${plural(Math.max(1, Math.round((call.ended_at.getTime() - call.started_at.getTime()) / 60_000)), 'minute')}. Recorded with consent: ${recorded.join(', ') || 'nobody'}.`,
      '',
      '## Summary',
      call.summary.summary,
      '',
      '## Decisions',
      list(call.summary.decisions),
      '',
      '## Action items',
      list(call.summary.action_items.map((item) => `${item.who === 'owner' ? OWNER_NAME : item.who === 'client' ? 'Client' : 'Both'}: ${item.what}`)),
      '',
      '## Open questions',
      list(call.summary.open_questions),
      '',
      '_AI-written from the call recording by Discordlancer. The full transcript is kept in the project record._',
      '',
    ].join('\n'),
  };
}

export interface DocsResult {
  files: RepoFile[];
  changeSummary: string[];
  issues: string[];
  citations: { total: number; unmatched: string[] };
  counts: { messages: number; images: number; files: number; calls: number; updates: number; changes: number };
  spec?: { version: number; status: string } | undefined;
  quote?: number | undefined;
}

/** Gathers every source, writes the docs, has them reviewed, and checks the citations. */
export async function writeDocs(ctx: BotContext, project: Project, channel: TextChannel): Promise<DocsResult> {
  const [messages, specs, quote, payments, changes, calls, events, memory, currentDocs] = await Promise.all([
    readConversation(channel, project.created_at, { ownerId: ctx.env.DISCORD_OWNER_ID, clientId: project.client_id }),
    listSpecs(ctx.db, project),
    latestQuote(ctx.db, project),
    paymentsFor(ctx.db, project),
    changeRequestsFor(ctx.db, project),
    callsFor(ctx.db, project),
    eventsForProject(ctx.db, project.id),
    safeRecall(ctx.memory, projectScope(project.name), 'Decisions, requirements, preferences and constraints agreed for this project'),
    ctx.github.readFolder(project.repo, DOCS_FOLDER),
  ]);
  const latest = specs.at(-1);
  const specAgreedBy = latest ? [...(await agreedParties(ctx.db, project, 'spec', latest.version))] : [];
  const quoteAgreedBy = quote ? [...(await agreedParties(ctx.db, project, 'quote', quote.version))] : [];
  const updates = events
    .filter((event) => event.action === 'dev.update_posted' && event.outcome === 'ok' && typeof event.data?.summary === 'string')
    .map((event) => ({ at: event.at, summary: String(event.data?.summary) }));
  const conversation = await conversationParts(messages);
  const sources: DocsSources = {
    project,
    specs,
    specAgreedBy,
    quote: quote ? { quote, agreedBy: quoteAgreedBy } : undefined,
    payments,
    changes,
    updates,
    calls,
    memory,
    messages,
    conversation: conversation.text,
    images: conversation.images,
    currentDocs,
  };
  const text = renderSources(sources);

  const draft = await ctx.gemini.json({
    model: SPEC_MODEL,
    system: DOCS_SYSTEM,
    input: [{ type: 'text', text }, ...conversation.images],
    schema: DOCS_DRAFT_SCHEMA,
    parse: DocsDraft,
    thinking: 'low',
    maxOutputTokens: 48_000,
  });
  const draftText = DOC_KEYS.map((key) => fence('doc', draft[key], ` path="${DOC_PATHS[key]}"`)).join('\n');
  const review = await ctx.gemini.json({
    model: SPEC_MODEL,
    system: DOCS_REVIEW_SYSTEM,
    input: [{ type: 'text', text: `${text}\n\n${fence('draft', draftText)}` }, ...conversation.images],
    schema: DOCS_REVIEW_SCHEMA,
    parse: DocsReview,
    // The careful pass: it caught real mistakes at medium that it missed at low (tested 10 Nov).
    thinking: 'medium',
    maxOutputTokens: 48_000,
  });

  const files: RepoFile[] = [
    ...DOC_KEYS.map((key) => ({ path: DOC_PATHS[key], content: `${review[key].trim()}\n` })),
    ...calls.map(callDoc),
  ];
  const quoteVersions = quote ? Array.from({ length: quote.version }, (_, index) => index + 1) : [];
  return {
    files,
    changeSummary: draft.change_summary,
    issues: review.issues,
    citations: checkCitations(DOC_KEYS.map((key) => review[key]), knownSources(sources, quoteVersions)),
    counts: {
      messages: messages.length,
      images: conversation.plan.images.length,
      files: conversation.plan.textFiles.length,
      calls: calls.length,
      updates: updates.length,
      changes: changes.length,
    },
    spec: latest ? { version: latest.version, status: agreement(specAgreedBy) } : undefined,
    quote: quote?.version,
  };
}

/** Pure: the first secret-looking thing in the docs, with its file, if any. */
export function secretInDocs(files: readonly RepoFile[]): string | undefined {
  for (const file of files) {
    const found = findSecret(file.content);
    if (found) return `${found} in ${file.path}`;
  }
  return undefined;
}

/** Pure: the pull request's description. */
export function pullBody(result: DocsResult, meta: { changedPaths: readonly string[] }): string {
  const { counts } = result;
  const sources = [
    plural(counts.messages, 'chat message'),
    counts.images ? plural(counts.images, 'image') : '',
    counts.files ? plural(counts.files, 'attached file') : '',
    result.spec ? `spec v${result.spec.version} (${result.spec.status})` : 'no spec yet',
    result.quote ? `quote v${result.quote}` : '',
    counts.calls ? plural(counts.calls, 'recorded call') : '',
    counts.updates ? plural(counts.updates, 'progress update') : '',
    counts.changes ? plural(counts.changes, 'change request') : '',
  ].filter(Boolean);
  const list = (items: readonly string[], max = 25) => [...items.slice(0, max).map((item) => `- ${item}`), ...(items.length > max ? [`- …and ${items.length - max} more`] : [])].join('\n');
  return [
    "Discordlancer updated this project's docs from everything recorded so far.",
    '',
    '**What changed**',
    result.changeSummary.length ? list(result.changeSummary) : '- First version of the docs, or only small wording changes.',
    '',
    `**Files:** ${meta.changedPaths.map((path) => `\`${path}\``).join(', ')}`,
    '',
    `**Sources:** ${sources.join(', ')}.`,
    '',
    result.issues.length ? `**Review:** a second AI pass checked every statement against the sources and fixed ${plural(result.issues.length, 'thing')}:\n${list(result.issues)}` : '**Review:** a second AI pass checked every statement against the sources and found nothing to fix.',
    '',
    result.citations.unmatched.length
      ? `**Citations:** ${result.citations.total} checked; these couldn't be matched to a source, so check them before merging:\n${list(result.citations.unmatched)}`
      : `**Citations:** ${result.citations.total} checked; each one matches a real message, call, spec, quote, change request or update.`,
    '',
    `_Written by AI (Gemini \`${SPEC_MODEL}\`, prompt \`${DOCS_PROMPT_VERSION}\`). ${OWNER_NAME} reviews it before merging. The agreed spec stays the contract._`,
  ].join('\n');
}
