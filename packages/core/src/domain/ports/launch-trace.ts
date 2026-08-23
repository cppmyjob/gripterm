import type { LaunchIntent } from '../entities/launch-intent';
import type { TerminalId } from '../entities/terminal-id';

/**
 * What a start left behind, written where it will still be tomorrow.
 *
 * **The owner, 2026-08-23.** They closed Cursor and opened it again; of three
 * records one came back and two stood there empty and silent. Everything needed
 * to say why had been written -- to the window's Output panel, which dies with
 * the window. By the time the question was asked the evidence was gone, and
 * what was left to reason from was the shape of the store: `pid: null` on two
 * records, no events after the restart, transcripts untouched. That was enough
 * to rule things OUT and not enough to name the cause.
 *
 * So the three facts a start is judged by go to disk beside the record:
 *
 *   * that we launched at all, with which intent, and which flags went with it;
 *   * whether the EDITOR ever said what process it started;
 *   * or that the launch failed, with the words it failed with.
 *
 * A log is for the window that is running. This is for the window that is not.
 *
 * **Not a second log, and deliberately narrow.** No values are written, only
 * flag NAMES: the values carry a person's prompt (`--append-system-prompt`, a
 * positional prompt) and the journal's own privacy rule -- content is off
 * unless it is asked for -- would be a strange thing to hold in one file and
 * not in the one beside it. The two identifiers that matter are ours already:
 * the record's conversation, and the intent this build chose for it.
 */
export type LaunchNote =
  | {
    readonly what: 'start';
    /** `resume` continues the conversation the record names; `launch` starts a new one. */
    readonly intent: LaunchIntent;
    /** Which engine made the terminal: the editor's, or one of our own. */
    readonly engine: string;
    readonly executable: string;
    /**
     * The flag NAMES of the command, in order, with every value left out.
     *
     * `--resume` being present or absent is the whole question this file was
     * written to answer, and it is answered without carrying one character a
     * person typed.
     */
    readonly flags: readonly string[];
    /** How many arguments there were in total, flags and values together. */
    readonly args: number;
    /** The conversation the record named at that moment. */
    readonly session: string;
    readonly cwd: string;
  }
  | {
    /** The editor named the process behind the terminal. It is running. */
    readonly what: 'pid';
    readonly pid: number;
  }
  | {
    /**
     * The editor would not say what process the terminal is running, which is
     * what two of the owner's three records looked like from the store.
     */
    readonly what: 'no-pid';
  }
  | {
    readonly what: 'failed';
    readonly reason: string;
  };

/**
 * Where those notes go.
 *
 * A port because the domain must not know about files, and optional everywhere
 * it is used: a window with no store still starts terminals, and a trace that
 * refuses to be written must never be a reason a person's terminal does not
 * open. Implementations swallow their own failures.
 */
export interface LaunchTrace {
  note: (terminalId: TerminalId, note: LaunchNote) => void;
}
