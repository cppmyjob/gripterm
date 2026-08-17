import {
  TERMINAL_EXIT_CAUSES,
  exitVerdict,
  type TerminalExitCause,
  type TerminalExitReason,
} from '../../packages/core/src/index';

/**
 * The pair a record is written from, for an engine that has no editor to ask.
 *
 * Under `editor` the platform answers both fields itself, and A29 measured what
 * it answers for each act. Under `own` there is nobody to ask: node-pty reports
 * a number and possibly a signal, and the only thing that knows WHY the terminal
 * went away is the code that ended it. `exitVerdict` is that knowledge written
 * down, and it is the whole substance of M3.3.
 *
 * **The table below is total over its own inputs** -- three causes by four codes
 * by two signals -- because the rows that matter are the ones nobody would think
 * to write by hand. Measured 2026-08-17 (M3.2 stage B, §2): under `kill()`
 * `claude` exits with 1, `powershell` and `cmd` with -1073741510. The code says
 * WHICH PROGRAM was killed and nothing at all about the killing, so a verdict
 * that passed it through would report every terminal we disposed mid-launch as a
 * failed launch -- see the two cases added to `terminal-lifecycle.test.ts`,
 * where that claim is made against the consumer rather than against a comment.
 */

/** Both taken from the measurement rather than invented (M3.2 stage B, §2). */
const CLAUDE_UNDER_KILL = 1;
const SHELL_UNDER_KILL = -1073741510;

/** Any signal at all. Windows never sends one (measured: three kills, three times absent). */
const SOME_SIGNAL = 15;

interface Row {
  readonly code: number | undefined;
  readonly signal: number | undefined;
  readonly cause: TerminalExitCause;
  /** What the record is written with. */
  readonly reason: TerminalExitReason;
  readonly reported: number | undefined;
}

/**
 * Three causes x four codes x two signals, written out rather than generated:
 * a generated expectation is the implementation a second time, and it agrees
 * with a wrong rule as readily as with a right one.
 */
const TABLE: readonly Row[] = [
  // The program finished and said a number. The number is its own word about
  // itself and travels untouched -- this is the only row group that carries one.
  { code: undefined, signal: undefined, cause: 'exited', reason: 'process', reported: undefined },
  { code: 0, signal: undefined, cause: 'exited', reason: 'process', reported: 0 },
  { code: CLAUDE_UNDER_KILL, signal: undefined, cause: 'exited', reason: 'process', reported: 1 },
  {
    code: SHELL_UNDER_KILL,
    signal: undefined,
    cause: 'exited',
    reason: 'process',
    reported: SHELL_UNDER_KILL,
  },

  // A signal means the program was stopped from outside and never got to say a
  // number. The act was still nobody's of ours, so the reason stands; the code
  // goes, because `code` in this codebase means "something exited and reported
  // this" (A15). Owner's decision 2026-08-17, taken as a decision and not as a
  // measurement: Windows never sends a signal, so nothing here was observed.
  { code: undefined, signal: SOME_SIGNAL, cause: 'exited', reason: 'process', reported: undefined },
  { code: 0, signal: SOME_SIGNAL, cause: 'exited', reason: 'process', reported: undefined },
  {
    code: CLAUDE_UNDER_KILL,
    signal: SOME_SIGNAL,
    cause: 'exited',
    reason: 'process',
    reported: undefined,
  },
  {
    code: SHELL_UNDER_KILL,
    signal: SOME_SIGNAL,
    cause: 'exited',
    reason: 'process',
    reported: undefined,
  },

  // We destroyed it. `extension` is not a guess: it is what the editor engine
  // answers to our own `dispose` of its terminals (A29), and the two engines
  // must not disagree about one act. The code is dropped whatever it was.
  { code: undefined, signal: undefined, cause: 'we-disposed', reason: 'extension', reported: undefined },
  { code: 0, signal: undefined, cause: 'we-disposed', reason: 'extension', reported: undefined },
  {
    code: CLAUDE_UNDER_KILL,
    signal: undefined,
    cause: 'we-disposed',
    reason: 'extension',
    reported: undefined,
  },
  {
    code: SHELL_UNDER_KILL,
    signal: undefined,
    cause: 'we-disposed',
    reason: 'extension',
    reported: undefined,
  },
  {
    code: undefined,
    signal: SOME_SIGNAL,
    cause: 'we-disposed',
    reason: 'extension',
    reported: undefined,
  },
  { code: 0, signal: SOME_SIGNAL, cause: 'we-disposed', reason: 'extension', reported: undefined },
  {
    code: CLAUDE_UNDER_KILL,
    signal: SOME_SIGNAL,
    cause: 'we-disposed',
    reason: 'extension',
    reported: undefined,
  },
  {
    code: SHELL_UNDER_KILL,
    signal: SOME_SIGNAL,
    cause: 'we-disposed',
    reason: 'extension',
    reported: undefined,
  },

  // The window is going away and taking every terminal with it. Reported as
  // itself rather than as anybody's act -- the row the whole restore design
  // leans on, because a reload that read as intent would empty the base.
  {
    code: undefined,
    signal: undefined,
    cause: 'we-are-shutting-down',
    reason: 'shutdown',
    reported: undefined,
  },
  { code: 0, signal: undefined, cause: 'we-are-shutting-down', reason: 'shutdown', reported: undefined },
  {
    code: CLAUDE_UNDER_KILL,
    signal: undefined,
    cause: 'we-are-shutting-down',
    reason: 'shutdown',
    reported: undefined,
  },
  {
    code: SHELL_UNDER_KILL,
    signal: undefined,
    cause: 'we-are-shutting-down',
    reason: 'shutdown',
    reported: undefined,
  },
  {
    code: undefined,
    signal: SOME_SIGNAL,
    cause: 'we-are-shutting-down',
    reason: 'shutdown',
    reported: undefined,
  },
  {
    code: 0,
    signal: SOME_SIGNAL,
    cause: 'we-are-shutting-down',
    reason: 'shutdown',
    reported: undefined,
  },
  {
    code: CLAUDE_UNDER_KILL,
    signal: SOME_SIGNAL,
    cause: 'we-are-shutting-down',
    reason: 'shutdown',
    reported: undefined,
  },
  {
    code: SHELL_UNDER_KILL,
    signal: SOME_SIGNAL,
    cause: 'we-are-shutting-down',
    reason: 'shutdown',
    reported: undefined,
  },
];

describe('exitVerdict maps a pty exit onto the pair a record is written from', () => {
  it.each(TABLE)(
    'reads code $code with signal $signal and cause $cause as $reason / $reported',
    ({ code, signal, cause, reason, reported }) => {
      expect(exitVerdict(code, signal, cause)).toStrictEqual({ code: reported, reason });
    }
  );

  it('covers every cause the port names', () => {
    // The table above is total only while it names every member. A fourth cause
    // added without a row would otherwise be a rule nobody wrote.
    expect([...new Set(TABLE.map((row) => row.cause))].sort()).toStrictEqual(
      [...TERMINAL_EXIT_CAUSES].sort()
    );
  });
});

/**
 * Two members of `TerminalExitReason` that `own` has no way to mean, named here
 * rather than left to be discovered by whoever writes the next rule:
 *
 *   * **`user`** is the platform's word for a terminal's own tab being closed.
 *     `own` has no editor tab -- the cross on our strip goes to
 *     `gripterm.closeTerminal` (M3.9), which reaches `close()`, which stamps
 *     `closedAt` itself before disposing. So under `own` a person's decision
 *     arrives as `we-disposed` behind an already-closed record, and the rule in
 *     `_noteDeliberateClose` -- `user` AND nothing exited -- never fires. It
 *     stays for the `editor` engine, which is the rollback (O5) and still
 *     produces it.
 *   * **`unknown`** is where every unmeasured editor answer falls. Under `own`
 *     there is no editor to answer: the cause is produced by our own code, so
 *     an unknown one would be our bug and not a platform we have not met. The
 *     type keeps it total instead.
 */
describe('exitVerdict never reaches the two reasons `own` has no way to mean', () => {
  it('produces only process, extension and shutdown, whatever it is given', () => {
    const produced = new Set<TerminalExitReason>();
    for (const cause of TERMINAL_EXIT_CAUSES) {
      for (const code of [undefined, 0, 1, -1, SHELL_UNDER_KILL, 130]) {
        for (const signal of [undefined, 2, 9, SOME_SIGNAL]) {
          produced.add(exitVerdict(code, signal, cause).reason);
        }
      }
    }

    expect([...produced].sort()).toStrictEqual(['extension', 'process', 'shutdown']);
  });
});
