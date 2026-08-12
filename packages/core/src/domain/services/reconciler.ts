import { isWitnessedEnd } from './terminal-state-machine';
import { precedesBoot } from './boot-window';
import { processGone } from '../events/terminal-event';
import type { AgentListing } from '../entities/agent-record';
import type { Clock } from '../ports/clock';
import type { Disposable } from '../ports/disposable';
import type { Logger } from '../ports/logger';
import type { OwnerId } from '../entities/owner-id';
import type { OwnerLiveness, OwnerPresence, OwnerSurvey } from '../ports/owner-presence';
import type { Scheduler } from '../ports/scheduler';
import type { SessionRegistry } from './session-registry';
import type { TerminalEntry } from '../entities/terminal-entry';
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

/** What one sweep found. Everything in it is a thing that changed, not a total. */
export interface ReconcileReport {
  /** `TerminalId.value` of the records that moved to `orphaned` in this sweep. */
  readonly orphaned: readonly string[];
  /** The windows whose presence files were taken out of `owners/`. */
  readonly collected: readonly string[];
  /** Conversations the CLI is running that no record on this machine names. */
  readonly unknownSessions: readonly string[];
}

const NOTHING_FOUND: ReconcileReport = Object.freeze({
  orphaned: Object.freeze([]),
  collected: Object.freeze([]),
  unknownSessions: Object.freeze([]),
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
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  readonly logger: Logger;
  readonly intervalMs?: number;
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
export class Reconciler implements Disposable {
  private readonly _options: ReconcilerOptions;
  private readonly _listeners = new Set<ReconcileListener>();
  private _liveness: ReadonlyMap<string, OwnerLiveness>;
  /** Conversations already mentioned, so that a log line is news rather than noise. */
  private _mentioned: ReadonlySet<string> = new Set();
  /** When the last pass began. `null` until one has. */
  private _sweptAtMs: number | null = null;
  private _timer: Disposable | null = null;
  private _disposed = false;

  constructor(options: ReconcilerOptions) {
    this._options = options;
    // This window is live from the first moment, before anything has been
    // swept: its own terminals are on screen, and a map that started out empty
    // would draw every one of them `detached` until the first sweep landed.
    this._liveness = new Map([[options.self.value, 'live']]);
  }

  /** Begins the repeating sweep. A second call does nothing. */
  public start(): void {
    if (this._timer !== null) {
      return;
    }
    this._arm();
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

  /** The whole map, in the shape the restore planner takes it (M2.10). */
  public liveness(): ReadonlyMap<string, OwnerLiveness> {
    return this._liveness;
  }

  /**
   * One window's liveness, and `unknown` for one nothing has established.
   *
   * The default is the rule rather than a fallback: a window nobody surveyed is
   * not a window known to be there, and `live` here would be a row claiming a
   * terminal is running in a window that closed an hour ago.
   */
  public livenessOf(ownerId: OwnerId): OwnerLiveness {
    return this._liveness.get(ownerId.value) ?? 'unknown';
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
        reason: String(cause),
      });
      return null;
    }
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
      if (!this._lostItsProcess(entry, listed, nowMs, uptimeSeconds)) {
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
  ): boolean {
    const { observed } = entry;
    if (observed.state === 'orphaned' || isWitnessedEnd(observed.state)) {
      return false;
    }
    if (listed !== null && entry.claimsAnyOf(listed)) {
      return false;
    }
    if (precedesBoot(observed.lastEventAt.getTime(), nowMs, uptimeSeconds)) {
      return true;
    }
    if (observed.pid === null) {
      // A machine with no `node` on PATH has no `SessionStart` forwarder and so
      // no pid on any record (H1). Reading "we were never told" as "the process
      // is gone" would mark every terminal on such a machine dead while they run.
      return false;
    }
    return !this._options.isRunning(observed.pid);
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
          reason: String(cause),
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
