import { afterEach, describe, expect, it, vi } from 'vitest';
import { log, registerSecrets, scrub } from '../src/log.js';

describe('scrub', () => {
  registerSecrets(['sk-very-secret-token', 'sk-very-secret', 'short']);

  it('hides registered secrets wherever they appear', () => {
    expect(scrub('token=sk-very-secret-token&x=1')).toBe('token=[hidden]&x=1');
  });

  it('hides the longer secret whole when one contains another', () => {
    expect(scrub('a sk-very-secret-token b sk-very-secret c')).toBe('a [hidden] b [hidden] c');
  });

  it('ignores values too short to be secrets, so ordinary words survive', () => {
    expect(scrub('a short note')).toBe('a short note');
  });
});

describe('log', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes one scrubbed JSON line, with errors expanded', () => {
    registerSecrets(['hunter2-password']);
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    log.error('failed', { error: new Error('bad hunter2-password'), count: 2n });
    expect(write).toHaveBeenCalledTimes(1);
    const line = String(write.mock.calls[0]?.[0]);
    expect(line.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(line) as { level: string; message: string; count: string; error: { message: string } };
    expect(parsed).toMatchObject({ level: 'error', message: 'failed', count: '2' });
    expect(parsed.error.message).toBe('bad [hidden]');
    expect(line).not.toContain('hunter2-password');
  });
});
