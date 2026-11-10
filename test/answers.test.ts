import { RecordId } from 'surrealdb';
import { describe, expect, it } from 'vitest';
import { ANSWER_CONVERSATION_CHARS, formatAnswer, renderAnswerInput, type AnswerContext } from '../src/discord/answers.js';
import { tagsBot, withoutTag } from '../src/discord/ownerAnswer.js';
import type { Project } from '../src/db/projects.js';
import { AnswerOutput } from '../src/prompts/answers.js';

const BOT = '123456789012345678';

describe('tagging the bot', () => {
  it('counts only an explicit tag, not a reply ping or another mention', () => {
    expect(tagsBot(`<@${BOT}> answer this`, BOT)).toBe(true);
    expect(tagsBot(`please <@!${BOT}>`, BOT)).toBe(true);
    expect(tagsBot('Thanks!', BOT)).toBe(false);
    expect(tagsBot('<@999999999999999999> hi', BOT)).toBe(false);
  });

  it("keeps Boran's words as the note", () => {
    expect(withoutTag(`<@${BOT}>   mention we use   Stripe `, BOT)).toBe('mention we use Stripe');
    expect(withoutTag(`<@${BOT}>`, BOT)).toBe('');
  });
});

const output = (extra: Partial<AnswerOutput> = {}): AnswerOutput =>
  AnswerOutput.parse({ answer: 'Yes, it is in spec v2.', needs_owner: false, owner_note: '', confidence: 'high', based_on: ['spec'], ...extra });

describe('formatAnswer', () => {
  it('always marks the answer as AI, with what it was based on', () => {
    const text = formatAnswer(output({ based_on: ['spec', 'code', 'chat'] }), { commit: 'abcdef1234', question: 'Is   it\nin?' });
    expect(text.split('\n')[0]).toBe('> Is it in?');
    expect(text).toContain('Yes, it is in spec v2.');
    expect(text).toContain('-# AI answer from the spec, the code at `abcdef1`, the chat. Confidence: high.');
    expect(text).not.toContain('follow up');
  });

  it('says Furkan will follow up when it needs him, once', () => {
    expect(formatAnswer(output({ needs_owner: true, owner_note: 'Price question' }), {})).toContain('Furkan will follow up on this.');
    const own = formatAnswer(output({ answer: 'Furkan decides discounts and will follow up.', needs_owner: true }), {});
    expect(own).not.toContain('Furkan will follow up on this.');
  });

  it('fits in one Discord message', () => {
    expect(formatAnswer(output({ answer: 'x'.repeat(1_500) }), { question: 'q'.repeat(2_000) }).length).toBeLessThanOrEqual(2_000);
  });
});

const project: Project = {
  id: new RecordId('project', 'demo'),
  name: 'demo',
  channel_id: '1',
  repo: 'boranfurkan/demo',
  stage: 'joined',
  created_at: new Date('2026-11-10T09:00:00Z'),
  updated_at: new Date('2026-11-10T09:00:00Z'),
};

const base = (extra: Partial<AnswerContext> = {}): AnswerContext => ({
  project,
  payments: [],
  changes: [],
  memory: '',
  messages: [],
  question: 'What is the deadline?',
  ...extra,
});

describe('renderAnswerInput', () => {
  it('says plainly what is missing instead of leaving gaps', () => {
    const input = renderAnswerInput(base());
    expect(input).toContain('Stage: Talking about the project');
    expect(input).toContain('Quote: none yet.');
    expect(input).toContain('Payments received: none.');
    expect(input).toContain('<spec>No spec written yet.</spec>');
    expect(input).toContain('<code>The code could not be read just now.</code>');
    expect(input.trimEnd().endsWith('<question>\nWhat is the deadline?\n</question>')).toBe(true);
  });

  it('includes the chat with each speaker, newest kept when it is very long', () => {
    const at = new Date('2026-11-10T10:00:00Z');
    const said = (role: 'owner' | 'client' | 'bot', text: string) => ({ id: text.slice(0, 8), at, role, author: role, text, attachments: [] });
    const input = renderAnswerInput(base({ messages: [said('client', 'old start'), said('bot', 'x'.repeat(ANSWER_CONVERSATION_CHARS)), said('owner', 'latest word')] }));
    expect(input).toContain('<conversation truncated>');
    expect(input).not.toContain('old start');
    expect(input).toContain('Furkan (owner): latest word');
  });

  it("fences Boran's note and the code as separate data", () => {
    const input = renderAnswerInput(
      base({ ownerNote: 'say Friday', code: { branch: 'main', commit: 'abc1234ffff', paths: ['a.ts'], files: [{ path: 'a.ts', content: 'x' }] } }),
    );
    expect(input).toContain('<owner_note>\nsay Friday\n</owner_note>');
    expect(input).toContain('<code branch="main" commit="abc1234">');
    expect(input).toContain('<file path="a.ts">\nx\n</file>');
  });
});
