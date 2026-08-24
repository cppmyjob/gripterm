import type { Disposable } from '../ports/disposable';
import type { Logger } from '../ports/logger';
import type { TerminalEntry } from '../entities/terminal-entry';
import type { TerminalGateway } from '../ports/terminal-gateway';

/**
 * What a window does to its own processes on the way out (M3.5, O4).
 *
 * Under the `editor` engine there is nothing to do and doing something would be
 * wrong: those terminals belong to the editor, they are marked transient, and a
 * `claude` in one of them outlives the extension host on purpose (O5, measured
 * in M2.16). Under `own` there is nobody else at all -- a pty this window made
 * is a process this window is answerable for, and a build that let them go would
 * leave a `claude` per terminal behind every closed window.
 *
 * **Two acts, and the order of them is the rule.** The pids are read while the
 * gateway still knows its terminals; only then is the gateway told to end them;
 * and only then does the recorded pid get a signal of its own. Reversed, the
 * backstop reads an empty list -- a gateway that has disposed its handles knows
 * no terminals -- and it would be a loop over nothing that no assertion about
 * the first act would notice.
 *
 * **Why there is a backstop at all.** `IPty.kill()` is asynchronous in its
 * effect and the host that called it may be gone microseconds later; a
 * synchronous `process.kill` on the number we wrote down is the one thing a
 * window closing cannot overtake. On Windows it is belt and braces -- closing
 * the pseudoconsole takes the process with it, measured in M3.2(7) -- and
 * anywhere else it is the whole of the promise.
 *
 * **Why the gateway's list and not the record's `engine` field.** Both would
 * answer here, and two answers to one question is how one of them quietly stops
 * being checked (M2.11's mutation run found exactly that). `listKnown()` is the
 * authority because it IS this window's set of running terminals: a record this
 * window adopted and never started carries a pid from another window's life, and
 * no rule about a stored field would say so.
 */

export interface WindowShutdownParams {
  /** This window's gateway, which is both the engine and the terminals it made. */
  readonly gateway: TerminalGateway & Disposable;
  /** The records this window owns -- `SessionRegistry.own()`. */
  readonly entries: readonly TerminalEntry[];
  /**
   * Ends a process by pid, or throws the way `process.kill` does.
   *
   * A seam of the same width as `SignalProbe`, and for the same reason: the
   * outcomes that matter here -- a process already gone, a process that is not
   * ours to signal -- cannot be produced from inside a test any other way.
   */
  readonly endProcess: (pid: number) => void;
  readonly logger: Logger;
}

export interface WindowShutdownReport {
  /** Pids this window signalled on its way out, in the order it signalled them. */
  readonly ended: readonly number[];
  /** Pids the platform would not signal: already gone, or not ours to end. */
  readonly refused: readonly number[];
}

const NOTHING_TO_END: WindowShutdownReport = Object.freeze({
  ended: Object.freeze([]),
  refused: Object.freeze([]),
});

export function endOwnTerminals(params: WindowShutdownParams): WindowShutdownReport {
  if (params.gateway.engine !== 'own') {
    return NOTHING_TO_END;
  }

  const running = new Set(params.gateway.listKnown().map((handle) => handle.terminalId.value));
  const doomed: { readonly terminalId: string, readonly pid: number }[] = [];
  for (const entry of params.entries) {
    if (!running.has(entry.terminalId.value)) {
      continue;
    }
    if (entry.observed.pid === null) {
      // Not a fault and not silent either: the pty is about to be ended by the
      // line below, and this says which terminal will have gone without the one
      // piece of evidence that could have been checked afterwards.
      params.logger.info('a terminal of our own is being ended without knowing which process it is', {
        terminalId: entry.terminalId.value,
      });
      continue;
    }
    doomed.push({ terminalId: entry.terminalId.value, pid: entry.observed.pid });
  }

  // The first act, and the one that carries the CAUSE: a window leaving must not
  // stamp `closedAt` on conversations it is expected to bring back, so the
  // gateway ends its terminals as `we-are-shutting-down` rather than as a
  // disposal (`exitVerdict`, П7).
  params.gateway.dispose();

  const ended: number[] = [];
  const refused: number[] = [];
  for (const { terminalId, pid } of doomed) {
    try {
      params.endProcess(pid);
      ended.push(pid);
    } catch (cause: unknown) {
      // A process that is already gone is the ORDINARY case -- the pty's own
      // kill has just run -- so this is not a warning. What it is for is the
      // other outcome: a refusal that is not `ESRCH` means the process is there
      // and not ours to signal, which is the one shape a person may need to act
      // on themselves.
      refused.push(pid);
      params.logger.info('a process this window was ending did not take the signal', {
        terminalId,
        pid,
        cause,
      });
    }
  }
  if (ended.length > 0 || refused.length > 0) {
    params.logger.info('this window ended the processes of the terminals it made itself', {
      ended: ended.length,
      refused: refused.length,
    });
  }
  return { ended, refused };
}
