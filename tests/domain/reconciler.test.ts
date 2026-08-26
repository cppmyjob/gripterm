import {
  DEFAULT_RECONCILE_INTERVAL_MS,
  HookEventParser,
  ObservedState,
  OwnerId,
  Reconciler,
  SessionId,
  SessionRegistry,
  TerminalId,
  TerminalStateMachine,
  planRestore,
  presentTerminal,
  type AgentListing,
  type Disposable,
  type OwnerIdentity,
  type OwnerPresence,
  type OwnerSurvey,
  type PersistedTerminalState,
  type RepositoryListener,
  type TerminalEntry,
  type TerminalRepository,
} from '../../packages/core/src/index';
import {
  NEXT_SESSION_UUID,
  SESSION_UUID,
  TERMINAL_UUID,
  makeEntry,
  makeOwnerIdentity,
  makeOwnerRef,
} from '../helpers/domain-fixtures';
import { FakeScheduler, FixedClock, RecordingLogger } from '../helpers/port-fakes';

/**
 * The sweep that notices what no hook can report: a `claude` killed with -9, an
 * editor that crashed, a window that never got to say goodbye.
 *
 * Two of its three jobs can do harm, and the harm is the same one the rest of M2
 * is written against, so every rule below is written from the cost rather than
 * from the shape:
 *
 *   * calling a LIVE process gone marks a working conversation `orphaned`, which
 *     is a row inviting a person to start it over -- a second `claude --resume`
 *     on a live transcript (O3);
 *   * removing an UNREADABLE owner file turns its window's liveness from
 *     `unknown` into `dead`, and `dead` is what authorises adoption. A file
 *     unreadable because it was caught mid-write belongs to a window that is
 *     running.
 *
 * Against those, the third job -- the liveness map -- has the opposite failure:
 * an owner wrongly called dead is drawn `detached`, which is cosmetic until
 * somebody acts on it, and an owner wrongly called live is a row that lies about
 * a window that is gone. So the map answers `unknown` for anything it has not
 * established, and `live` about THIS window without asking anybody.
 *
 * Driven through the real registry and the real state machine. The base and the
 * presence directory are doubles, because what they implement -- the atomic
 * claim file, the verdict table -- has its own tests against real directories
 * (M2.3, M2.4).
 */

const NOW = new Date('2026-08-12T10:00:00.000Z');
/** A minute before `NOW`, and two hours after the machine booted. */
const HEARD_AT = new Date('2026-08-12T09:59:00.000Z');
/** Longer ago than the sweep's patience with a silent `working` row, and after the boot. */
const LONG_QUIET = new Date('2026-08-12T09:50:00.000Z');
/** Before the boot below -- a record from a previous life of this machine. */
const BEFORE_BOOT = new Date('2026-08-12T07:00:00.000Z');
const BOOTED_HOURS_AGO_S = 7200;

const US = 'window-activation-1';
const GONE = 'window-that-closed';
const ASLEEP = 'window-that-slept';

const OUTSIDE_SESSION = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';

const CLAUDE_PID = 4242;
const STRANGER_PID = 8080;

/**
 * The base as the sweep meets it: whole, and read from the medium.
 *
 * `readAll` and nothing else, because that is all the reconciler asks of it --
 * and asking the MEDIUM rather than this window's projection is the decision the
 * double exists to hold. Collecting a presence file turns on "no record names
 * this owner", and a projection that has not caught up with another window's
 * write would answer that question with a record it has not seen yet.
 */
class Base implements TerminalRepository {
  public reads = 0;
  public failure: Error | null = null;

  private _entries: readonly TerminalEntry[] = [];

  public hold(...entries: readonly TerminalEntry[]): void {
    this._entries = entries;
  }

  public async readAll(): Promise<readonly TerminalEntry[]> {
    this.reads += 1;
    if (this.failure !== null) {
      throw this.failure;
    }
    return this._entries;
  }

  public async readOwn(): Promise<readonly TerminalEntry[]> {
    return await this.readAll();
  }

  public async write(): Promise<void> {
    throw new Error('the reconciler must not write records');
  }

  public async adopt(): Promise<TerminalEntry> {
    throw new Error('the reconciler must not adopt');
  }

  public async remove(): Promise<void> {
    throw new Error('the reconciler must not remove records');
  }

  public watch(_listener: RepositoryListener): Disposable {
    return { dispose: (): void => undefined };
  }
}

/**
 * `owners/` as a list of rows, one per file.
 *
 * The verdict itself is `FileOwnerPresence`'s and is tested there against real
 * files; what this double supplies is the two shapes the reconciler has to tell
 * apart -- a file that decoded and a file that did not.
 */
class Presence implements OwnerPresence {
  public readonly collected: string[] = [];
  public failure: Error | null = null;
  public collectFailure: Error | null = null;

  private _rows: readonly OwnerSurvey[] = [];

  public show(...rows: readonly OwnerSurvey[]): void {
    this._rows = rows;
  }

  public async survey(): Promise<readonly OwnerSurvey[]> {
    if (this.failure !== null) {
      throw this.failure;
    }
    return this._rows;
  }

  public async collect(name: string): Promise<void> {
    if (this.collectFailure !== null) {
      throw this.collectFailure;
    }
    this.collected.push(name);
  }

  public async announce(): Promise<void> {
    throw new Error('the reconciler does not announce');
  }

  public async heartbeat(): Promise<void> {
    throw new Error('the reconciler does not beat');
  }

  public async livenessOf(): Promise<never> {
    throw new Error('the reconciler keeps its own map and asks once per sweep');
  }

  public async retire(): Promise<void> {
    throw new Error('the reconciler does not retire this window');
  }
}

function decodable(name: string, liveness: 'live' | 'dead' | 'unknown'): OwnerSurvey {
  const identity: OwnerIdentity = makeOwnerIdentity(name);
  return { name, fileName: `${name}.json`, identity, liveness };
}

/** A file in `owners/` that could not be read -- so nothing about its window is established. */
function unreadable(name: string): OwnerSurvey {
  return { name, fileName: `${name}.json`, identity: null, liveness: 'unknown' };
}

function observedAs(
  state: PersistedTerminalState,
  pid: number | null,
  at: Date = HEARD_AT
): ObservedState {
  return ObservedState.create({
    state,
    lastEventAt: at,
    currentTool: null,
    lastAssistantMessage: null,
    cost: null,
    contextWindow: null,
    pid,
  });
}

function listing(...sessionIds: readonly string[]): AgentListing {
  return {
    kind: 'listed',
    agents: sessionIds.map((value) => ({
      sessionId: SessionId.fromString(value),
      pid: null,
      cwd: null,
      kind: 'interactive',
      startedAt: null,
      name: null,
      status: null,
    })),
    skipped: 0,
  };
}

const NOTHING_RUNNING: AgentListing = { kind: 'listed', agents: [], skipped: 0 };

interface Parts {
  readonly reconciler: Reconciler;
  readonly base: Base;
  readonly presence: Presence;
  readonly registry: SessionRegistry;
  readonly scheduler: FakeScheduler;
  readonly logger: RecordingLogger;
  readonly clock: FixedClock;
  /** Pids that answer nothing. Everything else is taken to be running. */
  readonly gone: Set<number>;
  readonly agents: { value: AgentListing, asked: number };
  /** Pids this window signalled, in the order it signalled them (M3.5). */
  readonly signalled: number[];
  /** Pids the platform will refuse to signal, as one already gone does. */
  readonly unsignallable: Set<number>;
  /** `TerminalId.value` of the records this window still holds a terminal for. */
  readonly ourTerminals: Set<string>;
}

function build(): Parts {
  const clock = new FixedClock(NOW);
  const logger = new RecordingLogger();
  const scheduler = new FakeScheduler();
  const base = new Base();
  const presence = new Presence();
  const registry = new SessionRegistry({
    stateMachine: new TerminalStateMachine(),
    reader: new HookEventParser(),
    clock,
    logger,
  });
  const gone = new Set<number>();
  const agents = { value: NOTHING_RUNNING, asked: 0 };
  const signalled: number[] = [];
  const unsignallable = new Set<number>();
  const ourTerminals = new Set<string>();

  const reconciler = new Reconciler({
    repository: base,
    registry,
    presence,
    self: OwnerId.fromString(US),
    readAgents: async () => {
      agents.asked += 1;
      return agents.value;
    },
    isRunning: (pid) => {
      // Refuses the question rather than answering it, which is what makes the
      // rule above testable: `isProcessThere` would answer "there" for a
      // non-pid, so a double that shrugged would let "we were never told a
      // pid" and "the pid answers" produce the same result -- and the test
      // below would pass whether or not the rule existed.
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error(`the reconciler asked about ${String(pid)}, which is not a pid`);
      }
      return !gone.has(pid);
    },
    endProcess: (pid) => {
      // Refuses a number that is not a pid rather than shrugging at it, for the
      // reason `isRunning` above does -- and here the cost is larger than a
      // wrong answer: `process.kill(0, ...)` signals the CALLER's own group.
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error(`the reconciler tried to end ${String(pid)}, which is not a pid`);
      }
      if (unsignallable.has(pid)) {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      }
      signalled.push(pid);
    },
    holdsTerminal: (terminalId) => ourTerminals.has(terminalId.value),
    clock,
    scheduler,
    logger,
    uptimeSeconds: () => BOOTED_HOURS_AGO_S,
  });

  return {
    reconciler, base, presence, registry, scheduler, logger, clock, gone, agents,
    signalled, unsignallable, ourTerminals,
  };
}

function ours(overrides: {
  readonly id?: string;
  readonly session?: string;
  readonly observed?: ObservedState;
} = {}): TerminalEntry {
  return makeEntry({
    terminalId: TerminalId.fromString(overrides.id ?? TERMINAL_UUID),
    sessionId: SessionId.fromString(overrides.session ?? SESSION_UUID),
    owner: makeOwnerRef(US),
    observed: overrides.observed ?? observedAs('idle', CLAUDE_PID),
  });
}

function stateOf(registry: SessionRegistry, entry: TerminalEntry): PersistedTerminalState | null {
  return registry.stateOf(entry.terminalId);
}

function held(registry: SessionRegistry, entry: TerminalEntry): TerminalEntry {
  const found = registry.get(entry.terminalId);
  if (found === undefined) {
    throw new Error('the registry was expected to hold that record');
  }
  return found;
}

describe('the liveness of the windows on this machine', () => {
  it('hands the restore planner a map it can find its owners in', async () => {
    // The one assertion that a wrong KEY cannot survive: the dead window's
    // record has to come out as a step, and it only can if the map is keyed the
    // way the planner looks things up.
    const { reconciler, base, presence } = build();
    const abandoned = makeEntry({
      owner: makeOwnerRef(GONE),
      observed: observedAs('idle', null, BEFORE_BOOT),
    });
    base.hold(abandoned);
    presence.show(decodable(GONE, 'dead'), decodable(ASLEEP, 'unknown'));
    await reconciler.sweep();

    const plan = planRestore({
      entries: [abandoned],
      windowFolders: ['D:/Projects/foo'],
      ownerLiveness: reconciler.liveness(),
      deadPids: new Set<number>(),
      transcripts: { kind: 'indexed', sessionIds: new Set([SESSION_UUID]), skipped: 0 },
      agents: NOTHING_RUNNING,
      nowMs: NOW.getTime(),
      uptimeSeconds: BOOTED_HOURS_AGO_S,
    });

    expect(plan.steps).toHaveLength(1);
    expect(plan.skipped).toHaveLength(0);
  });

  it('keeps a window whose heartbeat merely went stale out of every plan', async () => {
    const { reconciler, base, presence } = build();
    const slept = makeEntry({
      owner: makeOwnerRef(ASLEEP),
      observed: observedAs('idle', null, BEFORE_BOOT),
    });
    base.hold(slept);
    presence.show(decodable(ASLEEP, 'unknown'));
    await reconciler.sweep();

    const plan = planRestore({
      entries: [slept],
      windowFolders: ['D:/Projects/foo'],
      ownerLiveness: reconciler.liveness(),
      deadPids: new Set<number>(),
      transcripts: { kind: 'indexed', sessionIds: new Set([SESSION_UUID]), skipped: 0 },
      agents: NOTHING_RUNNING,
      nowMs: NOW.getTime(),
      uptimeSeconds: BOOTED_HOURS_AGO_S,
    });

    expect(plan.steps).toHaveLength(0);
    expect(plan.skipped.map((skip) => skip.reason)).toStrictEqual(['owner-unknown']);
  });

  it('answers `live` about this window without asking the medium about it', async () => {
    // The machine woke from sleep: this window's own heartbeat is minutes old,
    // and the file says so. Believing the file would draw every one of this
    // window's own terminals `detached` while they are running in front of the
    // person reading the list.
    const { reconciler, base, presence } = build();
    const mine = ours();
    base.hold(mine);
    presence.show(decodable(US, 'unknown'));
    await reconciler.sweep();

    expect(reconciler.livenessOf(OwnerId.fromString(US))).toBe('live');
    const shown = presentTerminal(mine, { liveness: reconciler.livenessOf(mine.owner.ownerId) });
    expect(shown.state).toBe('idle');
  });

  it('answers `live` about this window even when its file says it is dead', async () => {
    const { reconciler, presence } = build();
    presence.show(decodable(US, 'dead'));
    await reconciler.sweep();

    expect(reconciler.livenessOf(OwnerId.fromString(US))).toBe('live');
  });

  it('calls a window it has not surveyed yet `unknown`, never `live`', async () => {
    // Before the first pass nothing has been established about anybody, and
    // `live` here would be a row claiming a terminal is running in a window
    // that closed an hour ago.
    const { reconciler } = build();

    expect(reconciler.livenessOf(OwnerId.fromString(ASLEEP))).toBe('unknown');
  });

  it('is live to itself from the first moment, before anything has been swept', async () => {
    // Its own terminals are on screen. A map that started out empty would draw
    // every one of them `detached` until the first sweep landed.
    const { reconciler } = build();

    expect(reconciler.livenessOf(OwnerId.fromString(US))).toBe('live');
  });

  /*
   * The defect the owner met on 2026-08-13, and the shape of it is two answers
   * to one question.
   *
   * `owners/` on their machine was EMPTY -- every window had said goodbye
   * properly, and `retire()` removes the file -- while a closed record still
   * named one of those windows. `FileOwnerPresence.livenessOf` reads that
   * absence as `dead`, and says so out loud: it is the one place absence is
   * evidence, because nothing else removes a presence file. This map cannot
   * read it at all: it is built by ENUMERATING the directory, so a window with
   * no file simply never appears, and the default answered `unknown`.
   *
   * The consequence was not cosmetic. The restore predicate asks the store and
   * got `dead`; the list asks this map and got `unknown`, which is drawn
   * "window not answering" and given `CONTEXT_FOREIGN` -- a row with no menu at
   * all. So the record could not be closed, deleted or taken over from the
   * list, which is exactly what the owner reported.
   *
   * The default therefore splits in two: nothing surveyed yet is still
   * `unknown`, and a window missing from a directory this reconciler HAS read
   * is gone.
   */
  it('reads a window that left no presence file as gone, the way the store already does', async () => {
    const { reconciler, presence } = build();
    presence.show();

    await reconciler.sweep();

    expect(reconciler.livenessOf(OwnerId.fromString(GONE))).toBe('dead');
  });

  it('draws that record detached, rather than as a window that is not answering', async () => {
    const { reconciler, presence } = build();
    const abandoned = makeEntry({ owner: makeOwnerRef(GONE) });
    presence.show();
    await reconciler.sweep();

    const shown = presentTerminal(abandoned, {
      ours: false,
      liveness: reconciler.livenessOf(abandoned.owner.ownerId),
    });

    expect(shown.state).toBe('detached');
    // The half that decides whether a person can act: `unreachable` and
    // `detached` are both adoptable, but a CLOSED record of a silent window is
    // `CONTEXT_FOREIGN`, which has no menu entries in the manifest at all.
    expect(shown.contextValue).toBe('gripterm.terminal.adoptable');
  });

  it('establishes nothing about anybody when the directory could not be read at all', async () => {
    // A sweep that read nothing has not seen a window disappear -- it has not
    // seen anything. The whole pass changes nothing (§4.8), and that has to
    // include the default, or an unreadable store would authorise adopting
    // every terminal on the machine.
    const { reconciler, presence } = build();
    presence.failure = new Error('the directory went away');

    await reconciler.sweep();

    expect(reconciler.livenessOf(OwnerId.fromString(GONE))).toBe('unknown');
  });

  it('asks for a redraw when the map moves, and only then', async () => {
    const { reconciler, presence } = build();
    let redraws = 0;
    const subscription = reconciler.subscribe(() => {
      redraws += 1;
    });

    presence.show(decodable(GONE, 'live'));
    await reconciler.sweep();
    expect(redraws).toBe(1);

    await reconciler.sweep();
    expect(redraws).toBe(1);

    presence.show(decodable(GONE, 'dead'));
    await reconciler.sweep();
    expect(redraws).toBe(2);

    subscription.dispose();
    presence.show(decodable(GONE, 'unknown'));
    await reconciler.sweep();
    expect(redraws).toBe(2);
  });

  it('notices a window that disappeared from the directory altogether', async () => {
    // It said goodbye between the two passes, which is what `retire()` looks
    // like from here. Until M2.20 this answered `unknown` -- see the note above
    // the `dead` tests for why that was the store contradicting itself.
    const { reconciler, presence } = build();
    presence.show(decodable(GONE, 'live'));
    await reconciler.sweep();

    presence.show();
    await reconciler.sweep();

    expect(reconciler.livenessOf(OwnerId.fromString(GONE))).toBe('dead');
  });

  it('leaves the previous map standing when the directory cannot be read', async () => {
    const { reconciler, presence, logger } = build();
    presence.show(decodable(GONE, 'dead'));
    await reconciler.sweep();

    presence.failure = new Error('the directory went away');
    const report = await reconciler.sweep();

    expect(reconciler.livenessOf(OwnerId.fromString(GONE))).toBe('dead');
    expect(report.collected).toStrictEqual([]);
    expect(logger.warnings).toHaveLength(1);
  });
});

describe('a record that says it is working and has gone quiet', () => {
  it('stops saying `working` once the silence is longer than the patience', async () => {
    // A50, measured 2026-08-20: an interrupted turn produces no hook at all --
    // not one of the thirty-one the CLI's binary carries -- so the row would
    // say `working` until the person's next turn in that terminal. That is П1's
    // question ("does this one need me") answered wrongly in the direction that
    // costs: a row nobody looks at.
    const { reconciler, base, registry } = build();
    const mine = ours({ observed: observedAs('working', CLAUDE_PID, LONG_QUIET) });
    base.hold(mine);
    registry.register(mine);

    const report = await reconciler.sweep();

    expect(report.quieted).toStrictEqual([TERMINAL_UUID]);
    expect(stateOf(registry, mine)).toBe('degraded');
  });

  it('waits out a silence that is still short', async () => {
    const { reconciler, base, registry } = build();
    const mine = ours({ observed: observedAs('working', CLAUDE_PID) });
    base.hold(mine);
    registry.register(mine);

    const report = await reconciler.sweep();

    expect(report.quieted).toStrictEqual([]);
    expect(stateOf(registry, mine)).toBe('working');
  });

  it('says nothing about a quiet record that never claimed to be working', async () => {
    // Silence around an `idle` row is what an idle row IS. The rule exists
    // against a claim, not against quiet.
    const { reconciler, base, registry } = build();
    const mine = ours({ observed: observedAs('idle', CLAUDE_PID, LONG_QUIET) });
    base.hold(mine);
    registry.register(mine);

    const report = await reconciler.sweep();

    expect(report.quieted).toStrictEqual([]);
    expect(stateOf(registry, mine)).toBe('idle');
  });

  it('prefers the harder fact when the quiet record has also lost its process', async () => {
    // `orphaned` is established by a probe; `degraded` is inferred from an
    // absence. Reporting the row as merely unknown would drop the stronger of
    // the two, and it is the one a person can act on.
    const { reconciler, base, registry, gone } = build();
    const mine = ours({ observed: observedAs('working', CLAUDE_PID, LONG_QUIET) });
    base.hold(mine);
    registry.register(mine);
    gone.add(CLAUDE_PID);

    const report = await reconciler.sweep();

    expect(report.orphaned).toStrictEqual([TERMINAL_UUID]);
    expect(report.quieted).toStrictEqual([]);
    expect(stateOf(registry, mine)).toBe('orphaned');
  });
});

describe('a record whose process is gone', () => {
  it('moves to `orphaned` when the pid this window was told answers nothing', async () => {
    const { reconciler, base, registry, gone } = build();
    const mine = ours();
    base.hold(mine);
    registry.register(mine);
    gone.add(CLAUDE_PID);

    const report = await reconciler.sweep();

    expect(report.orphaned).toStrictEqual([TERMINAL_UUID]);
    expect(stateOf(registry, mine)).toBe('orphaned');
  });

  it('leaves a record alone while this window still holds its terminal, whatever the pid says', async () => {
    /*
     * The customer's log, 2026-08-22, ten seconds apart:
     *
     *   a terminal was found without its process {"pid":32496}
     *   a terminal could not be resumed
     *   {"cause":"ConflictError: this terminal is already running"}
     *
     * The sweep called the record orphaned while the window was holding a
     * terminal for it. The pid is what `Terminal.processId` said when the
     * terminal was made -- on Windows, the process the EDITOR started, which an
     * installer whose executable launches something else and exits leaves dead
     * within seconds of a conversation that is running fine.
     */
    const { reconciler, base, registry, gone, ourTerminals, logger } = build();
    const mine = ours();
    base.hold(mine);
    registry.register(mine);
    gone.add(CLAUDE_PID);
    ourTerminals.add(TERMINAL_UUID);

    const report = await reconciler.sweep();

    expect(report.orphaned).toStrictEqual([]);
    expect(stateOf(registry, mine)).toBe('idle');
    // And it is said out loud, because a pid that dies under a live terminal is
    // worth knowing about on the machine it happens on.
    expect(logger.warnings.some((line) => line.message.includes('kept its terminal'))).toBe(true);
  });

  it('still orphans a record whose terminal this window has let go of', async () => {
    // The other side of the same rule: no terminal of ours, a dead pid, and
    // nothing first-hand to outrank it.
    const { reconciler, base, registry, gone } = build();
    const mine = ours();
    base.hold(mine);
    registry.register(mine);
    gone.add(CLAUDE_PID);

    const report = await reconciler.sweep();

    expect(report.orphaned).toStrictEqual([TERMINAL_UUID]);
  });

  it('leaves a record alone while its pid still answers', async () => {
    const { reconciler, base, registry } = build();
    const mine = ours();
    base.hold(mine);
    registry.register(mine);

    const report = await reconciler.sweep();

    expect(report.orphaned).toStrictEqual([]);
    expect(stateOf(registry, mine)).toBe('idle');
  });

  it('never calls a record with no pid orphaned', async () => {
    // A machine with no `node` on PATH has no `SessionStart` forwarder, so no
    // record on it ever carries a pid (H1). Reading "we were never told" as
    // "the process is gone" would mark every terminal on such a machine dead
    // while they run.
    const { reconciler, base, registry } = build();
    const mine = ours({ observed: observedAs('working', null) });
    base.hold(mine);
    registry.register(mine);

    const report = await reconciler.sweep();

    expect(report.orphaned).toStrictEqual([]);
    expect(stateOf(registry, mine)).toBe('working');
  });

  it('orphans a record last heard from before the machine booted, whatever the pid answers', async () => {
    // The pid is a number from a previous life and a stranger holds it now, so
    // the probe says "there". Arithmetic outranks it: nothing observed before
    // the boot can be describing a process running after it.
    const { reconciler, base, registry } = build();
    const mine = ours({ observed: observedAs('idle', STRANGER_PID, BEFORE_BOOT) });
    base.hold(mine);
    registry.register(mine);

    const report = await reconciler.sweep();

    expect(report.orphaned).toStrictEqual([TERMINAL_UUID]);
    expect(stateOf(registry, mine)).toBe('orphaned');
  });

  it('believes the CLI over the pid when the CLI says the conversation is running', async () => {
    const { reconciler, base, registry, gone, agents } = build();
    const mine = ours();
    base.hold(mine);
    registry.register(mine);
    gone.add(CLAUDE_PID);
    agents.value = listing(SESSION_UUID);

    const report = await reconciler.sweep();

    expect(report.orphaned).toStrictEqual([]);
    expect(stateOf(registry, mine)).toBe('idle');
  });

  it('counts a conversation this record used to be as the CLI naming it', async () => {
    const { reconciler, base, registry, gone, agents } = build();
    const cleared = ours().withSessionId(SessionId.fromString(NEXT_SESSION_UUID));
    base.hold(cleared);
    registry.register(cleared);
    gone.add(CLAUDE_PID);
    agents.value = listing(SESSION_UUID);

    const report = await reconciler.sweep();

    expect(report.orphaned).toStrictEqual([]);
  });

  it('falls back on its own evidence when the CLI cannot be asked', async () => {
    const { reconciler, base, registry, gone, agents } = build();
    const mine = ours();
    base.hold(mine);
    registry.register(mine);
    gone.add(CLAUDE_PID);
    agents.value = { kind: 'unavailable', reason: 'claude is not on PATH' };

    const report = await reconciler.sweep();

    expect(report.orphaned).toStrictEqual([TERMINAL_UUID]);
  });

  it('does not touch a record another window owns', async () => {
    // Its owner is the only writer of it (§4.8). If that window is gone the row
    // is drawn `detached` by the liveness map, which says the same thing without
    // writing into somebody else's file.
    const { reconciler, base, registry, presence, gone } = build();
    const theirs = makeEntry({
      owner: makeOwnerRef(GONE),
      observed: observedAs('idle', CLAUDE_PID),
    });
    base.hold(theirs);
    registry.replaceForeign([theirs]);
    presence.show(decodable(GONE, 'dead'));
    gone.add(CLAUDE_PID);

    const report = await reconciler.sweep();

    expect(report.orphaned).toStrictEqual([]);
    expect(registry.list()[0]?.observed.state).toBe('idle');
  });

  it('stamps a record orphaned once and not again on every sweep', async () => {
    const { reconciler, base, registry, gone } = build();
    const mine = ours();
    base.hold(mine);
    registry.register(mine);
    gone.add(CLAUDE_PID);
    await reconciler.sweep();
    const stamped = held(registry, mine).observed.lastEventAt;

    const second = await reconciler.sweep();

    expect(second.orphaned).toStrictEqual([]);
    expect(held(registry, mine).observed.lastEventAt).toStrictEqual(stamped);
  });

  it('leaves a record whose end was witnessed as it is', async () => {
    const { reconciler, base, registry, gone } = build();
    const mine = ours({ observed: observedAs('ended', CLAUDE_PID) });
    base.hold(mine);
    registry.register(mine);
    gone.add(CLAUDE_PID);

    const report = await reconciler.sweep();

    expect(report.orphaned).toStrictEqual([]);
    expect(stateOf(registry, mine)).toBe('ended');
  });
});

/*
 * WHICH RULE ORPHANED IT, and which rule spared it (Ш3).
 *
 * `_lostItsProcess` has six ways out and the caller wrote one line, on the
 * positive, naming the record and the pid but not the rule. Two entirely
 * different findings -- "the pid answered nothing" and "this record was last
 * heard from before the machine booted, so its pid means nothing at all" --
 * arrived in a support log looking identical, and this is the only rule in the
 * build that stamps a record `orphaned`.
 *
 * The negatives are said once per record per CHANGE of rule, not once per sweep:
 * the sweep runs every thirty seconds over every record this window owns, and a
 * line per record per pass would be a log made of one sentence. `_strangers` in
 * this same class already keeps that shape.
 */
describe('which rule decided a record had lost its process', () => {
  it('names the pid probe when that is what decided it', async () => {
    const { reconciler, base, registry, gone, logger } = build();
    const mine = ours();
    base.hold(mine);
    registry.register(mine);
    gone.add(CLAUDE_PID);

    await reconciler.sweep();

    const said = logger.infos.find((line) => line.message.includes('without its process'));
    expect(said?.details).toMatchObject({
      terminalId: TERMINAL_UUID,
      rule: 'nothing answers for the pid it carries',
    });
  });

  it('names the boot rule when that is what decided it', async () => {
    const { reconciler, base, registry, logger } = build();
    const mine = ours({ observed: observedAs('idle', STRANGER_PID, BEFORE_BOOT) });
    base.hold(mine);
    registry.register(mine);

    await reconciler.sweep();

    const said = logger.infos.find((line) => line.message.includes('without its process'));
    expect(said?.details).toMatchObject({
      terminalId: TERMINAL_UUID,
      rule: 'it was last heard from before this machine booted',
    });
  });

  it('says why a record was left alone, once, and not again on the next sweep', async () => {
    const { reconciler, base, registry, logger } = build();
    const mine = ours({ observed: observedAs('working', null) });
    base.hold(mine);
    registry.register(mine);

    await reconciler.sweep();
    const said = logger.infos.filter((line) => line.message.includes('kept its process'));
    expect(said).toHaveLength(1);
    expect(said[0]?.details).toMatchObject({
      terminalId: TERMINAL_UUID,
      rule: 'no pid was ever recorded for it, and never being told is not evidence',
    });

    await reconciler.sweep();
    expect(logger.infos.filter((line) => line.message.includes('kept its process'))).toHaveLength(1);
  });
});

describe('the presence files of windows that are gone', () => {
  it('collects the file of a window established dead once no record names it', async () => {
    const { reconciler, presence } = build();
    presence.show(decodable(GONE, 'dead'));

    const report = await reconciler.sweep();

    expect(report.collected).toStrictEqual([GONE]);
    expect(presence.collected).toStrictEqual([`${GONE}.json`]);
  });

  it('keeps the file of a dead window while a record still names it', async () => {
    const { reconciler, base, presence } = build();
    base.hold(makeEntry({ owner: makeOwnerRef(GONE) }));
    presence.show(decodable(GONE, 'dead'));

    const report = await reconciler.sweep();

    expect(report.collected).toStrictEqual([]);
    expect(presence.collected).toStrictEqual([]);
  });

  it('collects a file that cannot be read at all, because liveness never will', async () => {
    // A file that does not decode answers `unknown` forever: it can say neither
    // that its window is there nor that it is gone, so nothing but this ever
    // takes it away.
    const { reconciler, presence } = build();
    presence.show(unreadable('window-half-written'));

    const report = await reconciler.sweep();

    expect(report.collected).toStrictEqual(['window-half-written']);
  });

  it('keeps an unreadable file while a record names it, because removing it would authorise adoption', async () => {
    // This is the dangerous direction and the reason the rule is "no record
    // points at it" rather than "it does not decode". A file caught mid-write
    // belongs to a window that is running; absence reads as `dead`, and `dead`
    // is what lets another window take its terminals.
    const { reconciler, base, presence } = build();
    base.hold(makeEntry({ owner: makeOwnerRef('window-half-written') }));
    presence.show(unreadable('window-half-written'));

    const report = await reconciler.sweep();

    expect(report.collected).toStrictEqual([]);
  });

  it('never collects this window\'s own file', async () => {
    const { reconciler, presence } = build();
    presence.show(decodable(US, 'dead'), decodable(GONE, 'dead'));

    const report = await reconciler.sweep();

    expect(report.collected).toStrictEqual([GONE]);
  });

  it('keeps the file of a window that is merely silent', async () => {
    const { reconciler, presence } = build();
    presence.show(decodable(ASLEEP, 'unknown'));

    const report = await reconciler.sweep();

    expect(report.collected).toStrictEqual([]);
  });

  it('reports a collection that failed as a warning and finishes the sweep', async () => {
    const { reconciler, presence, logger } = build();
    presence.show(decodable(GONE, 'dead'));
    presence.collectFailure = new Error('the file is locked');

    const report = await reconciler.sweep();

    expect(report.collected).toStrictEqual([]);
    expect(logger.warnings).toHaveLength(1);
  });

  it('collects nothing at all when the base could not be read', async () => {
    // "No record names this owner" is the whole of the guard, and a base that
    // did not answer has not said that.
    const { reconciler, base, presence, logger } = build();
    base.failure = new Error('the storage directory is gone');
    presence.show(decodable(GONE, 'dead'));

    const report = await reconciler.sweep();

    expect(report.collected).toStrictEqual([]);
    expect(presence.collected).toStrictEqual([]);
    expect(logger.warnings).toHaveLength(1);
  });
});

describe('conversations nobody has a record of', () => {
  it('names the ones the CLI is running that no record on this machine claims', async () => {
    const { reconciler, base, agents } = build();
    base.hold(ours());
    agents.value = listing(SESSION_UUID, OUTSIDE_SESSION);

    const report = await reconciler.sweep();

    expect(report.unknownSessions).toStrictEqual([OUTSIDE_SESSION]);
  });

  it('counts a conversation a record used to be as known', async () => {
    const { reconciler, base, agents } = build();
    base.hold(ours().withSessionId(SessionId.fromString(NEXT_SESSION_UUID)));
    agents.value = listing(SESSION_UUID);

    const report = await reconciler.sweep();

    expect(report.unknownSessions).toStrictEqual([]);
  });

  it('counts records this window does not own as known', async () => {
    const { reconciler, base, agents } = build();
    base.hold(makeEntry({ owner: makeOwnerRef(GONE) }));
    agents.value = listing(SESSION_UUID);

    const report = await reconciler.sweep();

    expect(report.unknownSessions).toStrictEqual([]);
  });

  it('makes a stranger news again after the CLI stopped answering', async () => {
    // Not asked is not "nothing is running". A conversation that was seen, then
    // lost with the CLI, then seen again has been out of sight in between --
    // and the log line is the only thing that says so.
    const { reconciler, agents, logger } = build();
    agents.value = listing(OUTSIDE_SESSION);
    await reconciler.sweep();

    agents.value = { kind: 'unavailable', reason: 'claude is not on PATH' };
    await reconciler.sweep();
    agents.value = listing(OUTSIDE_SESSION);
    await reconciler.sweep();

    expect(mentions(logger, OUTSIDE_SESSION)).toBe(2);
  });

  it('says nothing when the CLI could not be asked, and calls it no fault', async () => {
    const { reconciler, agents, logger } = build();
    agents.value = { kind: 'unavailable', reason: 'claude is not on PATH' };

    const report = await reconciler.sweep();

    expect(report.unknownSessions).toStrictEqual([]);
    expect(logger.errors).toStrictEqual([]);
  });

  it('mentions one it has already mentioned only when it comes back', async () => {
    // A line every thirty seconds for the whole life of the window is a trace
    // nobody reads, and a trace nobody reads is worse than none: it buries the
    // ones that mean something.
    const { reconciler, agents, logger } = build();
    agents.value = listing(OUTSIDE_SESSION);
    await reconciler.sweep();
    await reconciler.sweep();
    expect(mentions(logger, OUTSIDE_SESSION)).toBe(1);

    agents.value = NOTHING_RUNNING;
    await reconciler.sweep();
    agents.value = listing(OUTSIDE_SESSION);
    await reconciler.sweep();

    expect(mentions(logger, OUTSIDE_SESSION)).toBe(2);
  });
});

describe('the sweep as a repeating thing', () => {
  /*
   * The promise this asserts CHANGED on 2026-08-22, and the customer is why:
   * "само окно Claude Code Terminals загружает данные после открытия
   * приложения очень долго — до минуты". Until then the first pass waited out
   * the whole interval, so a window that had just started drew every record in
   * the state it was written down in -- a conversation that was running when
   * the window closed still calling itself running -- for thirty seconds, and
   * for sixty when the first pass could not read the machine.
   */
  it('sweeps the moment it is started, and then on the interval', async () => {
    const { reconciler, scheduler, base } = build();
    expect(scheduler.armed).toHaveLength(0);

    reconciler.start();
    await settled();

    expect(base.reads).toBe(1);
    expect(scheduler.live[0]?.ms).toBe(DEFAULT_RECONCILE_INTERVAL_MS);

    scheduler.elapse();
    await settled();

    expect(base.reads).toBe(2);
    expect(scheduler.live[0]?.ms).toBe(DEFAULT_RECONCILE_INTERVAL_MS);
  });

  it('takes the interval it was given', async () => {
    const { scheduler } = build();
    const reconciler = new Reconciler({
      repository: new Base(),
      registry: new SessionRegistry({
        stateMachine: new TerminalStateMachine(),
        reader: new HookEventParser(),
        clock: new FixedClock(NOW),
        logger: new RecordingLogger(),
      }),
      presence: new Presence(),
      self: OwnerId.fromString(US),
      readAgents: async () => NOTHING_RUNNING,
      isRunning: () => true,
      endProcess: () => {
        throw new Error('this reconciler exists to check an interval and ends nothing');
      },
      clock: new FixedClock(NOW),
      scheduler,
      logger: new RecordingLogger(),
      uptimeSeconds: () => BOOTED_HOURS_AGO_S,
      intervalMs: 90_000,
    });
    reconciler.start();
    await settled();

    expect(scheduler.live[0]?.ms).toBe(90_000);
    reconciler.dispose();
  });

  it('keeps sweeping after a sweep that could not read anything', async () => {
    const { reconciler, scheduler, base } = build();
    base.failure = new Error('the storage directory is gone');
    reconciler.start();
    await settled();

    scheduler.elapse();
    await settled();

    expect(scheduler.live).toHaveLength(1);
  });

  it('stops when it is disposed', async () => {
    const { reconciler, scheduler } = build();
    reconciler.start();
    // Awaited, or the timer this is about would not be armed yet and the
    // assertion would pass on a reconciler that had simply not got going.
    await settled();
    expect(scheduler.live).toHaveLength(1);

    reconciler.dispose();

    expect(scheduler.live).toHaveLength(0);
  });

  it('does not arm itself again when it was disposed mid-sweep', async () => {
    // The window is closing while a pass is in flight. Re-arming after it would
    // leave a timer holding a registry nobody is drawing any more.
    const { reconciler, scheduler } = build();
    reconciler.start();
    await settled();
    scheduler.elapse();

    reconciler.dispose();
    await settled();

    expect(scheduler.live).toHaveLength(0);
  });

  /*
   * The out-of-turn pass exists because П4 wants the list right when a person
   * looks at it, and the two moments that mean "somebody is about to look" --
   * the window taking focus, and another window writing to the base -- are
   * both things a person can cause dozens of times a minute. Each pass spawns
   * `claude agents --json`, measured at 0.56-0.70 s (A24). So the floor is not
   * tuning: without it, alt-tab is a process spawner.
   */
  it('runs an out-of-turn sweep when nothing has swept yet', async () => {
    const { reconciler, base } = build();

    await reconciler.sweepIfStale();

    expect(base.reads).toBe(1);
  });

  it('refuses an out-of-turn sweep that follows one too closely', async () => {
    const { reconciler, base } = build();
    await reconciler.sweep();

    await reconciler.sweepIfStale();

    expect(base.reads).toBe(1);
  });

  it('runs an out-of-turn sweep once the interval has passed', async () => {
    const { reconciler, base, clock } = build();
    await reconciler.sweep();

    clock.advance(DEFAULT_RECONCILE_INTERVAL_MS);
    await reconciler.sweepIfStale();

    expect(base.reads).toBe(2);
  });

  it('counts a pass that read nothing as a pass, so a broken machine is not swept in a loop', async () => {
    const { reconciler, base } = build();
    base.failure = new Error('the storage directory is gone');
    await reconciler.sweep();

    await reconciler.sweepIfStale();

    expect(base.reads).toBe(1);
  });

  /*
   * The second half of the same complaint, and the reason the FIRST pass goes
   * through the floor (Ш11). The composition root sweeps and then starts the
   * timer -- deliberately, because the pass has to be awaited before the trash
   * is swept -- and `start()` swept again on top of it. Two passes a second
   * apart, and each one spawns `claude agents --json` at 0.56-0.70 s (A24), on
   * the path a person is waiting on.
   *
   * The floor is the interval, so the timer's own ticks are not touched: by the
   * time one arrives, the interval has passed by definition.
   */
  it('does not sweep again when the composition root has just swept', async () => {
    const { reconciler, base } = build();
    await reconciler.sweep();

    reconciler.start();
    await settled();

    expect(base.reads).toBe(1);
    reconciler.dispose();
  });

  it('is not started twice by a second call', async () => {
    const { reconciler, scheduler, base } = build();
    reconciler.start();
    reconciler.start();
    await settled();

    // Both halves, because the guard moved: a second call must not sweep a
    // second time either, and the timer alone would no longer catch that.
    expect(base.reads).toBe(1);
    expect(scheduler.live).toHaveLength(1);
    reconciler.dispose();
  });
});

/**
 * The pass that ENDS a process, which is the only thing in this project no undo
 * of ours reaches (M3.5, O4).
 *
 * It runs once, at activation, before anything reads the machine -- so a record
 * whose process it took away is a record the restore of the same activation may
 * bring back. The four guards it is written from are here one test each: the
 * engine, the owner, the boot, and the machine's own word that the pid and the
 * conversation belong together.
 */
describe('the processes of windows that are gone', () => {
  /** A record of the window that died: `own`, with a pid, heard from after the boot. */
  function theirs(overrides: {
    readonly engine?: 'own' | 'editor';
    readonly pid?: number | null;
  } = {}): TerminalEntry {
    return makeEntry({
      terminalId: TerminalId.fromString(TERMINAL_UUID),
      sessionId: SessionId.fromString(SESSION_UUID),
      owner: makeOwnerRef(GONE),
      engine: overrides.engine ?? 'own',
      observed: observedAs('idle', overrides.pid === undefined ? CLAUDE_PID : overrides.pid),
    });
  }

  /** The CLI's own answer: this conversation is running, as this process. */
  function running(sessionId: string, pid: number | null): AgentListing {
    return {
      kind: 'listed',
      agents: [{
        sessionId: SessionId.fromString(sessionId),
        pid,
        cwd: null,
        kind: 'interactive',
        startedAt: null,
        name: null,
        status: 'idle',
      }],
      skipped: 0,
    };
  }

  function corroborated(): Parts {
    const parts = build();
    parts.base.hold(theirs());
    parts.presence.show(decodable(GONE, 'dead'));
    parts.agents.value = running(SESSION_UUID, CLAUDE_PID);
    return parts;
  }

  it('ends a process the machine confirms is that record\'s conversation', async () => {
    const parts = corroborated();
    parts.gone.add(CLAUDE_PID);

    const report = await parts.reconciler.endOrphanedProcesses();

    expect(parts.signalled).toStrictEqual([CLAUDE_PID]);
    expect(report.ended).toStrictEqual([TERMINAL_UUID]);
  });

  it('does not ask the CLI at all when nothing could qualify', async () => {
    // Every pass costs `claude agents --json`, 0.56-0.70 s (A24), at the moment
    // a person is waiting for their window. The free evidence goes first.
    const parts = build();
    parts.base.hold(theirs({ engine: 'editor' }));
    parts.presence.show(decodable(GONE, 'dead'));

    const report = await parts.reconciler.endOrphanedProcesses();

    expect(parts.agents.asked).toBe(0);
    expect(report.ended).toStrictEqual([]);
    expect(parts.signalled).toStrictEqual([]);
  });

  it('leaves the terminals the editor made, whatever the CLI says about them', async () => {
    const parts = corroborated();
    parts.base.hold(theirs({ engine: 'editor' }));

    await parts.reconciler.endOrphanedProcesses();

    expect(parts.signalled).toStrictEqual([]);
  });

  it('leaves a record whose window is merely quiet', async () => {
    const parts = corroborated();
    parts.presence.show(decodable(GONE, 'unknown'));

    await parts.reconciler.endOrphanedProcesses();

    expect(parts.signalled).toStrictEqual([]);
  });

  it('ends nothing when the CLI could not be asked, and says so', async () => {
    const parts = corroborated();
    parts.agents.value = { kind: 'unavailable', reason: 'no claude on the PATH' };

    const report = await parts.reconciler.endOrphanedProcesses();

    expect(parts.signalled).toStrictEqual([]);
    expect(report.unconfirmed).toStrictEqual([TERMINAL_UUID]);
    expect(parts.logger.infos.map((line) => line.message)).toContainEqual(
      expect.stringContaining('could not be confirmed')
    );
  });

  it('ends nothing when the CLI names another conversation at that pid', async () => {
    // The whole point of asking twice: a stranger's `claude` on a reused pid
    // passes every rule this window can apply by itself.
    const parts = corroborated();
    parts.agents.value = running(OUTSIDE_SESSION, CLAUDE_PID);

    const report = await parts.reconciler.endOrphanedProcesses();

    expect(parts.signalled).toStrictEqual([]);
    expect(report.unconfirmed).toStrictEqual([TERMINAL_UUID]);
  });

  it('waits for the pid to stop answering before it reports the record ended', async () => {
    // `TerminateProcess` is asynchronous, and both gates of the restore read the
    // machine straight afterwards (`deadPids` by signal 0, `session-listed` by
    // the CLI). Without this wait the acceptance of the whole step floats.
    const parts = corroborated();
    const pass = parts.reconciler.endOrphanedProcesses();
    await settled();

    expect(parts.scheduler.live).toHaveLength(1);
    parts.gone.add(CLAUDE_PID);
    parts.scheduler.elapse();

    expect((await pass).ended).toStrictEqual([TERMINAL_UUID]);
  });

  it('says out loud when a process it ended is still answering after the ceiling', async () => {
    const parts = corroborated();
    const pass = parts.reconciler.endOrphanedProcesses();

    for (let step = 0; step < 200; step += 1) {
      await settled();
      if (parts.scheduler.live.length === 0) {
        break;
      }
      parts.scheduler.elapse();
    }

    const report = await pass;
    expect(report.survived).toStrictEqual([CLAUDE_PID]);
    expect(report.ended).toStrictEqual([]);
    expect(parts.logger.warnings.map((line) => line.message)).toContainEqual(
      expect.stringContaining('did not stop')
    );
  });

  it('changes nothing when the base could not be read', async () => {
    const parts = corroborated();
    parts.base.failure = new Error('the storage directory is gone');

    const report = await parts.reconciler.endOrphanedProcesses();

    expect(parts.signalled).toStrictEqual([]);
    expect(report.ended).toStrictEqual([]);
  });

  it('carries on when the platform refuses the pid, because a process already gone is the ordinary case', async () => {
    const parts = corroborated();
    parts.unsignallable.add(CLAUDE_PID);
    parts.gone.add(CLAUDE_PID);

    const report = await parts.reconciler.endOrphanedProcesses();

    expect(report.ended).toStrictEqual([TERMINAL_UUID]);
    expect(parts.signalled).toStrictEqual([]);
  });
});

/** Lets every pending microtask of a sweep run, however deep its awaits go. */
async function settled(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function mentions(logger: RecordingLogger, sessionId: string): number {
  return logger.infos.filter((line) => JSON.stringify(line.details ?? {}).includes(sessionId))
    .length;
}
