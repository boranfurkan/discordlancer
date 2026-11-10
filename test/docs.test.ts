import { RecordId } from 'surrealdb';
import { describe, expect, it } from 'vitest';
import type { Call } from '../src/db/calls.js';
import { callDoc, checkCitations, secretInDocs, type KnownSources } from '../src/discord/docs.js';
import { gitBlobSha, isSafePath } from '../src/services/github.js';

const known: KnownSources = {
  chat: new Set(['2026-11-12 14:03']),
  calls: new Map([['2026-11-13 10:00', 30 * 60]]),
  specs: new Set([1, 2]),
  quotes: new Set([1]),
  changes: new Set(['2026-11-20']),
  updates: new Set(['2026-11-14']),
};

describe('citation check', () => {
  it('accepts citations that point at real sources', () => {
    const text = '- Pick a barber [chat 2026-11-12 14:03] [call 2026-11-13 10:00, 00:12:30] [spec v2] [quote v1] [change 2026-11-20] [update 2026-11-14]';
    expect(checkCitations([text], known)).toEqual({ total: 6, unmatched: [] });
  });

  it('lists citations that point nowhere, once each', () => {
    const text = [
      '[chat 2026-11-12 14:04]', // no message at that minute
      '[call 2026-11-13 10:00, 01:10:00]', // past the end of a 30-minute call
      '[call 2026-11-14 10:00, 00:01:00]', // no such call
      '[spec v3]',
      '[quote v2]',
      '[change 2026-11-21]',
      '[chat 2026-11-12 14:04]',
    ].join(' ');
    const result = checkCitations([text], known);
    expect(result.total).toBe(7);
    expect(result.unmatched).toEqual(['[chat 2026-11-12 14:04]', '[call 2026-11-13 10:00, 01:10:00]', '[call 2026-11-14 10:00, 00:01:00]', '[spec v3]', '[quote v2]', '[change 2026-11-21]']);
  });
});

describe('docs files', () => {
  it('give each call its own notes file, without the transcript', () => {
    const call = {
      id: new RecordId('call', 'x'),
      project: new RecordId('project', 'alpha'),
      started_at: new Date('2026-11-13T10:00:00Z'),
      ended_at: new Date('2026-11-13T10:30:00Z'),
      participants: [
        { user_id: 'o', name: 'Furkan', role: 'owner', recorded: true },
        { user_id: 'c', name: 'Ayse', role: 'client', recorded: false },
      ],
      transcript: '[00:00:01] Furkan (owner): A secret plan.',
      summary: { summary: 'Kick-off.', decisions: ['Use Stripe'], action_items: [{ who: 'client', what: 'Send the logo' }], open_questions: [] },
      speech_seconds: 600,
      segments: 10,
      model: 'm',
      prompt_version: 'p',
      created_at: new Date(),
    } satisfies Call;
    const file = callDoc(call);
    expect(file.path).toBe('docs/project/calls/2026-11-13-1000.md');
    expect(isSafePath(file.path)).toBe(true);
    expect(file.content).toContain('30 minutes. Recorded with consent: Furkan.');
    expect(file.content).toContain('- Use Stripe');
    expect(file.content).toContain('- Client: Send the logo');
    expect(file.content).not.toContain('A secret plan');
  });

  it('are never committed with something that looks like a key', () => {
    expect(secretInDocs([{ path: 'docs/project/README.md', content: 'Fine.' }])).toBeUndefined();
    expect(secretInDocs([{ path: 'docs/project/decisions.md', content: `Use key sk_live_${'a'.repeat(24)}` }])).toBe('a Stripe key in docs/project/decisions.md');
  });

  it("match git's own file ids, and refuse unsafe paths", () => {
    expect(gitBlobSha('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a'); // git hash-object
    expect(gitBlobSha('')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
    expect(isSafePath('docs/project/README.md')).toBe(true);
    expect(isSafePath('../etc/passwd')).toBe(false);
    expect(isSafePath('/docs/x.md')).toBe(false);
    expect(isSafePath('docs//x.md')).toBe(false);
  });
});
