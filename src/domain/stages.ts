// The project stages and which stage may follow which. Pure, so it's fully tested.
// See PLAN.md, "Stages".

export const STAGES = [
  'created',
  'joined',
  'specs_agreed',
  'quote_accepted',
  'paid',
  'in_development',
  'delivered',
  'support',
  'cancelled',
  'archived',
] as const;

export type Stage = (typeof STAGES)[number];

/** The normal path, plus going back when specs are regenerated or a new quote replaces an accepted one. */
const NEXT: Record<Stage, readonly Stage[]> = {
  created: ['joined'],
  joined: ['specs_agreed'],
  // Regenerating the specs clears their agreement.
  specs_agreed: ['joined', 'quote_accepted'],
  // New specs go back to joined; a new quote goes back to specs_agreed. Both only before payment.
  quote_accepted: ['joined', 'specs_agreed', 'paid'],
  paid: ['in_development'],
  in_development: ['delivered'],
  delivered: ['support'],
  support: [],
  cancelled: ['archived'],
  archived: [],
};

/** Boran can cancel or archive a project from any stage, except where that makes no sense. */
function closing(from: Stage, to: Stage): boolean {
  if (to === 'cancelled') return from !== 'cancelled' && from !== 'archived';
  if (to === 'archived') return from !== 'archived';
  return false;
}

export function canMove(from: Stage, to: Stage): boolean {
  return NEXT[from].includes(to) || closing(from, to);
}

export class StageError extends Error {
  override name = 'StageError';
  constructor(
    readonly from: Stage,
    readonly to: Stage,
  ) {
    super(`A project can't go from ${from} to ${to}`);
  }
}

export function assertMove(from: Stage, to: Stage): void {
  if (!canMove(from, to)) throw new StageError(from, to);
}

/** Stages after which specs and the quote are frozen. */
export function isPaidOrLater(stage: Stage): boolean {
  return ['paid', 'in_development', 'delivered', 'support'].includes(stage);
}

export function isClosed(stage: Stage): boolean {
  return stage === 'cancelled' || stage === 'archived';
}
