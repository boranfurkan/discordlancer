# Context-driven actors

The principle behind a factory and the skills it runs. Read this before you
design an automation, plan or review one, or write or edit a skill a factory
runs.

**State of the world defines behavior.** An event is a reason for an actor to
look, not an instruction to replay a transition someone decided in advance.
The actor reads the world as it is now (the ticket, the branch, the pull
request, the checks, what people said last), decides what advances the
outcome, does that, and stops.

## Why

The situations real software work produces cannot be listed in full. A ticket
is rescoped while its pull request is open; a person pushes to the branch
between two runs; a reviewer approves and then asks for one more change; a
check fails for a reason unrelated to the change. A system built as a list of
transitions (in state A, on event E, do X) handles the pairs its authors
foresaw and does the wrong thing, or nothing, on every other one. Each pair
found later becomes another special case, and the list never closes.

An agent given the outcome to reach, the invariants that must hold on the
way, and concrete cases that show how to read ambiguous evidence can act
sensibly in a state nobody listed, the way an engineer who owns a ticket does.
[Factory skill shape](factory-skill-shape.md) gives the form a skill takes to
say this: what done looks like, invariants, environment facts and judgment.

## Judgment and guarantees

The principle decides what the model judges. It does not replace code that
must hold. Where a guarantee has to be enforced, a platform mechanism or a
deterministic script enforces it, and the skill relies on it rather than
restating it as advice:

- **Permissions.** What a run can write is decided by the access its
  environment grants, not by a sentence asking the agent not to write.
- **Concurrency.** Whether two runs on the same subject can overlap is decided
  by a concurrency key on the action or trigger, not by the agent checking for
  another run.
- **Destructive operations.** Branch protection, or a hook that refuses a
  command, blocks a force-push to or deletion of a protected branch whatever
  the agent concluded.
- **Reliable code paths.** Reading a record to the last page, computing a
  diff, or validating a schema stays a script or a library call. Moving such
  work into a prompt makes it less reliable, not more adaptable.

The agent decides what to do within those bounds; the bounds are not its
call. Where a guarantee is needed and no mechanism for it exists yet, an
instruction the agent can follow is the start, as [State in factory
skills](factory-skill-state.md) says, and the mechanism is the gap to close.

## Cases

- **The world changes while a run waits.** A run is queued behind another, and
  by the time it starts the pull request has merged or the ticket has been
  taken back. The event that queued it may no longer describe the world. The
  actor acts on what it finds when it looks, and adapts or does nothing. The
  current state is the input.
- **One subject, one lane.** The first implement run on a ticket and the run
  that wakes it after a person answers its question share one concurrency key,
  taken from the ticket's identifier, which exists from the first event. The
  platform keeps them from overlapping, so the skill does not check for the
  other run.
- **A guarantee stays deterministic.** A skill that may push to a branch runs
  in an environment whose access cannot write workflow files, on a repository
  whose default branch is protected. The skill tells the agent when a push is
  the right move; the access blocks writing workflow files, and the protection
  blocks pushing to or deleting the default branch, whatever the agent
  concluded.
- **An ordered procedure keeps its order.** Rotating a key (create the new
  one, store it, verify it works, revoke the old one) has one correct order.
  A key rotation skill is that ordered list of steps, in the skill text. What
  the agent reads from the world before step one is where the last attempt
  stopped: a new key that was stored but never verified, or an old key still
  live.
