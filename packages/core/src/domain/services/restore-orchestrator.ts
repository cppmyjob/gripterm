import { isWitnessedEnd } from './terminal-state-machine';
import { resumeTimedOut } from '../events/terminal-event';
import type { Disposable } from '../ports/disposable';
import type { Logger } from '../ports/logger';
import type { RegistryChange, SessionRegistry } from './session-registry';
import type { RestorePlan, RestoreSkip, RestoreStep } from './restore-planner';
import type { Scheduler } from '../ports/scheduler';
import type { TerminalEntry } from '../entities/terminal-entry';
import type { TerminalId } from '../entities/terminal-id';
import type { TerminalLifecycleService } from './terminal-lifecycle';
import type { TerminalRepository } from '../repositories/terminal-repository';

/**
 * How long a restored terminal may say nothing before the row admits we have
 * lost track of it. [П]
 *
 * The same twenty seconds the silence watch uses (M2.8), and for the same
 * reason: it clears a cold start with room to spare -- `claude --version`
 * answers in 264 ms, the TUI's first output came at 31 ms (A13), and the
 * `SessionStart` forwarder is a node process start on top of that.
 *
 * It is NOT the timeout for a restore that FAILS. `claude --resume` on a
 * conversation that is not there prints its refusal and exits with code 1 in
 * milliseconds [measured], and that arrives as `ResumeExitedNonZero` rather than
 * as silence. This number covers a start that hangs, which is a different animal
 * and gets a different state: `degraded` says "running, phase unknown", and a
 * late event takes it back.
 */
export const DEFAULT_RESUME_TIMEOUT_MS = 20_000;

/** What happened to one record this window meant to bring back. */
export type RestoreOutcome =
  /** Adopted and started. Whether it answers is a separate question. */
  | 'started'
  /** Another window got there first, or the record moved under the plan. */
  | 'contested'
  /** Ours now, and the process could not be started. See `_restore`. */
  | 'unstartable';

export interface RestoreAttempt {
  readonly terminalId: TerminalId;
  /** Carried so that a log line and a message to a person can name the terminal. */
  readonly displayName: string;
  readonly outcome: RestoreOutcome;
  /** The words the failure came with, or `null` when there was none. */
  readonly reason: string | null;
}

export interface RestoreReport {
  readonly started: number;
  readonly attempts: readonly RestoreAttempt[];
  /**
   * The plan's refusals, passed through untouched.
   *
   * Here rather than left with the plan so that one object answers the question
   * a person actually asks -- "what happened to my terminals" -- and so that
   * M2.14, which offers the explicit adoption these refusals point at, reads one
   * result instead of joining two.
   */
  readonly skipped: readonly RestoreSkip[];
}

export interface RestoreOrchestratorOptions {
  readonly repository: TerminalRepository;
  readonly registry: SessionRegistry;
  readonly lifecycle: TerminalLifecycleService;
  readonly scheduler: Scheduler;
  readonly logger: Logger;
  /** Defaults to `DEFAULT_RESUME_TIMEOUT_MS`. */
  readonly resumeTimeoutMs?: number;
}

/** One restore between its start and the first thing that settles it. */
interface Pending {
  timer: Disposable | null;
}

/**
 * The steps of a plan, carried out.
 *
 * The plan says WHICH records may come back (M2.10, a pure function); this says
 * what bringing one back consists of, in the order the parts must happen:
 * adoption, then a fresh `settings.json` for THIS activation's port, then a
 * hidden terminal, then the wait, then the pane.
 *
 * **The order is the design, and the first step is why.** Adoption is a
 * compare-and-swap against the revision the DECISION was made on, so a record
 * another window took while the plan was being made turns this step away instead
 * of producing a second `claude --resume` on one conversation. Nothing may be
 * started before it succeeds, and nothing re-reads the record to find a fresher
 * revision -- doing that would pass the check at exactly the moment it exists to
 * fail (`RestoreStep.expectedRevision`).
 *
 * **The settings file is not written here and that is deliberate.** It is
 * written by the launch pipeline, on every start, from the address of the
 * activation doing the starting (§4.4: the file is a derived artefact and the
 * recipe is what we keep). A restore that reused the file left by a previous
 * activation would start a terminal that works perfectly and posts its events to
 * a port nobody is listening on -- a failed hook is non-blocking, so it would be
 * silent -- and every restored terminal would then reach `degraded` together.
 * The one line of code that makes this true is that the command is BUILT at
 * start time, and the test for it is that a second activation on a different
 * port still reaches `idle`.
 *
 * **The terminal is created hidden and revealed afterwards.** A window coming
 * back with five terminals would otherwise open five panes and leave the cursor
 * in whichever answered last, and a restore that fails in milliseconds would
 * flash a pane on the way past. What ends the wait is the first evidence that
 * the process is talking to us -- any event routed to that record, not
 * `SessionStart` alone. That is wider than the plan's line on purpose: on a
 * machine with no `node` the `SessionStart` forwarder does not exist (H1), so
 * insisting on it would leave a perfectly good conversation hidden for ever.
 *
 * **A wait that expires reveals the terminal too**, after moving the row to
 * `degraded`. The alternative -- a running `claude` with no pane, in a state
 * nobody is told about -- is the silent failure this whole extension exists to
 * remove. The process is not killed: we do not know that anything is wrong with
 * it, only that it has not spoken to us.
 */
export class RestoreOrchestrator implements Disposable {
  private readonly _options: RestoreOrchestratorOptions;
  private readonly _waiting = new Map<string, Pending>();
  private readonly _subscription: Disposable;

  constructor(options: RestoreOrchestratorOptions) {
    this._options = options;
    this._subscription = options.registry.subscribe((change) => {
      this._onChange(change);
    });
  }

  /**
   * Carries out a plan, one record at a time, and returns what became of it.
   *
   * Sequential deliberately. Each step spawns a process and takes a claim file
   * in the store, and a dozen at once on a window that had a dozen terminals is
   * a thundering herd against both. What is NOT sequential is the waiting: a
   * step returns as soon as its terminal exists, and the twenty seconds it may
   * spend saying nothing overlap with every other one's.
   */
  public async run(plan: RestorePlan): Promise<RestoreReport> {
    this._reportRefusals(plan.skipped);

    const attempts: RestoreAttempt[] = [];
    for (const step of plan.steps) {
      attempts.push(await this._restore(step));
    }

    const started = attempts.filter((attempt) => attempt.outcome === 'started').length;
    this._options.logger.info('this window has finished bringing its terminals back', {
      planned: plan.steps.length,
      started,
      skipped: plan.skipped.length,
    });
    return { started, attempts, skipped: plan.skipped };
  }

  /**
   * Stops listening and cancels what was waiting.
   *
   * The map of waits is deliberately NOT emptied. Clearing it would be a second
   * mechanism for the rule the first line already keeps -- a late event must not
   * reveal anything -- and the second one masks the failure of the first: with
   * both in place, a subscription left behind is invisible to every test that
   * could look. The entries hold nothing but cancelled timers, and they go when
   * this object does.
   */
  public dispose(): void {
    this._subscription.dispose();
    for (const pending of this._waiting.values()) {
      pending.timer?.dispose();
    }
  }

  /**
   * One record: adopt it, start it, and begin waiting for it to say something.
   *
   * The failure after a successful adoption is the awkward one, and it is named
   * rather than hidden: the record is ours from that moment and there is no way
   * to give it back -- ownership moves to a LIVE window by compare-and-swap, and
   * "hand it back to a window that is dead" is not an operation this store has.
   * So it is registered anyway. A record owned by this window and held by nobody
   * would be filtered out of the projection as ours and out of the list as
   * unheld, which is a row that disappears from every window on the machine
   * until this one closes; registered, it is simply a row whose terminal is not
   * running, which is a thing the tree can already draw and a person can already
   * delete. Named in §8.2, because it stays that way until the window closes.
   */
  private async _restore(step: RestoreStep): Promise<RestoreAttempt> {
    const { entry } = step;
    const named = { terminalId: entry.terminalId, displayName: entry.metadata.displayName };

    let adopted: TerminalEntry;
    try {
      adopted = await this._options.repository.adopt(entry.terminalId, step.expectedRevision, {
        // Only ever true for a step a person asked for by name (M2.14). The
        // store refuses a LIVE owner whatever this says, so what the flag buys
        // is exactly one case: a window that is there and silent, which a
        // person has looked at and found gone.
        force: step.force,
      });
    } catch (cause: unknown) {
      // Ordinary, not a fault: between the plan and this line another window may
      // have adopted the same record, or a person may have deleted it. Both are
      // exactly what the compare-and-swap is for, and both mean the same thing
      // here -- not ours to start.
      this._options.logger.info('a record was not restored, because it moved while the plan was being carried out', {
        terminalId: entry.terminalId.value,
        expectedRevision: step.expectedRevision,
        reason: String(cause),
      });
      return { ...named, outcome: 'contested', reason: String(cause) };
    }

    // Marked as waiting BEFORE the start rather than after it, so that there is
    // no instant in which the terminal exists, has been registered, and is not
    // being waited for.
    this._waiting.set(entry.terminalId.value, { timer: null });
    try {
      await this._options.lifecycle.start(adopted, 'resume', 'hidden');
    } catch (cause: unknown) {
      this._forget(entry.terminalId);
      this._options.registry.register(adopted);
      this._options.logger.error('a record was adopted and its terminal could not be started', {
        terminalId: entry.terminalId.value,
        reason: String(cause),
      });
      return { ...named, outcome: 'unstartable', reason: String(cause) };
    }

    this._arm(entry.terminalId);
    return { ...named, outcome: 'started', reason: null };
  }

  /**
   * Counts rather than a line apiece.
   *
   * A machine with several projects open produces a `foreign-folder` refusal for
   * every terminal of every other project, and a log that says the same sentence
   * forty times is a log nobody reads to the end. The per-record detail is in
   * the report, where M2.14 reads it in order to offer the explicit adoption
   * these refusals point at.
   */
  private _reportRefusals(skipped: readonly RestoreSkip[]): void {
    if (skipped.length === 0) {
      return;
    }
    const counts: Record<string, number> = {};
    for (const skip of skipped) {
      counts[skip.reason] = (counts[skip.reason] ?? 0) + 1;
    }
    this._options.logger.info('records this window did not bring back, by reason', counts);
  }

  private _arm(terminalId: TerminalId): void {
    const pending = this._waiting.get(terminalId.value);
    if (pending === undefined) {
      // Settled while the process was being started. Nothing to wait for, and
      // arming now would produce a timeout for a terminal that has answered.
      return;
    }
    pending.timer = this._options.scheduler.after(
      this._options.resumeTimeoutMs ?? DEFAULT_RESUME_TIMEOUT_MS,
      () => {
        this._onSilent(terminalId);
      }
    );
  }

  private _onChange(change: RegistryChange): void {
    if (change.kind !== 'entry' || change.transition === null) {
      // A registration or an amendment says nothing about the process: the
      // registration is OURS, made a moment ago by the start itself. What ends
      // the wait is an event that reached the record, whatever the state machine
      // then made of it -- the question is whether the channel exists.
      return;
    }
    const { entry } = change;
    if (!this._forget(entry.terminalId)) {
      return;
    }

    if (isWitnessedEnd(entry.observed.state)) {
      // The restore is over and there is nothing to reveal -- the pane went with
      // the process. `resume_failed` is the case M2.13 turns into an offer to
      // start the conversation over; `ended` is a person closing the terminal
      // before it answered.
      this._options.logger.info('a restored terminal ended before it said anything', {
        terminalId: entry.terminalId.value,
        state: entry.observed.state,
      });
      return;
    }
    this._options.lifecycle.reveal(entry.terminalId);
  }

  /**
   * The wait ran out.
   *
   * `ResumeTimedOut` is an inference and the state machine treats it as the
   * weakest kind of knowledge: it applies only from `launching`, so an event
   * that arrived and moved the record has already answered the question this
   * timer was asking. The record is dropped from the map BEFORE the event is
   * ingested, or the change that event produces would arrive back at
   * `_onChange` as if a process had reported in.
   *
   * There is deliberately no "was it still waiting" guard here. Getting this far
   * IS the answer: `Scheduler` promises that a disposed call does not happen,
   * and every path that settles a restore disposes its timer. A guard would be a
   * branch no test could reach, which is the kind of rule that quietly stops
   * being true.
   */
  private _onSilent(terminalId: TerminalId): void {
    this._forget(terminalId);
    this._options.logger.warn('a restored terminal has not said anything, so its row no longer claims to know what it is doing', {
      terminalId: terminalId.value,
      waitedMs: this._options.resumeTimeoutMs ?? DEFAULT_RESUME_TIMEOUT_MS,
    });
    this._options.registry.ingest(terminalId, resumeTimedOut());
    // Revealed all the same. A `claude` that is running with no pane and no row
    // anybody was told about is the silent failure this extension exists to
    // remove; the process is left alone, because nothing here establishes that
    // there is anything wrong with it.
    this._options.lifecycle.reveal(terminalId);
  }

  /** Takes a restore out of the wait, cancelling its timer. False when it was not waiting. */
  private _forget(terminalId: TerminalId): boolean {
    const pending = this._waiting.get(terminalId.value);
    if (pending === undefined) {
      return false;
    }
    pending.timer?.dispose();
    this._waiting.delete(terminalId.value);
    return true;
  }
}
