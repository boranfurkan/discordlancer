import { describe, expect, it } from 'vitest';
import { LIMITS, planAttachments, renderConversation, type ChatMessage } from '../../src/discord/transcript.js';
import { fitMessage } from '../../src/discord/texts.js';

const MB = 1024 * 1024;
const at = (minute: number) => new Date(Date.UTC(2026, 10, 9, 10, minute));

function message(minute: number, role: ChatMessage['role'], text: string, attachments: ChatMessage['attachments'] = []): ChatMessage {
  return { id: `m${minute}`, at: at(minute), role, author: role === 'client' ? 'Alice' : 'Furkan', text, attachments };
}

const image = (name: string, size = 100_000) => ({ id: name, name, contentType: 'image/png', size, url: `https://cdn.example/${name}` });

describe('planAttachments', () => {
  it('sends images and small text files, and says why others were skipped', () => {
    const plan = planAttachments([
      message(1, 'client', 'see', [
        image('a.png'),
        { id: 'att', name: 'notes.txt', contentType: 'text/plain; charset=utf-8', size: 500, url: 'https://cdn.example/notes.txt' },
        { id: 'att', name: 'brief.pdf', contentType: 'application/pdf', size: 500, url: 'https://cdn.example/brief.pdf' },
        image('huge.png', 8 * MB),
      ]),
    ]);
    expect(plan.images.map((i) => i.name)).toEqual(['a.png']);
    expect(plan.textFiles.map((f) => f.name)).toEqual(['notes.txt']);
    expect(plan.skipped).toEqual([
      { name: 'brief.pdf', reason: 'file type not read' },
      { name: 'huge.png', reason: 'image too large' },
    ]);
  });

  it('stops at the image count and total size limits', () => {
    const many = Array.from({ length: LIMITS.maxImages + 2 }, (_, i) => image(`i${i}.png`));
    expect(planAttachments([message(1, 'client', '', many)]).images).toHaveLength(LIMITS.maxImages);

    const big = Array.from({ length: 4 }, (_, i) => image(`b${i}.png`, 5 * MB));
    const plan = planAttachments([message(1, 'client', '', big)]);
    expect(plan.images).toHaveLength(3);
    expect(plan.skipped[0]?.reason).toBe('images too large in total');
  });
});

describe('renderConversation', () => {
  it('labels who said what, numbers images and inlines read files', () => {
    const messages = [
      message(1, 'client', 'I need a booking app', [image('mock.png')]),
      message(2, 'owner', 'Which platforms?', [
        { id: 'att', name: 'notes.txt', contentType: 'text/plain', size: 10, url: 'https://cdn.example/notes.txt' },
      ]),
    ];
    const plan = planAttachments(messages);
    const text = renderConversation(messages, plan, new Map([['https://cdn.example/notes.txt', 'iOS first']]));
    expect(text).toBe(
      [
        '<conversation>',
        '[2026-11-09 10:01 UTC] Client (Alice): I need a booking app',
        '  [image 1: mock.png]',
        '[2026-11-09 10:02 UTC] Furkan (owner): Which platforms?',
        '  [file: notes.txt]',
        '  <file name="notes.txt">',
        'iOS first',
        '  </file>',
        '</conversation>',
      ].join('\n'),
    );
  });

  it('keeps the newest messages when the conversation is too long', () => {
    const long = Array.from({ length: 4_000 }, (_, i) => message(i % 60, 'client', `message ${i} ${'x'.repeat(100)}`));
    const text = renderConversation(long, planAttachments(long), new Map());
    expect(text.length).toBeLessThanOrEqual(LIMITS.maxTranscriptChars + 40);
    expect(text.startsWith('<conversation truncated>')).toBe(true);
    expect(text).toContain('message 3999');
    expect(text).not.toContain('message 0 ');
  });
});

describe('fitMessage', () => {
  it('leaves short text alone and shortens long text under the Discord limit', () => {
    expect(fitMessage('hello')).toBe('hello');
    const long = fitMessage('x'.repeat(5_000));
    expect(long.length).toBeLessThanOrEqual(1_950);
    expect(long.endsWith('…(shortened)')).toBe(true);
  });
});
