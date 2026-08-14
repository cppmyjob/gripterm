import { ValidationError } from '../errors/gripterm-error';

/**
 * How long a fresh shell is given before the launch line is typed into it.
 *
 * Every field is a duration in milliseconds, and every default that fills them
 * is a measurement rather than a preference -- see `shellQuietVerdict`.
 */
export interface ShellQuietPolicy {
  /** Quiet required before the line is typed. */
  readonly graceMs: number;
  /** How long the shell is given to announce itself at all. */
  readonly readyMs: number;
  /** The upper bound on the whole wait, whatever anybody else is doing. */
  readonly patienceMs: number;
}

/**
 * What is known about a terminal that has just been made.
 *
 * `integrationAt` is when the shell announced it was listening -- the editor
 * reports this only for a shell whose integration is in play. `inFlight` counts
 * commands started and not yet ended, ANYBODY's, and `lastEndedAt` is when the
 * last of them ended.
 */
export interface ShellQuietState {
  readonly createdAt: number;
  readonly integrationAt: number | null;
  readonly inFlight: number;
  readonly lastEndedAt: number | null;
}

/**
 * `wait` -- not yet. `quiet` -- the shell said it was ready and has been idle
 * since. `impatient` -- it never said so, or somebody's command is still going
 * and the bound is up; the line is typed anyway and the log says which it was.
 */
export type ShellQuietVerdict = 'wait' | 'quiet' | 'impatient';

/**
 * Whether the launch line may be typed into this shell yet.
 *
 * The whole reason this exists, measured in a real host on 2026-08-14 across
 * three runs. A terminal that another extension types into on `onDidOpenTerminal`
 * -- an environment activation, a profile switch, anything -- receives that line
 * some 20-60 ms after it is made, but the shell only announces itself at 5.2-5.7
 * seconds, and their command actually RUNS 277-423 ms after that. Our own line,
 * typed as soon as the terminal exists, therefore goes first: measured
 * `["ours", "other"]`. In the launch mode where the agent is the terminal's own
 * process that is unavoidable and their line lands in the agent's prompt; in the
 * shell mode it is avoidable, and this is what avoids it.
 *
 * Waiting for the announcement alone is NOT enough -- when it arrives, their
 * command has not started yet -- which is what the grace is for, and why the
 * grace is re-armed by every command that ends.
 *
 * The bound exists because a shell can be busy forever: somebody's watch task,
 * a build, a prompt waiting for a keypress. Being impatient is cheap and was
 * measured to be: a line typed into a busy shell is buffered and runs after it,
 * `["other", "ours"]`, both alive and in order. What is NOT safe is the editor's
 * own `shellIntegration.executeCommand` while a command is in flight -- measured
 * twice, and each time ONE OF THE TWO commands disappeared, once theirs and once
 * ours. That is why nothing here decides to execute; it decides only when to
 * type.
 *
 * A clock going backwards reads as `wait`, which is the direction every unknown
 * in this project falls: a line not yet typed can still be typed.
 *
 * What is NOT claimed for the in-flight rule: it does not change the order
 * anything runs in. Since typing into a busy shell is buffered, a line sent
 * while their command runs still runs after it -- so on the outside, waiting for
 * a command to end looks the same as not waiting, and no test in a real host can
 * tell the two apart. It is kept for the case that is not the same and is not
 * measured either: a command that READS what is typed while it runs -- a prompt,
 * a confirmation -- would swallow the launch line as its answer.
 */
export function shellQuietVerdict(
  state: ShellQuietState,
  now: number,
  policy: ShellQuietPolicy
): ShellQuietVerdict {
  if (!(policy.graceMs > 0) || !(policy.readyMs > 0)) {
    throw new ValidationError('a shell is given a positive grace and a positive wait, or none is meant', {
      details: { graceMs: policy.graceMs, readyMs: policy.readyMs },
    });
  }
  if (policy.patienceMs < policy.readyMs + policy.graceMs) {
    // A bound below the sum reads "give up" before it can ever read "quiet":
    // the ordering it promises could not be kept even on a shell that behaves.
    throw new ValidationError('patience must outlast the wait for the shell and the grace after it', {
      details: { graceMs: policy.graceMs, readyMs: policy.readyMs, patienceMs: policy.patienceMs },
    });
  }

  const waited = now - state.createdAt;
  if (state.integrationAt === null) {
    return waited >= policy.readyMs ? 'impatient' : 'wait';
  }
  const spent = waited >= policy.patienceMs ? 'impatient' : 'wait';
  if (state.inFlight > 0) {
    return spent;
  }
  // Whichever came last: their command starts AFTER the announcement, so the
  // announcement on its own never says the shell went quiet.
  const since = Math.max(state.integrationAt, state.lastEndedAt ?? state.integrationAt);
  return now - since >= policy.graceMs ? 'quiet' : spent;
}
