import { RecordId } from 'surrealdb';
import { describe, expect, it } from 'vitest';
import type { Project } from '../../src/db/projects.js';
import { checkGate } from '../../src/discord/client.js';
import { helpText } from '../../src/discord/commands/help.js';
import { COMMANDS } from '../../src/discord/commands/index.js';
import { projectCard } from '../../src/discord/commands/project.js';
import { actorFor, checkAccess } from '../../src/discord/guards.js';
import { matchJoin } from '../../src/discord/joins.js';

const OWNER = '323456789012345678';
const CLIENT = '423456789012345678';
const STRANGER = '523456789012345678';

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

describe('checkGate', () => {
  const projectCommand = { access: 'everyone', where: 'project', stages: ['joined'] } as const;
  const joined = { client_id: CLIENT, stage: 'joined' } as const;

  it('lets the owner and the project client in', () => {
    expect(checkGate(projectCommand, OWNER, OWNER, joined)).toEqual({ ok: true });
    expect(checkGate(projectCommand, CLIENT, OWNER, joined)).toEqual({ ok: true });
  });

  it('keeps everyone else out of a project', () => {
    expect(checkGate(projectCommand, STRANGER, OWNER, joined)).toMatchObject({ ok: false, reason: 'not their project' });
  });

  it('refuses project commands outside a project channel', () => {
    expect(checkGate(projectCommand, OWNER, OWNER, undefined)).toMatchObject({ ok: false, reason: 'not a project channel' });
  });

  it('refuses at the wrong stage, naming the stage in plain words', () => {
    const gate = checkGate(projectCommand, OWNER, OWNER, { client_id: CLIENT, stage: 'paid' });
    expect(gate).toMatchObject({ ok: false, reason: 'stage paid' });
    expect(gate.ok ? '' : gate.reply).toContain('(Paid)');
  });

  it('checks owner-only before anything else', () => {
    expect(checkGate({ access: 'owner', where: 'anywhere' }, CLIENT, OWNER, undefined)).toMatchObject({ reason: 'owner only' });
  });
});

describe('helpText', () => {
  it('outside a project, lists only commands that work anywhere', () => {
    const owner = helpText(COMMANDS, true);
    expect(owner).toContain('/new-project');
    expect(owner).not.toContain('/link-client');
    const client = helpText(COMMANDS, false);
    expect(client).toContain('/help');
    expect(client).not.toContain('/new-project');
  });

  it('in a project, shows the stage, the next step and what fits this stage', () => {
    const text = helpText(COMMANDS, true, 'created');
    expect(text).toContain('**Stage:** Waiting for the client to join');
    expect(text).toContain('/link-client');
    expect(helpText(COMMANDS, true, 'joined')).not.toContain('/link-client');
  });

  it('never shows clients owner-only commands, and marks them for the owner', () => {
    expect(helpText(COMMANDS, false, 'created')).not.toContain('/cancel');
    expect(helpText(COMMANDS, true, 'created')).toContain('/cancel**: Cancel this project (the channel stays readable) (Furkan only)');
  });

  it('hides /cancel once a project is closed, but still allows /archive after cancelling', () => {
    expect(helpText(COMMANDS, true, 'cancelled')).not.toContain('/cancel');
    expect(helpText(COMMANDS, true, 'cancelled')).toContain('/archive');
    expect(helpText(COMMANDS, true, 'archived')).not.toContain('/archive');
  });
});

describe('matchJoin', () => {
  const now = new Date('2026-11-10T12:00:00Z');
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
  const candidates = [
    { name: 'alpha', inviteCode: 'aaa', createdAt: hoursAgo(1) },
    { name: 'beta', inviteCode: 'bbb', createdAt: hoursAgo(2) },
    { name: 'old', inviteCode: 'ooo', createdAt: hoursAgo(24 * 8) },
  ];

  it('picks the project whose invite was just used up', () => {
    expect(matchJoin(candidates, new Set(['bbb']), now)).toEqual({ kind: 'one', name: 'alpha' });
  });

  it('ignores invites that vanished because they expired', () => {
    expect(matchJoin(candidates, new Set(['aaa', 'bbb']), now)).toEqual({ kind: 'none' });
  });

  it('refuses to guess when two invites vanished at once', () => {
    expect(matchJoin(candidates, new Set(), now)).toEqual({ kind: 'many', names: ['alpha', 'beta'] });
  });
});

describe('projectCard', () => {
  it('shows plain-language stage, next step and missing pieces', () => {
    const project: Project = {
      id: new RecordId('project', 'alpha'),
      name: 'alpha',
      channel_id: 'c',
      repo: 'owner/alpha',
      stage: 'created',
      created_at: new Date('2026-11-09T10:00:00Z'),
      updated_at: new Date('2026-11-09T10:00:00Z'),
    };
    const card = projectCard(project);
    const field = (name: string) => card.fields.find((f) => f.name === name)?.value;
    expect(card.title).toBe('alpha');
    expect(field('Stage')).toBe('Waiting for the client to join');
    expect(field('Client')).toBe('Not joined yet');
    expect(field('Repo')).toBe('https://github.com/owner/alpha');
    expect(field('Started')).toBe('<t:1794218400:D>');
  });
});
