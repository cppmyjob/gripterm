import {
  ObservedState,
  OwnerId,
  OwnerRef,
  SessionId,
  TerminalId,
  disposalOf,
  explainCleanup,
  planCleanup,
  planRestore,
  planUnaskedCleanup,
} from '../../packages/core/src/index';
import { makeEntry } from '../helpers/domain-fixtures';
import type {
  AgentListing,
  CleanupPlan,
  CleanupReason,
  ClosedBy,
  RestoreInputs,
  TerminalEntry,
  TranscriptIndex,
} from '../../packages/core/src/index';

const NOW = Date.parse('2026-08-13T12:00:00.000Z');
const HOUR_SECONDS = 3600;
const MINUTE_MS = 60_000;

/** This machine has been up an hour, so anything older than that is a previous life. */
const SINCE_BOOT = new Date(NOW - MINUTE_MS);

const TERMINAL_A = '11111111-1111-4111-8111-111111111111';
const TERMINAL_B = '22222222-2222-4222-8222-222222222222';
const SESSION_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SESSION_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

const GONE_OWNER = 'window-that-died';
const LIVE_OWNER = 'window-that-runs';
const CLAUDE_PID = 5150;
const FOLDER = 'D:/Projects/foo';
const OTHER_FOLDER = 'D:/Projects/bar';

interface Sketch {
  readonly terminalId?: string;
  readonly sessionId?: string;
  readonly ownerId?: string;
  readonly folder?: string | null;
  readonly pid?: number | null;
  readonly lastEventAt?: Date;
  readonly closedAt?: Date | null;
  /**
   * Which hand closed it, defaulting to the one every test here meant before
   * the two could be told apart: the person, through our own list.
   */
  readonly closedBy?: ClosedBy | null;
}

/** A record of a window that is gone, in this window's folder, spoken in. */
function sketch(options: Sketch = {}): TerminalEntry {
  return makeEntry({
    terminalId: TerminalId.fromString(options.terminalId ?? TERMINAL_A),
    sessionId: SessionId.fromString(options.sessionId ?? SESSION_A),
    sessionIdHistory: [],
    owner: OwnerRef.create({
      kind: 'window',
      ownerId: OwnerId.fromString(options.ownerId ?? GONE_OWNER),
      editorKind: 'vscode',
      workspaceFolder: options.folder === undefined ? FOLDER : options.folder,
    }),
    observed: ObservedState.create({
      state: 'idle',
      lastEventAt: options.lastEventAt ?? SINCE_BOOT,
      currentTool: null,
      lastAssistantMessage: null,
      cost: null,
      contextWindow: null,
      pid: options.pid === undefined ? CLAUDE_PID : options.pid,
    }),
    closedAt: options.closedAt ?? null,
    closedBy: options.closedBy === undefined ? 'person' : options.closedBy,
    revision: 0,
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
 * A world in which the entry below is RESTORABLE, so a test spoils one thing.
 *
 * The same starting point as the restore planner's own suite, deliberately: the
 * two predicates are read against one world here, and the invariant at the
 * bottom of this file is that they never both claim a record.
 */
function inputsFor(
  entries: readonly TerminalEntry[],
  changes: Partial<RestoreInputs> = {}
): RestoreInputs {
  return {
    entries,
    windowFolders: [FOLDER],
    ownerLiveness: new Map([
      [GONE_OWNER, 'dead' as const],
      [LIVE_OWNER, 'live' as const],
    ]),
    deadPids: new Set([CLAUDE_PID]),
    transcripts: transcriptsFor(SESSION_A, SESSION_B),
    agents: listing(),
    nowMs: NOW,
    uptimeSeconds: HOUR_SECONDS,
    ...changes,
  };
}

function swept(plan: CleanupPlan): readonly string[] {
  return plan.sweep.map((item) => `${item.entry.terminalId.value}:${item.reason}`);
}

describe('deciding what may be taken out of the store', () => {
  it('takes a closed record of a window that is gone', () => {
    const entry = sketch({ closedAt: new Date(NOW - MINUTE_MS) });

    const plan = planCleanup(inputsFor([entry]));

    expect(plan.sweep).toStrictEqual([{ entry, reason: 'closed' }]);
    expect(plan.kept).toBe(0);
  });

  it('takes a record nothing was ever said in, once its window is gone', () => {
    // The row that only ever refuses: no window may restore it (`--resume`
    // fails on a conversation with no transcript, measured 2026-08-10), no
    // demand lifts that refusal, and starting it over belongs to the window
    // that owns it -- which is not there.
    const entry = sketch({ sessionId: SESSION_B, terminalId: TERMINAL_B });

    const plan = planCleanup(inputsFor([entry], { transcripts: transcriptsFor(SESSION_A) }));

    expect(plan.sweep).toStrictEqual([{ entry, reason: 'never-spoken' }]);
  });

  it('leaves everything a window that is still there owns', () => {
    // The rule the milestone is measured by: cleaning up in one window must not
    // reach into the records another window is the writer of (§4.8).
    const closed = sketch({ ownerId: LIVE_OWNER, closedAt: new Date(NOW - MINUTE_MS) });
    const running = sketch({
      terminalId: TERMINAL_B,
      sessionId: SESSION_B,
      ownerId: LIVE_OWNER,
      pid: null,
    });

    const plan = planCleanup(inputsFor([closed, running]));

    expect(plan.sweep).toStrictEqual([]);
    expect(plan.kept).toBe(2);
  });

  it('leaves a closed record whose window has merely stopped answering', () => {
    // `unknown` is a window that is there and silent -- asleep, hung, stalled.
    // It may come back and go on writing that record.
    const entry = sketch({ ownerId: 'window-asleep', closedAt: new Date(NOW - MINUTE_MS) });

    expect(planCleanup(inputsFor([entry])).sweep).toStrictEqual([]);
  });

  it('leaves a record another window could still bring back', () => {
    // Its project is not open here, so THIS window may not restore it -- and
    // that is a fact about this window, not about the record. The window that
    // has that folder open would resume it, notes and task included.
    const entry = sketch({ folder: OTHER_FOLDER });

    const plan = planCleanup(inputsFor([entry]));

    expect(plan.sweep).toStrictEqual([]);
    expect(plan.kept).toBe(1);
  });

  it('takes a never-spoken record of a project this window does not have open', () => {
    // The cleanup asks what EVERY window would say, never what this one says.
    // A conversation nothing was ever said in cannot be resumed by the window
    // that has that folder open either -- so leaving it there would be a row
    // that refuses in every window on the machine, for ever.
    const entry = sketch({ sessionId: SESSION_B, folder: OTHER_FOLDER });

    const plan = planCleanup(inputsFor([entry], { transcripts: transcriptsFor(SESSION_A) }));

    expect(plan.sweep).toStrictEqual([{ entry, reason: 'never-spoken' }]);
  });

  it('leaves a record whose Claude Code process is not established to have stopped', () => {
    const entry = sketch({
      sessionId: SESSION_B,
      pid: 4242,
    });

    const plan = planCleanup(inputsFor([entry], { transcripts: transcriptsFor(SESSION_A) }));

    expect(plan.sweep).toStrictEqual([]);
  });

  it('leaves a record whose conversation Claude Code says it is running', () => {
    const entry = sketch({ sessionId: SESSION_B });

    const plan = planCleanup(
      inputsFor([entry], {
        transcripts: transcriptsFor(SESSION_A),
        agents: listing(SESSION_B),
      })
    );

    expect(plan.sweep).toStrictEqual([]);
  });

  it('takes nothing but closed records when Claude Code could not be asked', () => {
    // The same direction as the restore predicate: a question that could not be
    // asked keeps a record where it is. A CLOSED record is the exception and
    // not an oversight -- a person threw its terminal away, and no listing of
    // running conversations can make that untrue.
    const closed = sketch({ closedAt: new Date(NOW - MINUTE_MS) });
    const silent = sketch({ terminalId: TERMINAL_B, sessionId: SESSION_B });

    const plan = planCleanup(
      inputsFor([closed, silent], {
        transcripts: transcriptsFor(SESSION_A),
        agents: { kind: 'unavailable', reason: 'no claude on PATH' },
      })
    );

    expect(swept(plan)).toStrictEqual([`${TERMINAL_A}:closed`]);
    expect(plan.kept).toBe(1);
  });

  it('leaves a silent record when the transcripts could not be listed', () => {
    const entry = sketch({ sessionId: SESSION_B });

    const plan = planCleanup(
      inputsFor([entry], { transcripts: { kind: 'unavailable', reason: 'no home directory' } })
    );

    expect(plan.sweep).toStrictEqual([]);
  });

  it('keeps the order the records arrived in', () => {
    const first = sketch({ closedAt: new Date(NOW - MINUTE_MS) });
    const second = sketch({
      terminalId: TERMINAL_B,
      sessionId: SESSION_B,
      closedAt: new Date(NOW - MINUTE_MS),
    });

    expect(swept(planCleanup(inputsFor([second, first])))).toStrictEqual([
      `${TERMINAL_B}:closed`,
      `${TERMINAL_A}:closed`,
    ]);
  });

  it('plans nothing out of nothing', () => {
    expect(planCleanup(inputsFor([]))).toStrictEqual({ sweep: [], kept: 0 });
  });

  it('never takes a record it would also bring back', () => {
    // The invariant, stated once against a whole world rather than argued about
    // record by record: a record in both plans would be started by one window
    // while another moved its file away.
    const world = inputsFor([
      sketch({ closedAt: new Date(NOW - MINUTE_MS) }),
      sketch({ terminalId: TERMINAL_B, sessionId: SESSION_B }),
      sketch({
        terminalId: '33333333-3333-4333-8333-333333333333',
        sessionId: 'dddddddd-3333-4333-8333-dddddddddddd',
        folder: OTHER_FOLDER,
      }),
      sketch({
        terminalId: '44444444-4444-4444-8444-444444444444',
        sessionId: 'eeeeeeee-4444-4444-8444-eeeeeeeeeeee',
        ownerId: LIVE_OWNER,
      }),
    ]);

    const restored = new Set(planRestore(world).steps.map((step) => step.entry.terminalId.value));
    const cleaned = planCleanup(world).sweep.map((item) => item.entry.terminalId.value);

    expect(restored.size).toBeGreaterThan(0);
    expect(cleaned.filter((id) => restored.has(id))).toStrictEqual([]);
  });

  it('explains every reason it can give', () => {
    const reasons: readonly CleanupReason[] = ['closed', 'closed-in-the-editor', 'never-spoken'];

    for (const reason of reasons) {
      expect(explainCleanup(reason).length).toBeGreaterThan(0);
    }
  });
});

/*
 * What a window may take out of the store WITHOUT asking, which is the owner's
 * decision of 2026-08-13: "if a terminal was closed on purpose, we should forget
 * it".
 *
 * It is a subset of the same plan and not a second predicate, for the reason
 * M2.14 and M2.15 both give: two answers to "may this record be taken" drift
 * where nobody looks, and the drift is measured in files moved away from a
 * window that wanted them.
 */
describe('deciding what may be taken out of the store without asking', () => {
  it('forgets a record whose terminal a person closed, once its window is gone', () => {
    const entry = sketch({ closedAt: new Date(NOW - MINUTE_MS) });

    expect(planUnaskedCleanup(inputsFor([entry]))).toStrictEqual({
      sweep: [{ entry, reason: 'closed' }],
      kept: 0,
    });
  });

  it('leaves a record nothing was ever said in for a person to decide about', () => {
    // The other half of the manual cleanup, and the boundary between them is
    // the argument rather than the count. "Its terminal was closed" is
    // something the person did to that terminal; "nothing was ever said in it"
    // is a terminal they may have named, meant to come back to, and never got
    // to -- and taking that away unasked is taking away a decision.
    const entry = sketch({ sessionId: SESSION_B, terminalId: TERMINAL_B });
    const world = inputsFor([entry], { transcripts: transcriptsFor(SESSION_A) });

    expect(planCleanup(world).sweep).toStrictEqual([{ entry, reason: 'never-spoken' }]);
    expect(planUnaskedCleanup(world)).toStrictEqual({ sweep: [], kept: 1 });
  });

  it('counts what it left behind, whichever reason left it there', () => {
    const closed = sketch({ closedAt: new Date(NOW - MINUTE_MS) });
    const silent = sketch({ terminalId: TERMINAL_B, sessionId: SESSION_B });
    const running = sketch({
      terminalId: '44444444-4444-4444-8444-444444444444',
      sessionId: 'eeeeeeee-4444-4444-8444-eeeeeeeeeeee',
      ownerId: LIVE_OWNER,
    });
    const world = inputsFor([closed, silent, running], {
      transcripts: transcriptsFor(SESSION_A),
    });

    const plan = planUnaskedCleanup(world);

    expect(swept(plan)).toStrictEqual([`${TERMINAL_A}:closed`]);
    // Two: the one another window still owns, and the one a person has to be
    // asked about. A count that only knew the first would tell a person the
    // store is tidier than it is.
    expect(plan.kept).toBe(2);
  });

  it('leaves a closed record alone while the window that owns it is still there', () => {
    // Inherited from `planCleanup` rather than restated, and the test is here
    // because that inheritance is the whole safety of doing this unasked: a
    // record closed a second ago in THIS window is a row the person can still
    // read the journal of, start over from, or delete by hand. It is forgotten
    // when the window goes, and not before.
    const entry = sketch({ ownerId: LIVE_OWNER, closedAt: new Date(NOW - MINUTE_MS) });

    expect(planUnaskedCleanup(inputsFor([entry]))).toStrictEqual({ sweep: [], kept: 1 });
  });

  it('never forgets a record any window could still bring back', () => {
    // The same invariant the manual plan is held to, restated against the
    // automatic one because this is the plan nobody confirms.
    const world = inputsFor([
      sketch({ closedAt: new Date(NOW - MINUTE_MS) }),
      sketch({ terminalId: TERMINAL_B, sessionId: SESSION_B }),
      sketch({
        terminalId: '33333333-3333-4333-8333-333333333333',
        sessionId: 'dddddddd-3333-4333-8333-dddddddddddd',
        folder: OTHER_FOLDER,
      }),
    ]);

    const restored = new Set(planRestore(world).steps.map((step) => step.entry.terminalId.value));
    const forgotten = planUnaskedCleanup(world).sweep.map((item) => item.entry.terminalId.value);

    expect(restored.size).toBeGreaterThan(0);
    expect(forgotten.filter((id) => restored.has(id))).toStrictEqual([]);
  });

  /*
   * The owner's machine, 2026-08-24, measured rather than imagined: one
   * `workbench.action.closeAllEditors` -- a keystroke the editor documents as
   * tidying tabs -- stamped every conversation in the window "do not bring this
   * back", and the next activation moved all of them into the trash without
   * asking. The record stayed, in the trash, until the retention swept it or a
   * forward jump of the clock did; from the chair it was every conversation
   * gone for a keypress.
   *
   * Three of them here because one would pass on the old rule by accident: what
   * separates the two hands is not how many went at once -- there is no signal
   * for that, measured -- but which act the build actually witnessed.
   */
  it('leaves every conversation the editor took away, however many went at once', () => {
    const gesture = [
      sketch({ closedAt: new Date(NOW - MINUTE_MS), closedBy: 'editor' }),
      sketch({
        terminalId: TERMINAL_B,
        sessionId: SESSION_B,
        closedAt: new Date(NOW - MINUTE_MS),
        closedBy: 'editor',
      }),
    ];
    const world = inputsFor(gesture, { transcripts: transcriptsFor(SESSION_A, SESSION_B) });

    // A person who means it still reaches them, from the cleanup command.
    expect(planCleanup(world).sweep.map((item) => item.reason)).toStrictEqual([
      'closed-in-the-editor',
      'closed-in-the-editor',
    ]);
    // Nothing goes while nobody is looking.
    expect(planUnaskedCleanup(world)).toStrictEqual({ sweep: [], kept: 2 });
  });

  /*
   * And the records written before this build could tell the hands apart. There
   * is nothing on disk to read, so nothing here claims to know -- and the side
   * it falls to is the one whose mistake a person can undo.
   */
  it('leaves a record closed before this build could tell which hand did it', () => {
    const entry = sketch({ closedAt: new Date(NOW - MINUTE_MS), closedBy: null });

    expect(planUnaskedCleanup(inputsFor([entry]))).toStrictEqual({ sweep: [], kept: 1 });
  });

  it('plans nothing out of nothing', () => {
    expect(planUnaskedCleanup(inputsFor([]))).toStrictEqual({ sweep: [], kept: 0 });
  });
});

/*
 * M2.22. One record, in front of a person, with a menu open on it -- which is a
 * different question from the plan above and needs its own answer: the plan is
 * about what a WINDOW may sweep unasked, and this is about what a PERSON may
 * throw away with their own hand.
 *
 * It is here rather than beside the command for the reason §3.5 gives:
 * `packages/extension` is outside the coverage thresholds, and "whose record is
 * this window allowed to take away" is a rule, not plumbing.
 */
describe('disposalOf says whose record this is to throw away', () => {
  it('sends a record of this window through the lifecycle service', () => {
    // Ours: the service is what refuses while a process of ours is still behind
    // it, and it is the only thing that knows.
    expect(disposalOf(true, 'live')).toStrictEqual({ kind: 'ours' });
  });

  it('keeps this window off a record whose own window is answering for it', () => {
    // §4.8: that window is the single writer of this record, and it may be
    // resuming, renaming or closing it as this is read.
    expect(disposalOf(false, 'live')).toStrictEqual({ kind: 'owned-elsewhere' });
  });

  it('lets a person throw away a record whose window has gone', () => {
    expect(disposalOf(false, 'dead')).toStrictEqual({ kind: 'abandoned', liveness: 'dead' });
  });

  it('lets a person throw away a record whose window has stopped answering, and says which it is', () => {
    // The liveness travels with the answer because the dialog is where the
    // difference lives: a window that is merely silent may be asleep and come
    // back, and the person is the only one who can know.
    expect(disposalOf(false, 'unknown')).toStrictEqual({ kind: 'abandoned', liveness: 'unknown' });
  });
});
