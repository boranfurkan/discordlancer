// Pure: recorded calls as text for Gemini prompts (/ask, specs and docs), fenced as data.

import { callLabel, type Call } from '../db/calls.js';

/** Call transcripts in a prompt: newest calls first, each one cut to fit. */
export const CALL_TEXT_LIMITS = { perCall: 40_000, total: 120_000 };

/** Pure: the recorded calls, newest first within the limits, then put back in date order. */
export function renderCalls(calls: readonly Call[], limits = CALL_TEXT_LIMITS): string {
  if (calls.length === 0) return '';
  const blocks: string[] = [];
  let used = 0;
  for (const call of [...calls].reverse()) {
    const transcript = call.transcript.length > limits.perCall ? `${call.transcript.slice(0, limits.perCall)}\n<transcript cut>` : call.transcript;
    const block = [
      `<call started="${callLabel(call)} UTC" minutes="${Math.max(1, Math.round((call.ended_at.getTime() - call.started_at.getTime()) / 60_000))}">`,
      `Summary (AI): ${call.summary.summary}`,
      ...call.summary.decisions.map((decision) => `Decision: ${decision}`),
      ...call.summary.action_items.map((item) => `Action item (${item.who}): ${item.what}`),
      ...call.summary.open_questions.map((question) => `Open question: ${question}`),
      'Transcript (AI):',
      transcript,
      '</call>',
    ].join('\n');
    if (used + block.length > limits.total && blocks.length) break;
    blocks.unshift(block);
    used += block.length;
  }
  return `<calls>\n${blocks.join('\n')}\n</calls>`;
}

