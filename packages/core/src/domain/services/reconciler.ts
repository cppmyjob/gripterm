import { confirmOrphans, orphanCandidates } from './orphan-processes';
import { isWitnessedEnd } from './terminal-state-machine';
import { precedesBoot } from './boot-window';
import { processGone, wentQuiet } from '../events/terminal-event';
import type { AgentListing } from '../entities/agent-record';
import type { OrphanCandidate, OrphanEvidence } from './orphan-processes';
import type { Clock } from '../ports/clock';
import type { Disposable } from '../ports/disposable';
import type { Logger } from '../ports/logger';
import type { OwnerId } from '../entities/owner-id';
import type { OwnerLiveness, OwnerPresence, OwnerSurvey } from '../ports/owner-presence';
import type { Scheduler } from '../ports/scheduler';
import type { SessionRegistry } from './session-registry';
import type { TerminalEntry } from '../entities/terminal-entry';
import type { TerminalId } from '../entities/terminal-id';
import type { TerminalRepository } from '../repositories/terminal-repository';

/**
 * How often the machine is looked at. [П]
 *
 * The sweep exists for what hooks cannot report by construction -- a `claude`
 * killed with -9, an editor that crashed, a window that never got to say
 * goodbye. Those are rare and the cost of noticing one late is low, which is the
 * whole argument for a number this large. It is named rather than measured, so
 * that it can be argued with instead of looking established.
 */
export const DEFAULT_RECONCILE_INTERVAL_MS = 30_000;

/**
 * How long a record may go on saying `working` with nothing arriving. [П]
 *
 * There is no measurement behind this number, and there cannot be one: it is a
 * bet about how long a turn stays silent, and both sides of the bet are real. A
 * turn that is running produces no hook between `PreToolUse` and `PostToolUse`,
 * so a build that takes longer than this will be drawn `state unknown` while it
 * works -- and then drawn `working` again by the very next event. That is the
 * cost, and it is the smaller one: the other direction is a row that says work
 * is happening after the person stopped it, which is П1's question answered
 * wrongly in the direction where nobody looks (A50, measured 2026-08-20).
 *
 * Three minutes rather than one because the granularity is the sweep -- thirty
 * seconds -- and rather than ten because a person who interrupted a turn is
 * still at that window.
 */
export const DEFAULT_QUIET_AFTER_MS = 180_000;

/**
 * How long a process we ended is given to stop answering, and how often it is
 * asked. [П]
 *
 * The wait exists because `TerminateProcess` is asynchronous while both gates of
 * the restore read the machine immediately afterwards -- `deadPids` by signal 0
 * (`gatherRestoreInputs`) and `session-listed` by the CLI's own listing. Without
 * it, whether a window brings its terminals back would depend on which of two
 * things the operating system finished first.
 *
 * Measured 2026-08-17 (A43) on this machine: a `claude` sent `SIGKILL` stopped
 * answering signal 0 in **1 ms**. Two seconds is therefore a ceiling for a
 * machine under load rather than an expectation, and it is a ceiling rather than
 * a promise: a process still answering when it runs out is reported, not waited
 * for again.
 */
const PROCESS_END_STEP_MS = 50;
const PROCESS_END_ATTEMPTS = 40;

/** What one sweep found. Everything in it is a thing that changed, not a total. */
export interface ReconcileReport {
  /** `TerminalId.value` of the records that moved to `orphaned` in this sweep. */
  readonly orphaned: readonly string[];
  /** The windows whose presence files were taken out of `owners/`. */
  readonly collected: readonly string[];
  /** Conversations the CLI is running that no record on this machine names. */
  readonly unknownSessions: readonly string[];
  /** `TerminalId.value` of the records that stopped claiming work in this sweep. */
  readonly quieted: readonly string[];
}

const NOTHING_FOUND: ReconcileReport = Object.freeze({
  orphaned: Object.freeze([]),
  collected: Object.freeze([]),
  unknownSessions: Object.freeze([]),
  quieted: Object.freeze([]),
});

/** What the pass over other windows' leftovers ended, and what it would not. */
export interface OrphanEndReport {
  /** `TerminalId.value` of the records that have no process any more. */
  readonly ended: readonly string[];
  /** Pids that were signalled and were still answering when the patience ran out. */
  readonly survived: readonly number[];
  /** `TerminalId.value` of records naming a process the machine would not vouch for. */
  readonly unconfirmed: readonly string[];
}

const NOTHING_ENDED: OrphanEndReport = Object.freeze({
  ended: Object.freeze([]),
  survived: Object.freeze([]),
  unconfirmed: Object.freeze([]),
});

/** The liveness of the windows on this machine moved. Redraw. */
export type ReconcileListener = () => void;

export interface ReconcilerOptions {
  /**
   * The base, read from the MEDIUM rather than from this window's projection.
   *
   * The difference decides whether a presence file may be collected -- the
   * guard is "no record names this owner" -- and a projection that has not
   * caught up with another window's write would answer that with a record it
   * has not seen yet.
   */
  readonly repository: TerminalRepository;
  readonly registry: SessionRegistry;
  readonly presence: OwnerPresence;
  /** This window. Answered `live` without asking, and never collected. */
  readonly self: OwnerId;
  /** What the CLI says is running. An unavailable answer is normal, not a fault. */
  readonly readAgents: () => Promise<AgentListing>;
  /**
   * Whether a process answers to that pid.
   *
   * A function and not a probe, because the rule it stands for is measured and
   * lives in one place (§4.8, `isProcessThere`): `EPERM` means the process is
   * THERE and belongs to somebody else, and a second reading of that table
   * would disagree with the first exactly where nobody looks.
   */
  readonly isRunning: (pid: number) => boolean;
  /**
   * Whether THIS window still holds a terminal for that record.
   *
   * First-hand evidence, and it outranks the pid -- see `_lostItsProcess`.
   * Optional because a window with no gateway of its own (a test stand) has
   * nothing to ask, and `false` is then the honest answer rather than a
   * pretence.
   */
  readonly holdsTerminal?: (terminalId: TerminalId) => boolean;
  /**
   * Ends a process by pid, or throws the way `process.kill` does.
   *
   * Separate from `isRunning` and named for the act rather than for the shape:
   * these two have the same signature and opposite consequences, and the whole
   * of `endOrphanedProcesses` stands between them.
   */
  readonly endProcess: (pid: number) => void;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  readonly logger: Logger;
  readonly intervalMs?: number;
  /** Overrides `DEFAULT_QUIET_AFTER_MS`. Exists for the tests and for an argument. */
  readonly quietAfterMs?: number;
  /**
   * `os.uptime()`, for the boot rule.
   *
   * Required rather than defaulted, and that is not ceremony. Every plausible
   * default is a wrong answer in the dangerous direction -- zero seconds puts
   * the boot at this instant, which makes EVERY record predate it and every
   * terminal on the machine orphaned while they run. A term of an arithmetic
   * rule is stated by the caller or the rule does not run.
   */
  readonly uptimeSeconds: () => number;
}

/**
 * The sweep that notices what no hook can report.
 *
 * Three jobs, and they are here together because they are three readings of one
 * pass over the same two directories: who is still out there, whose process is
 * gone, and what is left behind by windows that are not.
 *
 * TWO OF THEM CAN DO HARM, and the harm is the one the whole of M2 is written
 * against, so both are written to fail towards doing nothing:
 *
 *   * calling a live process gone marks a working conversation `orphaned`,
 *     which is a row inviting a person to start it over -- a second
 *     `claude --resume` on a live transcript (O3). So `orphaned` needs
 *     ESTABLISHED death: a pid we were told (A16) that answers nothing, or a
 *     record last heard from before the machine booted. "We were never told a
 *     pid" is not evidence of anything and never moves a record.
 *   * removing an UNREADABLE presence file turns its window's liveness from
 *     `unknown` into `dead` -- and `dead` is what authorises adoption. Presence
 *     files are written atomically, so "unreadable" is never a half-written
 *     one; what it really means is corrupt on disk, or **written by a build
 *     whose schema this one does not know** -- and that second file belongs to
 *     a window that is very much alive, running a newer Gripterm next door. So
 *     a file is collected only once no record on the machine names its window,
 *     which is when the answer can no longer authorise anything.
 *
 * The third has the opposite asymmetry and is written the other way: a window
 * wrongly called dead is drawn `detached`, which is cosmetic, while one wrongly
 * called live is a row that lies. So the map answers `unknown` for everything it
 * has not established -- and `live` about THIS window without asking, because
 * this window is the process asking, and after the machine wakes from sleep its
 * own heartbeat is minutes old while its terminals run in front of a person.
 *
 * `detached` is never written anywhere. It is the presenter's overlay on this
 * map (§4.3), which is what makes the way back free: a heartbeat that comes back
 * simply stops the overlay applying.
 */
/**
 * Whether a record has lost its process, and WHICH RULE said so.
 *
 * A pair rather than a boolean, because the boolean was the whole defect: six
 * ways out of one rule, one line in the log, and no way afterwards to tell
 * which of them ran. This is the only rule in the build that stamps a record
 * `orphaned`.
 */
interface OrphanVerdict {
  readonly gone: boolean;
  readonly rule: string;
}

export class Reconciler implements Disposable {
  private readonly _options: ReconcilerOptions;
  private readonly _listeners = new Set<ReconcileListener>();
  private _liveness: ReadonlyMap<string, OwnerLiveness>;
  /** Conversations already mentioned, so that a log line is news rather than noise. */
  private _mentioned: ReadonlySet<string> = new Set();
  /** The last "left alone" rule said per record, so a steady state is not said twice. See `_sayItWasSpared`. */
  private readonly _spared = new Map<string, string>();
  /**
   * Whether `owners/` has been READ, which is what makes an absence mean
   * anything (see `livenessOf`). Distinct from `_sweptAtMs`, which is stamped
   * before the reading and stays stamped when it fails.
   */
  private _surveyed = false;
  /** When the last pass began. `null` until one has. */
  private _sweptAtMs: number | null = null;
  private _timer: Disposable | null = null;
  /** True once `start` has been answered, which is not the same as having a timer. */
  private _started = false;
  private _disposed = false;

  constructor(options: ReconcilerOptions) {
    this._options = options;
    // This window is live from the first moment, before anything has been
    // swept: its own terminals are on screen, and a map that started out empty
    // would draw every one of them `detached` until the first sweep landed.
    this._liveness = new Map([[options.self.value, 'live']]);
  }

  /**
   * Begins the sweep, with a pass RIGHT NOW. A second call does nothing.
   *
   * **The customer, 2026-08-22:** "само окно Claude Code Terminals загружает
   * данные после открытия приложения очень долго — до минуты", and, in the same
   * breath, a row that goes on calling itself active for about as long.
   *
   * This is where both of those were. A window that has just started draws
   * every record in the state it was PERSISTED in -- a conversation that was
   * running when the window closed is written down as running -- and the only
   * thing that ever says otherwise is a pass of this sweep. It used to arm the
   * timer and wait out the whole interval before the first one, thirty seconds
   * by default, and a first pass that could not read the machine put it at
   * sixty. Neither of the two out-of-turn triggers helps at start: the window
   * already has focus when an extension activates, so no focus event comes.
   *
   * So the first pass is not waited for. The timer is armed after it, as after
   * any other, which keeps the interval an interval BETWEEN passes rather than
   * a schedule the first one has to keep.
   */
  public start(): void {
    if (this._started) {
      return;
    }
    this._started = true;
    void this._begin();
  }

  /**
   * One pass, and the only method that changes anything.
   *
   * Also called out of turn -- when the window takes focus (§6) -- because that
   * is the moment a person is about to read the list.
   *
   * An input that could not be read stops the whole pass rather than half of
   * it. There is one rule and not three: every decision below is about what is
   * NOT there any more, and a directory that did not answer has not said
   * anything is missing.
   */
  public async sweep(): Promise<ReconcileReport> {
    // Stamped before the work and not after it, so that a pass which found
    // nothing readable still counts as a pass: a machine whose store has gone
    // would otherwise be swept again by every one of the events below.
    this._sweptAtMs = this._options.clock.now().getTime();
    const looked = await this._look();
    if (looked === null) {
      return NOTHING_FOUND;
    }

    const { entries, survey, agents } = looked;
    const moved = this._remember(survey);
    const listed = agents.kind === 'listed'
      ? new Set(agents.agents.map((agent) => agent.sessionId.value))
      : null;

    const report: ReconcileReport = {
      orphaned: this._orphans(listed),
      collected: await this._collect(survey, entries),
      unknownSessions: this._strangers(entries, listed),
      // After `_orphans`, and the order is the rule: a record that has lost its
      // process is no longer `working`, so it never reaches this pass. The
      // established fact wins over the inferred one by arriving first.
      quieted: this._quiet(),
    };
    if (moved) {
      this._notify();
    }
    return report;
  }

  /**
   * A pass asked for out of turn, run only if the last one is old enough.
   *
   * The two callers are the moments something is about to be READ: the window
   * taking focus, and the base changing under another window's hand (§6, §4.8).
   * Both are things a person causes dozens of times a minute, and every pass
   * spawns `claude agents --json` -- 0.56-0.70 s, measured (A24). So the floor
   * is not tuning but the whole point of having a separate entry: without it,
   * alt-tab is a process spawner.
   *
   * The floor is the sweep interval itself rather than a second number. One
   * cadence, argued about in one place.
   */
  public async sweepIfStale(): Promise<ReconcileReport> {
    const sweptAtMs = this._sweptAtMs;
    const interval = this._options.intervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
    if (sweptAtMs !== null && this._options.clock.now().getTime() - sweptAtMs < interval) {
      return NOTHING_FOUND;
    }
    return await this.sweep();
  }

  /**
   * Ends the processes left behind by windows that are gone (M3.5, O4).
   *
   * **Its own pass, and not an extension of `_orphans`.** That one walks
   * `registry.own()` -- the records of THIS window -- and an orphan is by
   * definition somebody else's. This one reads the base whole.
   *
   * **It runs before the machine is surveyed for a restore, not merely before
   * the restore.** `deadPids` is gathered once, and a process ended after that
   * gathering does not change the answer `livenessRule` gives in the same
   * activation: the records of the window that died would be refused while their
   * processes were already gone. That is why the wait below exists as well --
   * `TerminateProcess` is asynchronous, and both gates of the restore read the
   * machine straight after this returns.
   *
   * **Called once, at activation, and deliberately not from the sweep.** The
   * periodic pass would close a real gap -- a window that dies while this one is
   * open leaves its process until somebody's next activation -- at the price of
   * running the one irreversible rule in this build every thirty seconds in
   * every open window. The owner chose the narrow door (2026-08-17); the gap is
   * named in the plan's register rather than left to be discovered.
   *
   * Every failure changes nothing, like every other pass here: a machine that
   * could not be read has not said that anything is missing.
   */
  public async endOrphanedProcesses(): Promise<OrphanEndReport> {
    const evidence = await this._lookForOrphans();
    if (evidence === null) {
      return NOTHING_ENDED;
    }

    const candidates = orphanCandidates(evidence);
    if (candidates.length === 0) {
      // The ordinary machine, where no window has died: the CLI is never asked,
      // and the whole pass costs one directory read that the activation was
      // going to do anyway. Asking would cost 0.56-0.70 s (A24) at the moment a
      // person is waiting for their list.
      return NOTHING_ENDED;
    }

    const { confirmed, unconfirmed } = confirmOrphans(candidates, await this._options.readAgents());
    for (const candidate of unconfirmed) {
      this._options.logger.info(
        'a record names a process of ours that the machine could not be confirmed to be running, so nothing was ended',
        this._describe(candidate)
      );
    }

    const ended: string[] = [];
    const survived: number[] = [];
    for (const candidate of confirmed) {
      if (await this._end(candidate)) {
        ended.push(candidate.entry.terminalId.value);
      } else {
        survived.push(candidate.pid);
      }
    }
    return { ended, survived, unconfirmed: unconfirmed.map((one) => one.entry.terminalId.value) };
  }

  /** The whole map, in the shape the restore planner takes it (M2.10). */
  public liveness(): ReadonlyMap<string, OwnerLiveness> {
    return this._liveness;
  }

  /**
   * One window's liveness, with the two ways of not being in the map told
   * apart.
   *
   * The default is the rule rather than a fallback, and until M2.20 it was one
   * rule where there are two. A window this reconciler has never surveyed is
   * `unknown` -- nothing has been established, and `live` here would be a row
   * claiming a terminal is running in a window that closed an hour ago. A window
   * missing from a directory it HAS read is `dead`, because that directory is
   * the answer: `owners/<id>.json` is removed by `retire()` and by the collector
   * below, and by nothing else.
   *
   * **The second half is not a new rule, it is the store's own.**
   * `FileOwnerPresence.livenessOf` has always read an absent file as `dead`, and
   * the restore predicate has always been built on that. This map is built by
   * ENUMERATING files, so a window with no file never appears in it at all --
   * and the single default answered the opposite of what the store would say.
   * The owner met the difference on 2026-08-13 with an empty `owners/`: their
   * closed record was `closed` to every predicate and "window not answering" on
   * every row, which is `CONTEXT_FOREIGN` -- a row with no menu entries at all.
   *
   * A sweep that could not read the directory establishes nothing and does not
   * arm the second half, which is the same rule the rest of the pass follows: an
   * input that could not be read has not said anything is missing.
   */
  public livenessOf(ownerId: OwnerId): OwnerLiveness {
    const known = this._liveness.get(ownerId.value);
    if (known !== undefined) {
      return known;
    }
    return this._surveyed ? 'dead' : 'unknown';
  }

  public subscribe(listener: ReconcileListener): Disposable {
    this._listeners.add(listener);
    return {
      dispose: (): void => {
        this._listeners.delete(listener);
      },
    };
  }

  /**
   * Stops the sweep, and nothing else.
   *
   * The listeners are deliberately left alone. Nothing notifies them once the
   * timer is gone, so clearing them would be the same rule held twice -- and
   * the second copy is what hides the first one failing (M2.11's mutation run
   * found exactly that).
   */
  public dispose(): void {
    this._disposed = true;
    this._timer?.dispose();
    this._timer = null;
  }

  private _arm(): void {
    if (this._disposed) {
      return;
    }
    const interval = this._options.intervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
    this._timer = this._options.scheduler.after(interval, () => {
      void this._tick();
    });
  }

  /**
   * The first pass, which the caller may already have made.
   *
   * Through the floor and not through `sweep()`, and that is the whole
   * difference from every tick after it: the composition root awaits one pass
   * before it starts the timer -- it has to, because what follows depends on
   * it -- and until Ш11 `start()` immediately made a second one. Two passes
   * about the same instant, each spawning `claude agents --json` at
   * 0.56-0.70 s (A24), on the path a person is waiting on.
   *
   * The ticks after this one are NOT gated, and need not be: the floor is the
   * interval itself, so a tick that has waited out the interval is stale by
   * definition.
   */
  private async _begin(): Promise<void> {
    try {
      await this.sweepIfStale();
    } finally {
      this._arm();
    }
  }

  private async _tick(): Promise<void> {
    try {
      await this.sweep();
    } finally {
      // In `finally`, because a sweep that failed is exactly the state in which
      // stopping to sweep is worst: nothing else on this machine would ever
      // notice the window that went away.
      this._arm();
    }
  }

  /**
   * Everything one pass needs, or `null` when the world could not be read.
   *
   * Asked in one place so that the failure has one answer. The CLI is the
   * exception and answers with a value: a machine with no `claude` on PATH is
   * ordinary, and a sweep that gave up over it would leave that machine without
   * liveness or collection for ever.
   */
  private async _look(): Promise<Looked | null> {
    try {
      return {
        entries: await this._options.repository.readAll(),
        survey: await this._options.presence.survey(),
        agents: await this._options.readAgents(),
      };
    } catch (cause: unknown) {
      this._options.logger.warn('a reconciliation pass could not read the machine, so it changed nothing', {
        cause,
      });
      return null;
    }
  }

  /**
   * The base and the owners, in the shape the ending rule reads them.
   *
   * The liveness it builds is NOT kept. `_liveness` is the map the list is drawn
   * from, and filling it here would have this window answering `dead` about
   * other windows before it has drawn anything -- a change to what M2 shows,
   * made by a pass that exists to end processes. The map here is a means to one
   * decision and ends with it.
   */
  private async _lookForOrphans(): Promise<OrphanEvidence | null> {
    try {
      const entries = await this._options.repository.readAll();
      const ownerLiveness = new Map<string, OwnerLiveness>();
      for (const row of await this._options.presence.survey()) {
        ownerLiveness.set(row.name, row.liveness);
      }
      // Last and unconditionally, as in `_remember`: this window is the process
      // asking, and its own records must never be candidates.
      ownerLiveness.set(this._options.self.value, 'live');
      return {
        entries,
        ownerLiveness,
        // Both terms of the boot rule from one instant.
        nowMs: this._options.clock.now().getTime(),
        uptimeSeconds: this._options.uptimeSeconds(),
      };
    } catch (cause: unknown) {
      this._options.logger.warn(
        'the machine could not be read, so no process of a window that is gone was ended',
        { cause }
      );
      return null;
    }
  }

  /** Ends one process and waits for the machine to agree that it is gone. */
  private async _end(candidate: OrphanCandidate): Promise<boolean> {
    // At `warn` rather than at `info`, and it is the only line in this build that
    // earns it for something that is not a fault: this is the one act nothing
    // takes back, so it has to survive whatever a person filters their log by.
    this._options.logger.warn(
      'a process left running by a window that is gone is being ended',
      this._describe(candidate)
    );
    try {
      this._options.endProcess(candidate.pid);
    } catch (cause: unknown) {
      // Ordinary rather than exceptional: between the CLI's answer and this call
      // the process may simply have finished. The wait below is what decides.
      this._options.logger.info('a process being ended did not take the signal', {
        pid: candidate.pid,
        cause,
      });
    }

    // One question per turn and no second copy of it after the loop: the machine
    // is asked, and only then is the patience spent. A trailing re-check would
    // be the same question asked in a place no test reaches.
    for (let attempt = 0; ; attempt += 1) {
      if (!this._options.isRunning(candidate.pid)) {
        return true;
      }
      if (attempt >= PROCESS_END_ATTEMPTS) {
        break;
      }
      await this._pause(PROCESS_END_STEP_MS);
    }
    this._options.logger.warn(
      'a process this window ended did not stop within the time it is given, so a restore of that record will be refused',
      this._describe(candidate)
    );
    return false;
  }

  private async _pause(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      this._options.scheduler.after(ms, () => {
        resolve();
      });
    });
  }

  private _describe(candidate: OrphanCandidate): Record<string, string | number> {
    return {
      terminalId: candidate.entry.terminalId.value,
      pid: candidate.pid,
      // The conversation, because after this the record is the only thing that
      // names it and `claude --resume <id>` is what reaches it.
      sessionId: candidate.entry.sessionId.value,
      owner: candidate.entry.owner.ownerId.value,
    };
  }

  /** Replaces the map, and says whether anything in it moved. */
  private _remember(survey: readonly OwnerSurvey[]): boolean {
    const next = new Map<string, OwnerLiveness>();
    for (const row of survey) {
      next.set(row.name, row.liveness);
    }
    // Last, so that it wins over whatever this window's own file happens to say
    // -- which after a machine wakes is a heartbeat minutes old.
    next.set(this._options.self.value, 'live');

    const previous = this._liveness;
    this._liveness = next;
    // Here and nowhere else: this method runs only on a pass that read the
    // directory, so the flag cannot be set by one that failed.
    this._surveyed = true;
    return !sameMap(previous, next);
  }

  /**
   * The records of this window whose process is established gone.
   *
   * This window's own records only. Another window's record is written by that
   * window and by nobody else (§4.8), and a dead owner's rows already say what
   * there is to say through the map above -- without writing into a file this
   * window has no right to.
   */
  private _orphans(listed: ReadonlySet<string> | null): readonly string[] {
    const nowMs = this._options.clock.now().getTime();
    const uptimeSeconds = this._options.uptimeSeconds();
    const gone: string[] = [];

    for (const entry of this._options.registry.own()) {
      const verdict = this._lostItsProcess(entry, listed, nowMs, uptimeSeconds);
      if (!verdict.gone) {
        this._sayItWasSpared(entry, verdict.rule);
        continue;
      }
      // Always accepted and always a move: the record came out of `own()`, and
      // the states in which the machine would refuse this event are the ones
      // `_lostItsProcess` has just excluded.
      this._options.registry.ingest(entry.terminalId, processGone(entry.observed.pid));
      gone.push(entry.terminalId.value);
      this._options.logger.info('a terminal was found without its process', {
        terminalId: entry.terminalId.value,
        pid: entry.observed.pid,
        // WHICH of the two rules decided it (Ш3). "The pid answered nothing" and
        // "this was last heard from before the machine booted, so its pid means
        // nothing at all" are entirely different findings, and until this field
        // existed they reached a support log looking identical -- on the only
        // rule in this build that stamps a record `orphaned`.
        rule: verdict.rule,
      });
    }
    return gone;
  }

  /**
   * Whether the conversation in that record has certainly stopped.
   *
   * The order is the design. A record already known to be over is left alone --
   * stamping it again every thirty seconds would move `lastEventAt`, which
   * means "when we last heard from the CLI", to a moment nothing was heard.
   * Then the CLI's own list, which can only ever hold a record back: it filters
   * by process liveness itself (A24), so a conversation it names is running
   * whatever a stale pid of ours says. Then the boot rule, which outranks the
   * pid because after a restart every stored pid is a number from a previous
   * life that a stranger may hold today. Then the pid itself.
   */
  private _lostItsProcess(
    entry: TerminalEntry,
    listed: ReadonlySet<string> | null,
    nowMs: number,
    uptimeSeconds: number
  ): OrphanVerdict {
    const { observed } = entry;
    if (observed.state === 'orphaned' || isWitnessedEnd(observed.state)) {
      return { gone: false, rule: 'its conversation is already known to be over' };
    }
    if (listed !== null && entry.claimsAnyOf(listed)) {
      return { gone: false, rule: 'the CLI names its conversation among the ones it is running' };
    }
    /*
     * The window's own hand, and it outranks every inference below.
     *
     * **The customer's log, 2026-08-22, ten seconds apart:**
     *
     *   a terminal was found without its process {"pid":32496}
     *   a terminal could not be resumed
     *   {"cause":"ConflictError: this terminal is already running"}
     *
     * The sweep had just called that record orphaned while the window was
     * still holding a terminal for it. The pid is second-hand -- it is what
     * `Terminal.processId` said when the terminal was made, which on Windows
     * is the process the editor STARTED, and an installer whose executable
     * launches something else and exits leaves us holding a number that dies
     * while the conversation goes on. The terminal object is first-hand: the
     * editor has one or it has not.
     *
     * What this costs, said rather than discovered: an agent that dies inside
     * a tab the person leaves open keeps its last state until that tab closes.
     * The editor tells us the moment it does -- measured 2026-08-22 in Cursor,
     * `onDidCloseTerminal` fires with an exit status -- and that is a better
     * trade than calling a running conversation dead.
     */
    if (this._options.holdsTerminal?.(entry.terminalId) === true) {
      if (observed.pid !== null && !this._options.isRunning(observed.pid)) {
        this._options.logger.warn('a record kept its terminal although the pid it carries is gone', {
          terminalId: entry.terminalId.value,
          pid: observed.pid,
          state: observed.state,
        });
      }
      return { gone: false, rule: 'this window is still holding its terminal' };
    }
    if (precedesBoot(observed.lastEventAt.getTime(), nowMs, uptimeSeconds)) {
      return { gone: true, rule: 'it was last heard from before this machine booted' };
    }
    if (observed.pid === null) {
      // A machine with no `node` on PATH has no `SessionStart` forwarder and so
      // no pid on any record (H1). Reading "we were never told" as "the process
      // is gone" would mark every terminal on such a machine dead while they run.
      return { gone: false, rule: 'no pid was ever recorded for it, and never being told is not evidence' };
    }
    return this._options.isRunning(observed.pid)
      ? { gone: false, rule: 'the pid it carries is answering' }
      : { gone: true, rule: 'nothing answers for the pid it carries' };
  }

  /**
   * Why a record was LEFT ALONE, said once per record per change of rule (Ш3).
   *
   * The sweep runs every thirty seconds over every record this window owns, so a
   * line per record per pass would be a log made of one repeated sentence -- and
   * the moment worth reading is the moment the answer moved. `_strangers` in
   * this class already keeps that shape, for the same reason.
   *
   * It matters because the five ways this rule says "no" are five different
   * facts about somebody's conversation, and a person reading a log could not
   * tell any of them from the sweep never having looked at that record at all.
   */
  private _sayItWasSpared(entry: TerminalEntry, rule: string): void {
    const said = this._spared.get(entry.terminalId.value);
    if (said === rule) {
      return;
    }
    this._spared.set(entry.terminalId.value, rule);
    this._options.logger.info('a terminal kept its process, as far as this window can tell', {
      terminalId: entry.terminalId.value,
      pid: entry.observed.pid,
      state: entry.observed.state,
      rule,
    });
  }

  /**
   * Records that still claim to be working while nothing has been heard.
   *
   * `registry.own()` and not the whole base: this is an inference, and inferring
   * about another window's record would overwrite what that window observes
   * first-hand. It is also why nothing here probes or spawns anything -- the
   * whole rule is a subtraction of two numbers the record already carries.
   */
  private _quiet(): readonly string[] {
    const nowMs = this._options.clock.now().getTime();
    const patienceMs = this._options.quietAfterMs ?? DEFAULT_QUIET_AFTER_MS;
    const quieted: string[] = [];

    for (const entry of this._options.registry.own()) {
      if (entry.observed.state !== 'working') {
        continue;
      }
      const silentMs = nowMs - entry.observed.lastEventAt.getTime();
      if (silentMs < patienceMs) {
        continue;
      }
      this._options.registry.ingest(entry.terminalId, wentQuiet());
      quieted.push(entry.terminalId.value);
      this._options.logger.info('a terminal that claimed to be working has gone quiet', {
        terminalId: entry.terminalId.value,
        silentMs,
      });
    }
    return quieted;
  }

  /** Presence files nothing can establish anything about, and nothing points at. */
  private async _collect(
    survey: readonly OwnerSurvey[],
    entries: readonly TerminalEntry[]
  ): Promise<readonly string[]> {
    const named = new Set(entries.map((entry) => entry.owner.ownerId.value));
    const collected: string[] = [];

    for (const row of survey) {
      if (!this._collectable(row, named)) {
        continue;
      }
      try {
        await this._options.presence.collect(row.fileName);
        collected.push(row.name);
      } catch (cause: unknown) {
        // Rubbish left behind is a slowly filling directory; a sweep that gave
        // up over one locked file is a machine nobody sweeps.
        this._options.logger.warn('a presence file could not be collected', {
          fileName: row.fileName,
          cause,
        });
      }
    }
    return collected;
  }

  private _collectable(row: OwnerSurvey, named: ReadonlySet<string>): boolean {
    if (row.name === this._options.self.value) {
      return false;
    }
    if (named.has(row.name)) {
      return false;
    }
    // A file that did not decode answers `unknown` for ever, by design: nothing
    // can be established from a file nobody can read, and `unknown` is the
    // answer that refuses. So it is the one kind of rubbish nothing else on this
    // machine would ever take away -- and the guard above is what makes taking
    // it away safe, because the file may belong to a live window running a
    // build this one cannot read.
    return row.identity === null || row.liveness === 'dead';
  }

  /**
   * Conversations the CLI is running that no record on this machine names.
   *
   * Reported and nothing else. Writing a record for one would mean putting an
   * id nobody handed us into a record -- which is the adoption of an unknown
   * `session_id` that A23 is open about, and doing it unmeasured is a
   * `--resume` on a conversation a person did not open. What it is FOR is the
   * plain one: a person who wonders why Gripterm shows three terminals while
   * `claude` says four can find out that the fourth was started elsewhere.
   */
  private _strangers(
    entries: readonly TerminalEntry[],
    listed: ReadonlySet<string> | null
  ): readonly string[] {
    if (listed === null) {
      // Not asked is not "nothing is running". Forgetting what was mentioned
      // is what makes the same conversation news again when the CLI comes back.
      this._mentioned = new Set();
      return [];
    }

    const ours = new Set<string>();
    for (const entry of entries) {
      ours.add(entry.sessionId.value);
      for (const past of entry.sessionIdHistory) {
        ours.add(past.value);
      }
    }

    const strangers = [...listed].filter((sessionId) => !ours.has(sessionId));
    for (const sessionId of strangers) {
      if (this._mentioned.has(sessionId)) {
        continue;
      }
      // Once each. A line every thirty seconds for the life of the window is a
      // trace nobody reads, and one nobody reads buries the ones that mean
      // something (§II.6).
      this._options.logger.info('a conversation is running that no record on this machine names', {
        sessionId,
      });
    }
    this._mentioned = new Set(strangers);
    return strangers;
  }

  private _notify(): void {
    for (const listener of [...this._listeners]) {
      listener();
    }
  }
}

interface Looked {
  readonly entries: readonly TerminalEntry[];
  readonly survey: readonly OwnerSurvey[];
  readonly agents: AgentListing;
}

function sameMap(
  left: ReadonlyMap<string, OwnerLiveness>,
  right: ReadonlyMap<string, OwnerLiveness>
): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [key, value] of left) {
    if (right.get(key) !== value) {
      return false;
    }
  }
  return true;
}
