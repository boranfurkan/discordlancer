import { describe, expect, it } from 'vitest';
import { helpText } from '../../src/discord/commands/help.js';
import { actorFor, checkAccess } from '../../src/discord/guards.js';

const OWNER = '323456789012345678';
const CLIENT = '423456789012345678';

describe('guards', () => {
  it('tells the owner from everyone else', () => {
    expect(actorFor(OWNER, OWNER)).toBe('owner');
    expect(actorFor(CLIENT, OWNER)).toBe('client');
  });

  it('refuses owner-only commands to clients with a clear reply', () => {
    expect(checkAccess({ access: 'owner' }, CLIENT, OWNER)).toEqual({ ok: false, reply: 'Only Furkan can do this.' });
    expect(checkAccess({ access: 'owner' }, OWNER, OWNER)).toEqual({ ok: true });
    expect(checkAccess({ access: 'everyone' }, CLIENT, OWNER)).toEqual({ ok: true });
  });
});

describe('helpText', () => {
  const commands = [
    { name: 'help', description: 'Show the commands you can use', access: 'everyone' as const },
    { name: 'quote', description: 'Post a quote', access: 'owner' as const },
  ];

  it('shows clients only what they can run', () => {
    const text = helpText(commands, false);
    expect(text).toContain('/help');
    expect(text).not.toContain('/quote');
  });

  it('shows the owner everything, marking owner-only commands', () => {
    expect(helpText(commands, true)).toContain('**/quote**: Post a quote (Furkan only)');
  });
});
