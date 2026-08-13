import {
  ObservedState,
  OwnerId,
  OwnerRef,
  SessionId,
  TerminalId,
  explainRefusal,
  planRestore,
  resumeRefusal,
} from '../../packages/core/src/index';
import { makeEntry } from '../helpers/domain-fixtures';
import type {
  AgentListing,
  RestoreInputs,
  RestorePlan,
  RestoreRefusal,
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
      state: 'idle',
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
    expect(plan.steps).toStrictEqual([{ entry, expectedRevision: 7, force: false }]);
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

  it('refuses a record whose pid we never learned', () => {
    // No evidence either way, and the expensive mistake is one-sided.
    const plan = planRestore(inputsFor([sketch({ pid: null })]));

    expect(refusals(plan)).toStrictEqual(['session-running']);
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

describe('establishing that there is something to resume', () => {
  it('refuses a conversation nothing was ever said in', () => {
    // Measured 2026-08-10: a session with no prompt leaves no transcript, and
    // `--resume` on it exits 1 at once. Without this every restart would show a
    // batch of failures for terminals somebody opened and never typed into.
    const plan = planRestore(inputsFor([sketch()], { transcripts: transcriptsFor(SESSION_B) }));

    expect(refusals(plan)).toStrictEqual(['no-transcript']);
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
    // nothing about whether the new one can be resumed.
    const plan = planRestore(
      inputsFor([sketch({ history: [SESSION_PAST] })], { transcripts: transcriptsFor(SESSION_PAST) })
    );

    expect(refusals(plan)).toStrictEqual(['no-transcript']);
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

  it('still refuses a conversation nothing was ever said in', () => {
    const plan = planRestore(
      inputsFor([sketch()], { transcripts: transcriptsFor(SESSION_B), ...demand(TERMINAL_A) })
    );

    expect(refusals(plan)).toStrictEqual(['no-transcript']);
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
    'session-listed': true,
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
  it('is allowed when nothing says its conversation is running', () => {
    const entry = sketch();

    expect(resumeRefusal(entry, inputsFor([entry]))).toBeNull();
  });

  it('is allowed although its own window is the live owner', () => {
    // The refusal that exists to keep windows off each other's records, asked
    // of the one case where it means the opposite: this window holds it.
    const entry = sketch({ ownerId: 'this-very-window' });
    const world = inputsFor([entry], {
      ownerLiveness: new Map([['this-very-window', 'live' as const]]),
    });

    expect(planRestore(world).skipped.map((skip) => skip.reason)).toStrictEqual(['owner-live']);
    expect(resumeRefusal(entry, world)).toBeNull();
  });

  it('is allowed although the record belongs to another project', () => {
    // A person looking at the row is standing where they want it opened.
    const entry = sketch({ folder: 'D:/Projects/elsewhere' });

    expect(resumeRefusal(entry, inputsFor([entry]))).toBeNull();
  });

  it('refuses while our own evidence leaves its process possibly running', () => {
    const entry = sketch({ pid: 4242 });

    expect(resumeRefusal(entry, inputsFor([entry]))).toBe<RestoreRefusal>('session-running');
  });

  it('refuses while the CLI names its conversation among the running ones', () => {
    const entry = sketch();

    expect(resumeRefusal(entry, inputsFor([entry], { agents: listing(SESSION_A) }))).toBe<RestoreRefusal>(
      'session-listed'
    );
  });

  it('refuses when the CLI could not be asked at all', () => {
    const entry = sketch();
    const world = inputsFor([entry], { agents: { kind: 'unavailable', reason: 'no claude' } });

    expect(resumeRefusal(entry, world)).toBe<RestoreRefusal>('agents-unavailable');
  });

  it('refuses when nothing was ever said in the conversation', () => {
    const entry = sketch({ sessionId: SESSION_B });
    const world = inputsFor([entry], { transcripts: transcriptsFor(SESSION_A) });

    expect(resumeRefusal(entry, world)).toBe<RestoreRefusal>('no-transcript');
  });

  it('refuses when another record still claims the same conversation', () => {
    // Resuming both is the О3 violation itself, and which of the two is the
    // real one is a judgement for a person rather than for a predicate.
    const mine = sketch();
    const twin = sketch({ terminalId: TERMINAL_B });

    expect(resumeRefusal(mine, inputsFor([mine, twin]))).toBe<RestoreRefusal>('duplicate-session');
  });

  it('is not stopped by a twin that nobody can resume any more', () => {
    const mine = sketch();
    const closed = sketch({ terminalId: TERMINAL_B, closedAt: new Date(NOW - MINUTE_MS) });

    expect(resumeRefusal(mine, inputsFor([mine, closed]))).toBeNull();
  });

  it('says nothing about a record the person closed, because that is theirs to undo', () => {
    // `closed` is the one refusal that is about an INTENTION rather than about
    // the world, and an intention the same person may reverse -- in front of a
    // dialog that says what they are reversing. So it is not answered here:
    // this function is about whether the conversation may be started at all.
    const entry = sketch({ closedAt: new Date(NOW - MINUTE_MS) });

    expect(resumeRefusal(entry, inputsFor([entry]))).toBeNull();
  });
});
