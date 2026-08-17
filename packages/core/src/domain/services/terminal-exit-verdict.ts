import type { TerminalExit, TerminalExitReason } from '../ports/terminal-gateway';

/**
 * WHY a terminal of ours went away, as the only thing that can know it says so:
 * the code that ended it.
 *
 * Under the `editor` engine this question has an answer already -- the platform
 * reports one, and A29 measured what it reports for each act. Under `own` there
 * is no platform to ask. node-pty reports a number and possibly a signal, and
 * a number cannot say who wanted the terminal gone.
 *
 * Three members, and the third is not a variation of the second. `dispose` and
 * shutdown are the same act to a pty and opposite acts to a record: one is a
 * terminal that ended, the other is a window that left. A build that flattened
 * them would stamp `closedAt` on every terminal at every reload and bring none of
 * them back (П7).
 */
export const TERMINAL_EXIT_CAUSES = ['exited', 'we-disposed', 'we-are-shutting-down'] as const;

export type TerminalExitCause = (typeof TERMINAL_EXIT_CAUSES)[number];

/**
 * The cause we know, spelled in the vocabulary the record is written in.
 *
 * A total `Record`, so that a fourth cause is a compile error here rather than a
 * silent fall-through into somebody's default. The shape mirrors the table in
 * `VsCodeTerminalGateway`, which does the same job in the other direction.
 *
 * `we-disposed` becomes `extension` because that is what the editor engine
 * answers when we dispose one of ITS terminals (A29, measured 2026-08-13). The
 * two engines must not disagree about one act: everything downstream reads this
 * field, and a second name for our own disposal would be a second set of rules.
 */
const REASONS: Readonly<Record<TerminalExitCause, TerminalExitReason>> = {
  exited: 'process',
  'we-disposed': 'extension',
  'we-are-shutting-down': 'shutdown',
};

/**
 * The pair a record is written from, out of what the pty said and what we know.
 *
 * **A pair rather than a word, because the rules of M2 read both fields**, and
 * one of them reads the ABSENCE of a code: a terminal a person deliberately
 * closed has none, because nothing inside it exited (A15), and a non-zero code
 * during `launching` is a failed launch worth telling somebody about (§4.3).
 * Flattening the verdict to a reason would take one of those two rules away.
 *
 * **The code survives in exactly one case: the program finished and said it.**
 * Measured 2026-08-17 (M3.2 stage B, §2): under `IPty.kill()` `claude` exits with
 * 1, `powershell` and `cmd` with -1073741510 (`STATUS_CONTROL_C_EXIT`). So the
 * number reports WHICH PROGRAM was killed and nothing about the killing, and a
 * verdict that passed it through would report a failed launch for every terminal
 * ended while it was still starting -- which, under `own`, is every terminal a
 * person closes at that moment, since closing one is disposing it.
 *
 * A `signal` is the same case one step further out: the program was stopped from
 * outside and never got to say a number at all. The act was still neither ours
 * nor the window's, so `process` stands, and the code goes. **This one is a
 * decision and not a measurement, and it is recorded as such** (owner,
 * 2026-08-17): Windows sends no signal -- three kills, three times absent -- so
 * nothing here was observed. The direction was chosen by what it costs when
 * wrong: one `launch_failed` event that does not get written, against a number
 * of the platform's choosing landing in an event that claims the agent's own
 * launch command failed.
 */
export function exitVerdict(
  code: number | undefined,
  signal: number | undefined,
  cause: TerminalExitCause
): TerminalExit {
  const reason = REASONS[cause];
  if (cause !== 'exited' || signal !== undefined) {
    return { code: undefined, reason };
  }
  return { code, reason };
}
