import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertMove, canMove, isPaidOrLater, STAGES, StageError, type Stage } from '../../src/domain/stages.js';

describe('stage moves', () => {
  it('allows the normal path', () => {
    const path: Stage[] = ['created', 'joined', 'specs_agreed', 'quote_accepted', 'paid', 'in_development', 'delivered', 'support'];
    for (let i = 1; i < path.length; i++) expect(canMove(path[i - 1]!, path[i]!)).toBe(true);
  });

  it('goes back when specs are regenerated or a new quote replaces an accepted one, before payment only', () => {
    expect(canMove('specs_agreed', 'joined')).toBe(true);
    expect(canMove('quote_accepted', 'joined')).toBe(true);
    expect(canMove('quote_accepted', 'specs_agreed')).toBe(true);
    expect(canMove('paid', 'joined')).toBe(false);
    expect(canMove('paid', 'specs_agreed')).toBe(false);
    expect(canMove('in_development', 'quote_accepted')).toBe(false);
  });

  it('refuses skipping ahead', () => {
    expect(canMove('created', 'paid')).toBe(false);
    expect(canMove('joined', 'quote_accepted')).toBe(false);
    expect(canMove('quote_accepted', 'in_development')).toBe(false);
    expect(canMove('in_development', 'support')).toBe(false);
  });

  it('lets Boran cancel or archive from any open stage', () => {
    for (const stage of STAGES) {
      expect(canMove(stage, 'cancelled')).toBe(stage !== 'cancelled' && stage !== 'archived');
      expect(canMove(stage, 'archived')).toBe(stage !== 'archived');
    }
  });

  it('never leaves archived', () => {
    for (const stage of STAGES) expect(canMove('archived', stage)).toBe(false);
  });

  it('throws a StageError naming both stages', () => {
    expect(() => assertMove('created', 'paid')).toThrow(StageError);
    expect(() => assertMove('created', 'paid')).toThrow(/created to paid/);
    expect(() => assertMove('created', 'joined')).not.toThrow();
  });

  it('knows which stages freeze specs and quotes', () => {
    expect(STAGES.filter(isPaidOrLater)).toEqual(['paid', 'in_development', 'delivered', 'support']);
  });
});

describe('schema agreement', () => {
  it('lists exactly the same stages in schema.surql', () => {
    const schema = readFileSync(new URL('../../src/db/schema.surql', import.meta.url), 'utf8');
    const block = /DEFINE FIELD OVERWRITE stage ON project[^\[]*\[([^\]]*)\]/.exec(schema)?.[1] ?? '';
    const inSchema = [...block.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
    expect(inSchema).toEqual([...STAGES]);
  });
});
