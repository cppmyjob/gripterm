import {
  ObservedState,
  PERSISTED_TERMINAL_STATES,
  type PersistedTerminalState,
  OwnerId,
  OwnerRef,
  SessionId,
  TerminalId,
  decodeEntry,
  encodeRecord,
  explainRefusal,
  planRestore,
  refusalAnywhere,
  restoreNotice,
  resumeIntent,
} from '../../packages/core/src/index';
import { makeEntry, makeMetadata } from '../helpers/domain-fixtures';
import type {
  AgentListing,
  RestoreInputs,
  RestorePlan,
  RestoreRefusal,
  ResumeDecision,
  TerminalEntry,
  TranscriptIndex,
} from '../../packages/core/src/index';

const NOW = Date.parse('2026-08-12T12:00:00.000Z');
const HOUR_SECONDS = 3600;
const MINUTE_MS = 60_000;

/** This machine has been up an hour, so anything older than that is a previous life. */
const SINCE_BOOT = new Date(NOW - MINUTE_MS);
const BEFORE_BOOT = new Date(NOW - 2 * HOUR_SECONDS * 1000);

const TERMINAL_A = '11111111-1111-4111-8111-111111111111';
const TERMINAL_B = '22222222-2222-4222-8222-222222222222';
const SESSION_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SESSION_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const SESSION_PAST = 'cccccccc-3333-4333-8333-cccccccccccc';

const GONE_OWNER = 'window-that-died';
const CLAUDE_PID = 5150;
const FOLDER = 'D:/Projects/foo';

interface Sketch {
  readonly terminalId?: string;
  readonly sessionId?: string;
  readonly history?: readonly string[];
  readonly ownerId?: string;
  readonly folder?: string | null;
  readonly pid?: number | null;
  /** What the record says happened to it. `idle` unless a case is about the end. */
  readonly state?: PersistedTerminalState;
  readonly lastEventAt?: Date;
  readonly closedAt?: Date | null;
  readonly revision?: number;
}

function sketch(options: Sketch = {}): TerminalEntry {
  const history = options.history ?? [];
  return makeEntry({
    terminalId: TerminalId.fromString(options.terminalId ?? TERMINAL_A),
    sessionId: SessionId.fromString(options.sessionId ?? SESSION_A),
    sessionIdHistory: history.map((past) => SessionId.fromString(past)),
    owner: OwnerRef.create({
      kind: 'window',
      ownerId: OwnerId.fromString(options.ownerId ?? GONE_OWNER),
      editorKind: 'vscode',
      workspaceFolder: options.folder === undefined ? FOLDER : options.folder,
    }),
    observed: ObservedState.create({
      state: options.state ?? 'idle',
      lastEventAt: options.lastEventAt ?? SINCE_BOOT,
      currentTool: null,
      lastAssistantMessage: null,
      cost: null,
      contextWindow: null,
      pid: options.pid === undefined ? CLAUDE_PID : options.pid,
    }),
    closedAt: options.closedAt ?? null,
    revision: options.revision ?? 0,
  });
}

function transcriptsFor(...ids: readonly string[]): TranscriptIndex {
  return { kind: 'indexed', sessionIds: new Set(ids), skipped: 0 };
}

function listing(...ids: readonly string[]): AgentListing {
  return {
    kind: 'listed',
    agents: ids.map((id) => ({
      sessionId: SessionId.fromString(id),
      pid: 9000,
      cwd: FOLDER,
      kind: 'interactive',
      startedAt: NOW - MINUTE_MS,
      name: null,
      status: null,
    })),
    skipped: 0,
  };
}

/**
 * The CLI's list with the process spelled out, for the cases where the pid is
 * the only thread between a record and something that is running: the session
 * id on the line is one this record does not claim.
 */
function listedAs(sessionId: string, pid: number): AgentListing {
  return {
    kind: 'listed',
    agents: [
      {
        sessionId: SessionId.fromString(sessionId),
        pid,
        cwd: FOLDER,
        kind: 'interactive',
        startedAt: NOW - MINUTE_MS,
        name: null,
        status: null,
      },
    ],
    skipped: 0,
  };
}

/**
 * The record as the store hands it back when its `observed.json` is gone: the
 * snapshot is the codec's stand-in, and nobody observed any of it.
 *
 * Built by the real codec rather than assembled here, because the shape of the
 * stand-in is the codec's decision -- a copy of it in this file would agree
 * with it exactly until somebody changed one of the two.
 */
function afterTheCacheWasLost(entry: TerminalEntry): TerminalEntry {
  const decoded = decodeEntry(encodeRecord(entry), undefined);
  if (decoded.kind !== 'ok') {
    throw new Error(`the fixture did not survive its own codec: ${decoded.reason}`);
  }
  return decoded.entry;
}

/** A world in which the one entry below is restorable, so a test can spoil one thing. */
function inputsFor(
  entries: readonly TerminalEntry[],
  changes: Partial<RestoreInputs> = {}
): RestoreInputs {
  return {
    entries,
    windowFolders: [FOLDER],
    ownerLiveness: new Map([[GONE_OWNER, 'dead' as const]]),
    deadPids: new Set([CLAUDE_PID]),
    transcripts: transcriptsFor(SESSION_A, SESSION_B),
    agents: listing(),
    nowMs: NOW,
    uptimeSeconds: HOUR_SECONDS,
    ...changes,
  };
}

function refusals(plan: RestorePlan): readonly string[] {
  return plan.skipped.map((skip) => skip.reason);
}

describe('deciding what this window may bring back by itself', () => {
  it('plans a dead window\'s terminal in this window\'s folder', () => {
    const entry = sketch({ revision: 7 });

    const plan = planRestore(inputsFor([entry]));

    expect(plan.skipped).toStrictEqual([]);
    expect(plan.steps).toStrictEqual([
      { entry, expectedRevision: 7, force: false, intent: 'resume' },
    ]);
  });

  it('carries the revision the decision was made on, for the adoption to compare', () => {
    // The plan is a snapshot. Between planning and execution another window may
    // adopt the same record, and the compare-and-swap is what must fail then --
    // it cannot if the orchestrator re-reads the entry for a fresher number.
    const plan = planRestore(inputsFor([sketch({ revision: 3 })]));

    expect(plan.steps[0]?.expectedRevision).toBe(3);
  });

  it('plans nothing out of nothing', () => {
    expect(planRestore(inputsFor([]))).toStrictEqual({ steps: [], skipped: [] });
  });

  it('keeps the order the records arrived in, so two runs agree', () => {
    const first = sketch({ terminalId: TERMINAL_A, sessionId: SESSION_A });
    const second = sketch({ terminalId: TERMINAL_B, sessionId: SESSION_B });

    const plan = planRestore(inputsFor([first, second]));

    expect(plan.steps.map((step) => step.entry.terminalId.value)).toStrictEqual([
      TERMINAL_A,
      TERMINAL_B,
    ]);
  });
});

describe('the records this window must not touch', () => {
  it('leaves alone what a person closed', () => {
    const plan = planRestore(inputsFor([sketch({ closedAt: new Date(NOW - MINUTE_MS) })]));

    expect(refusals(plan)).toStrictEqual(['closed']);
  });

  it('leaves alone a living window\'s terminals', () => {
    const plan = planRestore(
      inputsFor([sketch()], { ownerLiveness: new Map([[GONE_OWNER, 'live']]) })
    );

    expect(refusals(plan)).toStrictEqual(['owner-live']);
  });

  it('leaves alone a window that is there and silent', () => {
    // `unknown` is a window asleep or stalled, not a window gone -- the whole
    // reason liveness has three values. Only an explicit adoption passes here.
    const plan = planRestore(
      inputsFor([sketch()], { ownerLiveness: new Map([[GONE_OWNER, 'unknown']]) })
    );

    expect(refusals(plan)).toStrictEqual(['owner-unknown']);
  });

  it('reads an owner nobody answered about as unknown, never as dead', () => {
    const plan = planRestore(inputsFor([sketch()], { ownerLiveness: new Map() }));

    expect(refusals(plan)).toStrictEqual(['owner-unknown']);
  });

  it('refuses another project\'s terminal even when every owner is dead', () => {
    // Defect G1, which is why the predicate exists: after a machine restart all
    // owners are dead, and without the folder the first window to activate
    // adopts another project's terminals while its own window opens empty.
    const plan = planRestore(inputsFor([sketch({ folder: 'D:/Projects/other' })]));

    expect(refusals(plan)).toStrictEqual(['foreign-folder']);
  });
});

describe('matching the folder as a person spelled it', () => {
  it('accepts the same windows folder written with other separators and case', () => {
    const plan = planRestore(
      inputsFor([sketch({ folder: 'd:\\projects\\FOO\\' })], { windowFolders: ['D:/Projects/foo'] })
    );

    expect(plan.steps).toHaveLength(1);
  });

  it('keeps two posix folders that differ only in case apart', () => {
    // On a case-sensitive file system those are two directories, and folding
    // them would be the G1 mistake with a different spelling.
    const plan = planRestore(
      inputsFor([sketch({ folder: '/home/person/Work' })], { windowFolders: ['/home/person/work'] })
    );

    expect(refusals(plan)).toStrictEqual(['foreign-folder']);
  });

  it('accepts the same posix folder with a trailing separator', () => {
    const plan = planRestore(
      inputsFor([sketch({ folder: '/home/person/work/' })], { windowFolders: ['/home/person/work'] })
    );

    expect(plan.steps).toHaveLength(1);
  });

  it('gives a record with no folder to the window with no folders', () => {
    const plan = planRestore(inputsFor([sketch({ folder: null })], { windowFolders: [] }));

    expect(plan.steps).toHaveLength(1);
  });

  it('does not give a record with no folder to a window that has one', () => {
    const plan = planRestore(inputsFor([sketch({ folder: null })]));

    expect(refusals(plan)).toStrictEqual(['foreign-folder']);
  });

  it('does not give a folder\'s record to a window with no folders open', () => {
    const plan = planRestore(inputsFor([sketch()], { windowFolders: [] }));

    expect(refusals(plan)).toStrictEqual(['foreign-folder']);
  });

  it('matches any of the folders of a multi-root window', () => {
    const plan = planRestore(
      inputsFor([sketch()], { windowFolders: ['D:/Projects/other', FOLDER] })
    );

    expect(plan.steps).toHaveLength(1);
  });
});

describe('establishing that the conversation is not running', () => {
  it('refuses while the pid still answers', () => {
    const plan = planRestore(inputsFor([sketch()], { deadPids: new Set() }));

    expect(refusals(plan)).toStrictEqual(['session-running']);
  });

  /*
   * **The owner, 2026-08-23, and it cost them every conversation they had.**
   * Two records with real conversations behind them would not come back after a
   * restart, over and over. Run offline against their own store, this planner
   * answered `session-running` for both: their state was `ended` -- the editor
   * had destroyed the terminal and said so -- and their pid was `null`, which
   * the rule below read as "no evidence, so it may be running".
   *
   * And it could not resolve itself: nothing started them, so nothing wrote a
   * pid, so the next window refused them for the same reason. The only way out
   * was a reboot, which is what `precedesBoot` had been quietly providing until
   * a machine stayed up.
   */
  it('takes a witnessed end as the evidence it is, whatever the pid says', () => {
    const plan = planRestore(inputsFor([sketch({ state: 'ended', pid: null })]));

    expect(refusals(plan)).toStrictEqual([]);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.intent).toBe('resume');
  });

  it('takes a failed restore the same way: the process it names is gone', () => {
    const plan = planRestore(
      inputsFor([sketch({ state: 'resume_failed', pid: null })], { deadPids: new Set() })
    );

    expect(refusals(plan)).toStrictEqual([]);
  });

  it('still refuses a record that only LOOKS finished, and says which refusal that is', () => {
    // `orphaned` is this build's own inference from a pid lookup and `degraded`
    // from a timeout. Neither is first-hand, so neither may outrank the pid --
    // and the answer now says whether there was a pid there to outrank.
    expect(refusals(planRestore(inputsFor([sketch({ state: 'orphaned' })], { deadPids: new Set() }))))
      .toStrictEqual(['session-running']);
    expect(refusals(planRestore(inputsFor([sketch({ state: 'degraded', pid: null })]))))
      .toStrictEqual(['session-unknown']);
  });

  it('lets the boot outrank the pid, because pids are handed out again', () => {
    // After a machine restart every stored pid is a number from a previous
    // life, and Windows hands them out again aggressively. Without this the
    // terminals of whichever pid a stranger now holds would never come back.
    const plan = planRestore(
      inputsFor([sketch({ lastEventAt: BEFORE_BOOT, pid: 31_337 })], { deadPids: new Set() })
    );

    expect(plan.steps).toHaveLength(1);
  });

  it('refuses everything when the CLI could not be asked what is running', () => {
    // Measured A22 §1: an idle interactive session does not appear in the
    // listing at all for a minute, so silence is not permission -- and a
    // listing that failed is not silence either.
    const plan = planRestore(
      inputsFor([sketch()], { agents: { kind: 'unavailable', reason: 'spawn claude ENOENT' } })
    );

    expect(refusals(plan)).toStrictEqual(['agents-unavailable']);
  });

  it('refuses a conversation the CLI says it is running', () => {
    const plan = planRestore(inputsFor([sketch()], { agents: listing(SESSION_A) }));

    expect(refusals(plan)).toStrictEqual(['session-listed']);
  });

  it('refuses when the CLI names an id this terminal used before', () => {
    // Something is running an id we handed out. Whatever it is, it is not ours
    // to resume over.
    const plan = planRestore(
      inputsFor([sketch({ history: [SESSION_PAST] })], { agents: listing(SESSION_PAST) })
    );

    expect(refusals(plan)).toStrictEqual(['session-listed']);
  });

  it('is not troubled by somebody else\'s conversation in the listing', () => {
    const plan = planRestore(inputsFor([sketch()], { agents: listing(SESSION_B) }));

    expect(plan.steps).toHaveLength(1);
  });

  it('reports a running conversation as running even when it has no transcript', () => {
    // The reason order matters here, not just the verdict: "no transcript"
    // becomes an offer to start over (M2.13), and offering that on a live
    // conversation is the mistake this function exists to prevent.
    const plan = planRestore(
      inputsFor([sketch()], { deadPids: new Set(), transcripts: transcriptsFor() })
    );

    expect(refusals(plan)).toStrictEqual(['session-running']);
  });
});

/*
 * **The second witness, and why `witnessed-end` needed one (Ш7б).**
 *
 * `witnessed-end` is first-hand and it is also PAST: `SessionEnd` arrived once,
 * or the editor destroyed a terminal object once. Nothing in it is a statement
 * about now. The machine's own list of what it is running IS about now, it has
 * been in `RestoreInputs` since the beginning, and the pid on every line of it
 * was read by nobody -- the planner reduced the listing to a set of session ids
 * and threw the processes away.
 *
 * That gap has a name in the register of open questions since 2026-08-23: the
 * risk of a double `--resume` from `isWitnessedEnd`. These are the cases where
 * the session id cannot close it, because the ids do not match and the pid is
 * the only thread between the record and the process that is up.
 */
describe('the second witness: what the machine says it is running NOW', () => {
  it('does not resume a witnessed end whose process the CLI still has up', () => {
    // The record's own evidence is an end, and it is honest evidence. But the
    // CLI names a live `claude` at the very pid this record was running as,
    // under an id we do not recognise -- a conversation that rotated its id, or
    // a session file we cannot match. Either reading says something is on that
    // process, and `--resume` here is the second one.
    const entry = sketch({ state: 'ended' });
    const world = inputsFor([entry], { agents: listedAs(SESSION_B, CLAUDE_PID) });

    const plan = planRestore(world);

    expect(plan.steps).toStrictEqual([]);
    expect(refusals(plan)).toStrictEqual(['process-listed']);
  });

  it('says it again next window, and lets go the moment the process does', () => {
    // The cycle, before the table states it: refusing starts nothing, so the
    // world the next window reads is this one. What lifts it is the process
    // leaving the CLI's list, which nobody has to resume anything to bring
    // about.
    const entry = sketch({ state: 'ended' });
    const listed = inputsFor([entry], { agents: listedAs(SESSION_B, CLAUDE_PID) });

    expect(refusals(planRestore(listed))).toStrictEqual(['process-listed']);
    expect(refusals(planRestore(listed))).toStrictEqual(['process-listed']);
    expect(planRestore(inputsFor([entry], { agents: listing() })).steps).toHaveLength(1);
  });

  it('is not troubled by a process that is nothing to do with this record', () => {
    const entry = sketch({ state: 'ended' });

    expect(planRestore(inputsFor([entry], { agents: listedAs(SESSION_B, 31_337) })).steps)
      .toHaveLength(1);
  });

  it('has nothing to say about a record that never named a process', () => {
    // The pid is the whole of the link. A record with none cannot be tied to
    // any line of the listing, and what it is refused for -- or not refused for
    // -- is settled elsewhere.
    const entry = sketch({ state: 'ended', pid: null });

    expect(refusals(planRestore(inputsFor([entry], { agents: listedAs(SESSION_B, CLAUDE_PID) }))))
      .toStrictEqual([]);
  });
});

/*
 * **A snapshot nobody observed, read as a sign of life (defect 8).**
 *
 * When `observed.json` is gone the codec stands one up so the record is not
 * lost with its cache: `degraded`, no pid, and `lastEventAt` set to the
 * record's own creation time -- which is the only honest stamp available and is
 * not a sign of life at all. Downstream reads that field as evidence, and the
 * boot rule reads a creation time from before this boot as "it describes a
 * previous life" and lets the record through.
 *
 * So a terminal made three days ago, busy five minutes ago, whose cache we lost
 * is resumed on the strength of a timestamp we invented. `remove()` manufactures
 * exactly this shape out of a record a person asked to delete.
 */
describe('a snapshot the store invented after losing its cache', () => {
  it('is not read as a sign of life, however old the record it was made from', () => {
    const invented = afterTheCacheWasLost(sketch());

    // What the codec stands up, spelled out so that the case below is about
    // this shape and not about a state a test happened to choose.
    expect(invented.observed.state).toBe('degraded');
    expect(invented.observed.pid).toBeNull();
    expect(invented.observed.lastEventAt.getTime()).toBeLessThan(NOW - HOUR_SECONDS * 1000);

    const plan = planRestore(inputsFor([invented]));

    expect(plan.steps).toStrictEqual([]);
    expect(refusals(plan)).toStrictEqual(['session-unknown']);
  });

  it('leaves a snapshot somebody did observe exactly where it was', () => {
    // The boot rule is untouched: a record whose OWN last event predates this
    // boot still comes back, which is the common case after a restart and the
    // reason that rule exists.
    const observed = sketch({ lastEventAt: BEFORE_BOOT, pid: 31_337 });

    expect(planRestore(inputsFor([observed], { deadPids: new Set() })).steps).toHaveLength(1);
  });
});

/*
 * **The promise this step was made under, as something a machine checks.**
 *
 * Ш7б was allowed into the irreversible zone on one undertaking: no edit in it
 * gives `--resume` MORE cases than it had, only fewer or the same. That is a
 * statement about every world at once, so a handful of examples cannot carry
 * it and an argument in a comment carries it even less.
 *
 * It is checkable because the step added exactly TWO signals to what the
 * planner reads, and both are new: the pid on each line of the CLI's listing,
 * and the mark on a snapshot that says the store invented it rather than
 * observed it. Strike those two out of a world and what is left is precisely
 * the world the planner of Ш7а saw -- verified by reading that version: the
 * only `pid` it touched was `observed.pid`, and `provenance` did not exist.
 *
 * So: over a space built by turning every knob that reaches these rules, every
 * start this planner makes must also be a start the blinded one makes. Fewer
 * or the same, per world, never more.
 */
describe('the second witness may only ever forbid', () => {
  /** The same record with its snapshot presented as one somebody observed. */
  function seenRatherThanInvented(entry: TerminalEntry): TerminalEntry {
    return makeEntry({
      terminalId: entry.terminalId,
      sessionId: entry.sessionId,
      sessionIdHistory: entry.sessionIdHistory,
      owner: entry.owner,
      metadata: entry.metadata,
      launch: entry.launch,
      observed: ObservedState.create({
        state: entry.observed.state,
        lastEventAt: entry.observed.lastEventAt,
        currentTool: entry.observed.currentTool,
        lastAssistantMessage: entry.observed.lastAssistantMessage,
        cost: entry.observed.cost,
        contextWindow: entry.observed.contextWindow,
        pid: entry.observed.pid,
        running: entry.observed.running,
      }),
      engine: entry.engine,
      order: entry.order,
      createdAt: entry.createdAt,
      closedAt: entry.closedAt,
      closedBy: entry.closedBy,
      revision: entry.revision,
    });
  }

  /** The world with both new signals taken out of it, and nothing else moved. */
  function blinded(world: RestoreInputs): RestoreInputs {
    return {
      ...world,
      entries: world.entries.map(seenRatherThanInvented),
      agents:
        world.agents.kind === 'listed'
          ? { ...world.agents, agents: world.agents.agents.map((one) => ({ ...one, pid: null })) }
          : world.agents,
    };
  }

  /** What came back as a start, as something two plans can be compared by. */
  function started(plan: RestorePlan): readonly string[] {
    return plan.steps.map((step) => `${step.entry.terminalId.value}:${step.intent}`);
  }

  const PIDS: readonly (number | null)[] = [null, CLAUDE_PID, 31_337];
  const LISTINGS: readonly AgentListing[] = [
    listing(),
    listing(SESSION_A),
    listedAs(SESSION_B, CLAUDE_PID),
    listedAs(SESSION_A, CLAUDE_PID),
    listedAs(SESSION_B, 31_337),
    { kind: 'unavailable', reason: 'spawn claude ENOENT' },
  ];

  /*
   * Every state this build can write, so a state added later joins the check
   * without anybody remembering to add it; both sides of the boot; a pid held
   * dead and a pid held by nothing; a conversation with a transcript and
   * without; the automatic plan and the one a person asked for by name; and the
   * record as the store hands it back both when its cache survived and when it
   * did not.
   */
  const WORLDS: readonly RestoreInputs[] = PERSISTED_TERMINAL_STATES.flatMap((state) =>
    PIDS.flatMap((pid) =>
      [SINCE_BOOT, BEFORE_BOOT].flatMap((lastEventAt) =>
        [new Set<number>(), new Set([CLAUDE_PID])].flatMap((deadPids) =>
          LISTINGS.flatMap((agents) =>
            [transcriptsFor(SESSION_A), transcriptsFor()].flatMap((transcripts) =>
              [false, true].flatMap((cacheLost) =>
                [null, TerminalId.fromString(TERMINAL_A)].map((demanded) => {
                  const record = sketch({ state, pid, lastEventAt });
                  return inputsFor([cacheLost ? afterTheCacheWasLost(record) : record], {
                    deadPids,
                    agents,
                    transcripts,
                    demanded,
                  });
                })
              )
            )
          )
        )
      )
    )
  );

  it('starts nothing the same world would not start with those two signals struck out', () => {
    const widened = WORLDS.filter((world) => {
      const now = started(planRestore(world));
      const before = new Set(started(planRestore(blinded(world))));
      return now.some((step) => !before.has(step));
    });

    expect(widened).toStrictEqual([]);
  });

  it('says start about no record the same world blinded would refuse', () => {
    // The row's own green button (M2.23) reads the same rules, so the promise
    // has to hold on that path too or it holds on neither.
    const widened = WORLDS.filter((world) => {
      const [entry] = world.entries;
      if (entry === undefined) {
        return false;
      }
      const [blindEntry] = blinded(world).entries;
      return (
        resumeIntent(entry, world).kind === 'start' &&
        blindEntry !== undefined &&
        resumeIntent(blindEntry, blinded(world)).kind !== 'start'
      );
    });

    expect(widened).toStrictEqual([]);
  });

  it('is checked over a space that reaches the new rules at all', () => {
    // A subset claim is true of a change that does nothing, so the space has to
    // be shown to contain worlds the two answer differently -- otherwise this
    // whole describe is a green light for an untested rule.
    const narrowed = WORLDS.filter(
      (world) => started(planRestore(world)).length < started(planRestore(blinded(world))).length
    );

    expect(narrowed.length).toBeGreaterThan(0);
  });
});

/*
 * **The trap of this step, executed rather than described.**
 *
 * A refusal is not a fault. Every one of them is an ordinary state of the world
 * that can change, and the plan carries one per record precisely so that a
 * person asking "why is my terminal not back" gets a sentence. What turns one
 * into a TRAP is a refusal whose only way out is the very start it forbids:
 * refuse, nobody starts it, nothing is learned, refuse again -- and that shape
 * cannot be seen in a table of refusals, because every row of such a table
 * reads perfectly reasonably on its own.
 *
 * **Measured against the owner's own store, 2026-08-23, and it cost them every
 * conversation they had.** Two records with real conversations behind them
 * would not come back after a restart. Run offline over that store, this
 * planner answered `session-running` for both -- a sentence that claims
 * something about a process -- while what it held was NOTHING: their pid was
 * `null`, and writing a pid is what starting them would have done. The only way
 * out was a reboot.
 */
describe('the loop a refusal can leave a record in', () => {
  /** Nothing is known about it: no pid was ever written down, and no end was witnessed. */
  function stranded(): TerminalEntry {
    return sketch({ pid: null, state: 'idle' });
  }

  it('does not answer "a pid we hold" and "no pid at all" with one word', () => {
    // The FORM of the defect and not an instance of it. A predicate that
    // answers yes or no cannot separate "there is evidence a process may still
    // be there" from "there is no evidence at all", so it reports the second as
    // the first -- and the first is a claim about a process nobody established.
    const holdingAPid = refusals(planRestore(inputsFor([sketch()], { deadPids: new Set() })));
    const holdingNothing = refusals(planRestore(inputsFor([stranded()])));

    expect(holdingAPid).toStrictEqual(['session-running']);
    expect(holdingNothing).not.toStrictEqual(holdingAPid);
  });

  it('refuses for want of evidence, says which it is, and says it again next window', () => {
    const world = inputsFor([stranded()]);

    // Window 1 opens, plans and refuses. Refusing starts nothing, so nothing
    // writes a pid and nothing changes the record -- the world window 2 reads
    // is this one, and so is the world window 3 reads. That is the loop, and it
    // is not a defect by itself: what the reason has to do is say that nothing
    // was established, so a reader can tell it from a process still going.
    const first = planRestore(world);
    const second = planRestore(world);
    const third = planRestore(world);

    expect(first.steps).toStrictEqual([]);
    expect(refusals(first)).toStrictEqual(['session-unknown']);
    expect(refusals(second)).toStrictEqual(refusals(first));
    expect(refusals(third)).toStrictEqual(refusals(first));
  });

  it('leaves it a way out that nobody has to start it to take', () => {
    // The escape has to be able to ARRIVE: `SessionEnd`, or the editor
    // destroying the terminal object, both of which reach the record without
    // anybody resuming its conversation first.
    const witnessed = sketch({ pid: null, state: 'ended' });

    expect(planRestore(inputsFor([witnessed])).steps).toHaveLength(1);
  });
});

/** Who or what can bring a refusal's escape about while the record is still refused. */
type EscapeComesFrom =
  /** The editor, the CLI or the machine. It arrives without anybody asking for it. */
  | 'the world'
  /** The person in front of the row: reopen it, open its project, ask for it by name. */
  | 'a person'
  /**
   * Nothing but the start this very refusal forbids. That is a LOOP, and this
   * value exists so that the case has a name -- a row in that state reads
   * exactly like the others, which is how one lived here unnoticed.
   */
  | 'only the start it refuses';

interface RefusalCase {
  /** Which question this row answers: this window's, or the one every window would give (M2.15). */
  readonly asked: (situation: RestoreInputs) => RestoreRefusal | null;
  /** A world whose record gets exactly this refusal. */
  readonly world: RestoreInputs;
  /** What has to become true out there before the record can come back. */
  readonly escape: string;
  /** `world` with `escape` true and nothing else moved. */
  readonly escaped: RestoreInputs;
  readonly escapeComesFrom: EscapeComesFrom;
}

/*
 * **Every refusal, the change that lifts it, and the loop run over each row.**
 *
 * Keyed by the union, so a refusal added tomorrow cannot arrive without an
 * answer to "what has to change before this record comes back". That question is
 * the oracle: a refusal with no answer to it is not a refusal but a wall.
 *
 * **`escapeComesFrom` is a declaration and not a measurement**, and saying so is
 * the point of writing it down. Nothing here can compute who brings a change
 * about; what the column does is make whoever adds a refusal answer the question
 * where a reader sees it, and `only the start it refuses` is then refused out
 * loud instead of going unnoticed. The measured half is the loop beside it.
 */
describe('every refusal, and what has to change before the record comes back', () => {
  /** What THIS window answers about the first record: its refusal, or nothing to say. */
  function thisWindow(situation: RestoreInputs): RestoreRefusal | null {
    return planRestore(situation).skipped.at(0)?.reason ?? null;
  }

  /** What NOBODY could do with it: the same rules with "which window is asking" taken out (M2.15). */
  function everyWindow(situation: RestoreInputs): RestoreRefusal | null {
    const [entry] = situation.entries;
    if (entry === undefined) {
      throw new Error('a refusal is an answer about a record, and this world has none');
    }
    return refusalAnywhere(entry, situation);
  }

  const A_MINUTE_AGO = new Date(NOW - MINUTE_MS);
  const ELSEWHERE = 'D:/Projects/elsewhere';
  const TWIN = sketch({ terminalId: TERMINAL_B });

  const TABLE: Readonly<Record<RestoreRefusal, RefusalCase>> = {
    'closed': {
      asked: everyWindow,
      world: inputsFor([sketch({ closedAt: A_MINUTE_AGO })]),
      escape: 'the person who closed it takes that back, in front of a dialog naming what they are reversing',
      escaped: inputsFor([sketch({ closedAt: null })]),
      escapeComesFrom: 'a person',
    },
    'owner-live': {
      asked: everyWindow,
      world: inputsFor([sketch()], { ownerLiveness: new Map([[GONE_OWNER, 'live' as const]]) }),
      escape: 'the window holding it goes away, by its goodbye or by a heartbeat that stops',
      escaped: inputsFor([sketch()], { ownerLiveness: new Map([[GONE_OWNER, 'dead' as const]]) }),
      escapeComesFrom: 'the world',
    },
    'owner-unknown': {
      asked: thisWindow,
      world: inputsFor([sketch()], { ownerLiveness: new Map([['another-window', 'dead' as const]]) }),
      escape: 'that window is established to be gone -- or a person asks for this record by name, which is what force means',
      escaped: inputsFor([sketch()], { ownerLiveness: new Map([[GONE_OWNER, 'dead' as const]]) }),
      escapeComesFrom: 'the world',
    },
    'foreign-folder': {
      asked: thisWindow,
      world: inputsFor([sketch({ folder: ELSEWHERE })]),
      escape: 'this window opens that project -- or a person asks for the record by name',
      escaped: inputsFor([sketch({ folder: ELSEWHERE })], { windowFolders: [ELSEWHERE] }),
      escapeComesFrom: 'a person',
    },
    'session-running': {
      asked: everyWindow,
      world: inputsFor([sketch()], { deadPids: new Set() }),
      escape: 'the pid the record names is established to be gone',
      escaped: inputsFor([sketch()], { deadPids: new Set([CLAUDE_PID]) }),
      escapeComesFrom: 'the world',
    },
    'session-unknown': {
      asked: everyWindow,
      world: inputsFor([sketch({ pid: null })]),
      escape: 'a first-hand end reaches the record: SessionEnd, or the editor destroying its terminal',
      escaped: inputsFor([sketch({ pid: null, state: 'ended' })]),
      escapeComesFrom: 'the world',
    },
    'session-listed': {
      asked: everyWindow,
      world: inputsFor([sketch()], { agents: listing(SESSION_A) }),
      escape: 'the CLI stops naming that conversation among the ones it is running',
      escaped: inputsFor([sketch()], { agents: listing() }),
      escapeComesFrom: 'the world',
    },
    'process-listed': {
      asked: everyWindow,
      world: inputsFor([sketch({ state: 'ended' })], { agents: listedAs(SESSION_B, CLAUDE_PID) }),
      escape: 'the process the record was running as leaves the list of what the CLI has up, which happens when it exits',
      escaped: inputsFor([sketch({ state: 'ended' })], { agents: listedAs(SESSION_B, 31_337) }),
      escapeComesFrom: 'the world',
    },
    'agents-unavailable': {
      asked: everyWindow,
      world: inputsFor([sketch()], { agents: { kind: 'unavailable', reason: 'spawn claude ENOENT' } }),
      escape: 'the CLI can be asked what it is running again',
      escaped: inputsFor([sketch()], { agents: listing() }),
      escapeComesFrom: 'the world',
    },
    'transcripts-unavailable': {
      asked: everyWindow,
      world: inputsFor([sketch()], {
        transcripts: { kind: 'unavailable', reason: 'EPERM: operation not permitted, scandir' },
      }),
      escape: 'the conversations on disk can be listed again',
      escaped: inputsFor([sketch()], { transcripts: transcriptsFor(SESSION_A) }),
      escapeComesFrom: 'the world',
    },
    'no-transcript': {
      asked: everyWindow,
      world: inputsFor([sketch()], { transcripts: transcriptsFor() }),
      escape: 'anything at all is said in its conversation -- and this window opens the record with a NEW one rather than refusing it, so there is somewhere to say it (owner, 2026-08-21)',
      escaped: inputsFor([sketch()], { transcripts: transcriptsFor(SESSION_A) }),
      escapeComesFrom: 'a person',
    },
    'duplicate-session': {
      asked: thisWindow,
      world: inputsFor([sketch(), TWIN]),
      escape: 'one of the two records is deleted, so that a single record names that conversation',
      escaped: inputsFor([sketch()]),
      escapeComesFrom: 'a person',
    },
  };

  const ROWS = Object.keys(TABLE) as RestoreRefusal[];

  it('answers each refusal with a change of its own', () => {
    // A row copied from the one above it is a refusal nobody thought about, and
    // the escape is the sentence where that would show.
    expect(new Set(ROWS.map((reason) => TABLE[reason].escape)).size).toBe(ROWS.length);
  });

  it.each(ROWS)('%s is what the world it names answers', (reason) => {
    expect(TABLE[reason].asked(TABLE[reason].world)).toBe(reason);
  });

  it.each(ROWS)('%s: refused, nobody starts it, nothing is learned, refused again -- and then lifted', (reason) => {
    const row = TABLE[reason];

    // The loop, run. Window 1 refuses; refusing starts nothing and writes
    // nothing, so window 2 reads the same world and answers the same thing.
    expect(row.asked(row.world)).toBe(reason);
    expect(row.asked(row.world)).toBe(reason);

    // Which is harmless only because the loop has a door somebody else can
    // open. A refusal whose escape is the start it forbids is the trap this
    // table exists to make visible, and it is refused here rather than noted.
    expect(row.escapeComesFrom).not.toBe<EscapeComesFrom>('only the start it refuses');
    expect(row.asked(row.escaped)).not.toBe(reason);
  });
});

describe('establishing that there is something to resume', () => {
  it('starts a conversation nothing was ever said in again, rather than refusing it', () => {
    // Owner's decision, 2026-08-21: a terminal comes back even when its
    // conversation was never spoken in. It cannot come back the same way --
    // measured 2026-08-10 and again in A45, `--resume` on a conversation with no
    // transcript prints "No conversation found" and exits 1 -- so the record
    // comes back with a NEW conversation in it, name, task and notes included.
    //
    // The owner met this on 2026-08-21: four terminals opened, nothing typed
    // into any of them, the editor restarted, and their own log said
    // `records this window did not bring back, by reason {"no-transcript":4}`.
    const plan = planRestore(inputsFor([sketch()], { transcripts: transcriptsFor(SESSION_B) }));

    expect(refusals(plan)).toStrictEqual([]);
    expect(plan.steps.map((step) => step.intent)).toStrictEqual(['launch']);
  });

  it('never hands `no-transcript` to a caller, whoever asks and however they ask', () => {
    // **The measurement behind a deletion, 2026-08-27.** `planRestore` is the
    // only thing `adopt-terminal` reads a refusal out of, and `wayOut` -- the
    // sentence that tells a person what is left to do with a refused record --
    // carried a branch for `no-transcript`. It cannot fire. Both places that
    // push a skip here are past the `startsFresh` test, so a conversation with
    // no transcript leaves as a STEP with `launch` in it, never as a refusal.
    //
    // The value itself stays in the union and is NOT dead: `refusalAnywhere`
    // still answers it -- the table above asks for it through `everyWindow` for
    // exactly this reason -- and `cleanup-planner` reads it as `never-spoken`.
    // What died is the branch in the adapter, and that is all that was removed.
    const nothingSaid = inputsFor([sketch()], { transcripts: transcriptsFor() });
    const twoRecords = inputsFor([sketch(), sketch({ terminalId: TERMINAL_B })], {
      transcripts: transcriptsFor(),
    });

    for (const world of [nothingSaid, twoRecords]) {
      expect(refusals(planRestore(world))).not.toContain('no-transcript');
      // The demanded path too: `adopt-terminal` always asks by name, so it is
      // the ONE that reaches `wayOut`, and it must not be the exception.
      expect(refusals(planRestore({ ...world, demanded: TerminalId.fromString(TERMINAL_A) })))
        .not.toContain('no-transcript');
    }

    // And `refusalAnywhere`, the caller that DOES get it, still does -- or the
    // rule above would be passing because the refusal stopped existing.
    const [only] = nothingSaid.entries;
    expect(refusalAnywhere(only as TerminalEntry, nothingSaid)).toBe<RestoreRefusal>('no-transcript');
  });

  it('continues the conversation of a record that HAS one', () => {
    // The ordinary path, spelled next to the new one: a record whose transcript
    // is there is resumed, and nothing about this decision moved.
    expect(planRestore(inputsFor([sketch()])).steps.map((step) => step.intent)).toStrictEqual([
      'resume',
    ]);
  });

  it('refuses when the transcripts could not be listed at all', () => {
    const plan = planRestore(
      inputsFor([sketch()], {
        transcripts: { kind: 'unavailable', reason: 'EPERM: operation not permitted, scandir' },
      })
    );

    expect(refusals(plan)).toStrictEqual(['transcripts-unavailable']);
  });

  it('asks about the current id and not about the ones it drifted from', () => {
    // `/clear` starts a conversation with a new id, and the old transcript says
    // nothing about whether the new one can be resumed. The record still comes
    // back -- with a new conversation, as above.
    const plan = planRestore(
      inputsFor([sketch({ history: [SESSION_PAST] })], { transcripts: transcriptsFor(SESSION_PAST) })
    );

    expect(refusals(plan)).toStrictEqual([]);
    expect(plan.steps.map((step) => step.intent)).toStrictEqual(['launch']);
  });
});

describe('two records naming one conversation', () => {
  it('restores neither, because choosing between them is not a predicate\'s job', () => {
    // Resuming both is the interleaved-transcript failure itself, and picking
    // one is a judgement about whose notes are real.
    const first = sketch({ terminalId: TERMINAL_A, sessionId: SESSION_A });
    const second = sketch({ terminalId: TERMINAL_B, sessionId: SESSION_A });

    const plan = planRestore(inputsFor([first, second]));

    expect(plan.steps).toStrictEqual([]);
    expect(refusals(plan)).toStrictEqual(['duplicate-session', 'duplicate-session']);
  });

  it('still restores the one when the other was closed on purpose', () => {
    // A closed record will never be resumed by anybody, so it can never become
    // the second process on that conversation and it contests nothing.
    const closed = sketch({ terminalId: TERMINAL_B, sessionId: SESSION_A, closedAt: SINCE_BOOT });
    const live = sketch({ terminalId: TERMINAL_A, sessionId: SESSION_A });

    const plan = planRestore(inputsFor([closed, live]));

    expect(plan.steps.map((step) => step.entry.terminalId.value)).toStrictEqual([TERMINAL_A]);
    expect(refusals(plan)).toStrictEqual(['closed']);
  });

  it('counts a twin this window may not restore today, because tomorrow it may', () => {
    // The twin belongs to another project, so this window refuses it -- but its
    // own window will offer to bring it back, and the two would then be two
    // `claude --resume` on one transcript. Counting only today's candidates
    // made the rule mean "two restorable right now" rather than what it says.
    const elsewhere = sketch({
      terminalId: TERMINAL_B,
      sessionId: SESSION_A,
      folder: 'D:/Projects/other',
    });
    const here = sketch({ terminalId: TERMINAL_A, sessionId: SESSION_A });

    const plan = planRestore(inputsFor([elsewhere, here]));

    expect(plan.steps).toStrictEqual([]);
    expect(refusals(plan)).toStrictEqual(['foreign-folder', 'duplicate-session']);
  });
});

/*
 * The manual path (M2.14), and the reason it goes through the same predicate.
 *
 * A person looking at a row of another window's project can ask this window to
 * take it. That lifts exactly two rules -- the folder, because they are looking
 * at it and asking for it here, and a stale heartbeat, because `force` is the
 * person saying they have looked. It lifts nothing about the CONVERSATION: they
 * cannot see from a row whether a `claude` is running it, and that is the
 * mistake whose cost is an interleaved transcript.
 */
describe('a record a person asked this window to take', () => {
  const demand = (id: string): Partial<RestoreInputs> => ({ demanded: TerminalId.fromString(id) });

  it('takes another project\'s record when a person asks for it by name', () => {
    const entry = sketch({ folder: 'D:/Projects/other' });

    const plan = planRestore(inputsFor([entry], demand(TERMINAL_A)));

    expect(plan.steps.map((step) => step.entry.terminalId.value)).toStrictEqual([TERMINAL_A]);
  });

  it('takes a silent window\'s record, and says the adoption must force it', () => {
    // `AdoptOptions.force` is the only way past an owner the store calls
    // `unknown`, and nothing but a person's demand may set it.
    const plan = planRestore(
      inputsFor([sketch()], {
        ownerLiveness: new Map([[GONE_OWNER, 'unknown']]),
        ...demand(TERMINAL_A),
      })
    );

    expect(plan.steps.map((step) => step.force)).toStrictEqual([true]);
  });

  it('never forces an adoption nobody asked for', () => {
    expect(planRestore(inputsFor([sketch()])).steps.map((step) => step.force)).toStrictEqual([
      false,
    ]);
  });

  it('still refuses a record whose window is plainly running', () => {
    // The one refusal a demand may never lift: that window is there, it owns
    // the record, and it is the writer of it (§4.8).
    const plan = planRestore(
      inputsFor([sketch()], {
        ownerLiveness: new Map([[GONE_OWNER, 'live']]),
        ...demand(TERMINAL_A),
      })
    );

    expect(plan.steps).toStrictEqual([]);
    expect(refusals(plan)).toStrictEqual(['owner-live']);
  });

  it('speaks only about the record that was asked for', () => {
    // Otherwise one click would start every terminal the plan happened to
    // permit -- and the person asked for one row.
    const asked = sketch({ terminalId: TERMINAL_A, sessionId: SESSION_A });
    const other = sketch({ terminalId: TERMINAL_B, sessionId: SESSION_B });

    const plan = planRestore(inputsFor([asked, other], demand(TERMINAL_A)));

    expect(plan.steps.map((step) => step.entry.terminalId.value)).toStrictEqual([TERMINAL_A]);
    expect(plan.skipped).toStrictEqual([]);
  });

  it('answers about the record that was asked for even when it is refused', () => {
    const asked = sketch({ terminalId: TERMINAL_A, closedAt: SINCE_BOOT });
    const other = sketch({ terminalId: TERMINAL_B, sessionId: SESSION_B });

    const plan = planRestore(inputsFor([asked, other], demand(TERMINAL_A)));

    expect(plan.steps).toStrictEqual([]);
    expect(plan.skipped.map((skip) => skip.entry.terminalId.value)).toStrictEqual([TERMINAL_A]);
  });

  it('says nothing at all about a record that is no longer in the base', () => {
    const plan = planRestore(inputsFor([sketch({ terminalId: TERMINAL_B })], demand(TERMINAL_A)));

    expect(plan).toStrictEqual({ steps: [], skipped: [] });
  });

  it('still refuses a conversation the CLI says it is running', () => {
    const plan = planRestore(
      inputsFor([sketch({ folder: 'D:/Projects/other' })], {
        agents: listing(SESSION_A),
        ...demand(TERMINAL_A),
      })
    );

    expect(refusals(plan)).toStrictEqual(['session-listed']);
  });

  it('starts a demanded record over too, when its conversation was never spoken in', () => {
    const plan = planRestore(
      inputsFor([sketch()], { transcripts: transcriptsFor(SESSION_B), ...demand(TERMINAL_A) })
    );

    expect(refusals(plan)).toStrictEqual([]);
    expect(plan.steps.map((step) => step.intent)).toStrictEqual(['launch']);
  });

  it('still refuses when another record names the same conversation', () => {
    const twin = sketch({ terminalId: TERMINAL_B, sessionId: SESSION_A });
    const asked = sketch({ terminalId: TERMINAL_A, sessionId: SESSION_A });

    const plan = planRestore(inputsFor([twin, asked], demand(TERMINAL_A)));

    expect(refusals(plan)).toStrictEqual(['duplicate-session']);
  });
});

describe('explaining a refusal to the person who asked', () => {
  /*
   * A total record, so a refusal added to the union arrives here with a
   * sentence rather than on screen as an empty toast. The sentences are the
   * whole of what a person gets when the answer is no -- the reason lives per
   * record precisely so that "why is my terminal not back" has an answer.
   */
  const EVERY_REFUSAL: Readonly<Record<RestoreRefusal, true>> = {
    'closed': true,
    'owner-live': true,
    'owner-unknown': true,
    'foreign-folder': true,
    'session-running': true,
    'session-unknown': true,
    'session-listed': true,
    'process-listed': true,
    'agents-unavailable': true,
    'transcripts-unavailable': true,
    'no-transcript': true,
    'duplicate-session': true,
  };
  const REFUSALS = Object.keys(EVERY_REFUSAL) as RestoreRefusal[];

  it.each(REFUSALS)('gives %s a sentence', (reason) => {
    expect(explainRefusal(reason).length).toBeGreaterThan(0);
  });

  it('gives each one a sentence of its own', () => {
    // Two refusals sharing a sentence is a person sent to the wrong place.
    expect(new Set(REFUSALS.map(explainRefusal)).size).toBe(REFUSALS.length);
  });
});

/*
 * M2.23. The same predicate asked by the OWNER of a record rather than by a
 * window deciding what to adopt.
 *
 * The three refusals it drops are the three about ownership -- whose window
 * this is, whether that window answers, whose project it belongs to -- and
 * dropping them is not a relaxation: the asker IS that window, standing in that
 * project, with the row under their cursor. Everything that keeps a second
 * `claude --resume` off a live conversation stays, and stays in this function
 * rather than in a copy of it (О3).
 */
describe('a record its own window asks to resume', () => {
  /** Why it was refused, or `null` when it was not. */
  function refusedBecause(decision: ResumeDecision): RestoreRefusal | null {
    return decision.kind === 'refused' ? decision.reason : null;
  }

  it('is allowed when nothing says its conversation is running', () => {
    const entry = sketch();

    expect(resumeIntent(entry, inputsFor([entry]))).toStrictEqual<ResumeDecision>({
      kind: 'start',
      intent: 'resume',
    });
  });

  it('is allowed although its own window is the live owner', () => {
    // The refusal that exists to keep windows off each other's records, asked
    // of the one case where it means the opposite: this window holds it.
    const entry = sketch({ ownerId: 'this-very-window' });
    const world = inputsFor([entry], {
      ownerLiveness: new Map([['this-very-window', 'live' as const]]),
    });

    expect(planRestore(world).skipped.map((skip) => skip.reason)).toStrictEqual(['owner-live']);
    expect(refusedBecause(resumeIntent(entry, world))).toBeNull();
  });

  it('is allowed although the record belongs to another project', () => {
    // A person looking at the row is standing where they want it opened.
    const entry = sketch({ folder: 'D:/Projects/elsewhere' });

    expect(refusedBecause(resumeIntent(entry, inputsFor([entry])))).toBeNull();
  });

  it('refuses while our own evidence leaves its process possibly running', () => {
    const entry = sketch({ pid: 4242 });

    expect(refusedBecause(resumeIntent(entry, inputsFor([entry])))).toBe<RestoreRefusal>('session-running');
  });

  it('refuses while the CLI has its PROCESS up under a conversation we do not know', () => {
    // One rule asked twice must not give two answers (M2.23). The plan refuses
    // this record because the machine names a live `claude` at the pid it was
    // running as, and the row's own green button asks the very same question.
    const entry = sketch({ state: 'ended' });
    const world = inputsFor([entry], { agents: listedAs(SESSION_B, CLAUDE_PID) });

    expect(refusedBecause(resumeIntent(entry, world))).toBe('process-listed');
  });

  it('refuses while the CLI names its conversation among the running ones', () => {
    const entry = sketch();

    expect(
      refusedBecause(resumeIntent(entry, inputsFor([entry], { agents: listing(SESSION_A) })))
    ).toBe<RestoreRefusal>('session-listed');
  });

  it('refuses when the CLI could not be asked at all', () => {
    const entry = sketch();
    const world = inputsFor([entry], { agents: { kind: 'unavailable', reason: 'no claude' } });

    expect(refusedBecause(resumeIntent(entry, world))).toBe<RestoreRefusal>('agents-unavailable');
  });

  /*
   * The customer's second complaint, 2026-08-21: "если открыть новый терминал и
   * туда ничего не вводить и закрыть терминал принудительно, то это окно нельзя
   * восстановить через зелёную кнопку в treeview".
   *
   * They are right, and the answer was already decided -- for the other door.
   * The owner ruled on 2026-08-21 that a record nothing was said in comes back
   * with a NEW conversation ("нужно всегда восстанавливать окна, даже если в них
   * ничего не было сказано"), and `planRestore` has done exactly that since. The
   * button a person actually presses was left refusing, so the same record came
   * back by itself at the next start and would not come back when asked.
   */
  it('brings back a record nothing was ever said in, with a new conversation', () => {
    const entry = sketch({ sessionId: SESSION_B });
    const world = inputsFor([entry], { transcripts: transcriptsFor(SESSION_A) });

    expect(resumeIntent(entry, world)).toStrictEqual<ResumeDecision>({
      kind: 'start',
      intent: 'launch',
    });
  });

  it('answers a record nothing was said in exactly as the unasked plan does', () => {
    // THE INVARIANT: one rule, asked twice. A person pressing the button and a
    // window starting up must not disagree about the same record.
    const entry = sketch({ sessionId: SESSION_B });
    const world = inputsFor([entry], { transcripts: transcriptsFor(SESSION_A) });

    const planned = planRestore(world).steps;

    expect(planned.map((step) => step.intent)).toStrictEqual(['launch']);
    expect(resumeIntent(entry, world)).toStrictEqual<ResumeDecision>({
      kind: 'start',
      intent: 'launch',
    });
  });

  it('still refuses a record nothing was said in when another record claims its conversation', () => {
    // A fresh start would answer "which of these two is real" by accident, and
    // the answer belongs to a person.
    const mine = sketch({ sessionId: SESSION_B });
    const twin = sketch({ terminalId: TERMINAL_B, sessionId: SESSION_B });
    const world = inputsFor([mine, twin], { transcripts: transcriptsFor(SESSION_A) });

    expect(refusedBecause(resumeIntent(mine, world))).toBe<RestoreRefusal>('duplicate-session');
  });

  it('refuses when another record still claims the same conversation', () => {
    // Resuming both is the О3 violation itself, and which of the two is the
    // real one is a judgement for a person rather than for a predicate.
    const mine = sketch();
    const twin = sketch({ terminalId: TERMINAL_B });

    expect(refusedBecause(resumeIntent(mine, inputsFor([mine, twin])))).toBe<RestoreRefusal>('duplicate-session');
  });

  it('is not stopped by a twin that nobody can resume any more', () => {
    const mine = sketch();
    const closed = sketch({ terminalId: TERMINAL_B, closedAt: new Date(NOW - MINUTE_MS) });

    expect(refusedBecause(resumeIntent(mine, inputsFor([mine, closed])))).toBeNull();
  });

  it('says nothing about a record the person closed, because that is theirs to undo', () => {
    // `closed` is the one refusal that is about an INTENTION rather than about
    // the world, and an intention the same person may reverse -- in front of a
    // dialog that says what they are reversing. So it is not answered here:
    // this function is about whether the conversation may be started at all.
    const entry = sketch({ closedAt: new Date(NOW - MINUTE_MS) });

    expect(refusedBecause(resumeIntent(entry, inputsFor([entry])))).toBeNull();
  });
});

/**
 * What a person is told when their terminals did not come back.
 *
 * The gap the owner met on 2026-08-21: four records were refused, the reason was
 * written to the log in the same second, and nothing reached the screen. From
 * the chair it read as "my terminals silently vanished". The refusals have had a
 * sentence apiece since M2.14 -- they simply were not said out loud unless the
 * person went and ASKED, through Adopt or Resume.
 *
 * Three refusals stay quiet, and none of them is a slip. `foreign-folder` is
 * every terminal of every other project on the machine and would drown the
 * sentence that matters; `closed` is the person's own decision from an hour ago;
 * `owner-live` is a record another window is holding and showing right now.
 */
describe('telling a person which terminals did not come back', () => {
  const skip = (
    reason: RestoreRefusal,
    name = 'a terminal'
  ): { entry: TerminalEntry, reason: RestoreRefusal } => ({
    entry: makeEntry({ metadata: makeMetadata().withDisplayName(name) }),
    reason,
  });

  it('says nothing when nothing was refused', () => {
    expect(restoreNotice([])).toBeNull();
  });

  it.each<RestoreRefusal>(['foreign-folder', 'closed', 'owner-live'])(
    'says nothing about %s, which is a state the person made or is looking at',
    (reason) => {
      expect(restoreNotice([skip(reason)])).toBeNull();
    }
  );

  it('names the terminal when exactly one was refused', () => {
    const said = restoreNotice([skip('session-running', 'the one with the migration')]);

    expect(said).toContain('the one with the migration');
    expect(said).toContain(explainRefusal('session-running'));
  });

  it('counts them and gives each distinct reason once', () => {
    const said = restoreNotice([
      skip('session-running', 'first'),
      skip('session-running', 'second'),
      skip('duplicate-session', 'third'),
      // Quiet, and therefore not counted either: a count that included the other
      // project's terminals would be a number the person cannot act on.
      skip('foreign-folder', 'a terminal of another project'),
    ]);

    expect(said).toContain('3 terminals');
    expect(said).toContain(explainRefusal('session-running'));
    expect(said).toContain(explainRefusal('duplicate-session'));
    expect(said?.match(/has not been established to have stopped/gu)).toHaveLength(1);
  });
});
