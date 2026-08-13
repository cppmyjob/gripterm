import type { TerminalId } from '../entities/terminal-id';
import type { Disposable } from './disposable';

/**
 * Everything the editor needs in order to create the terminal.
 *
 * Assembled by a `LaunchStrategy` (M1.7), which is also where the fields will
 * be finalised -- the two launch paths take disjoint flag sets, and only the
 * strategy knows which one it is building for.
 *
 * `shellPath` carries the whole of the decision taken in the plan's §4.4: on
 * the default path `claude` IS the terminal process, with no shell under it, so
 * the shell-readiness race and the quoting of an inline JSON `--settings`
 * through PowerShell both cease to exist rather than being worked around.
 */
export interface TerminalSpec {
  readonly terminalId: TerminalId;
  /** The title the person sees in the terminal list. */
  readonly name: string;
  readonly cwd: string;
  /** Added to the terminal's environment; `null` removes a variable the editor would otherwise pass on. */
  readonly env: Readonly<Record<string, string | null>>;
  /** Absolute path to the executable that becomes the terminal process, or `null` to run the user's shell and type the command in afterwards (`gripterm.launch.mode: shell`). */
  readonly shellPath: string | null;
  readonly shellArgs: readonly string[];
}

/**
 * WHICH PATH the terminal went away by, as the editor understands it.
 *
 * Not "who did it", although the platform's own names read that way -- and the
 * difference is measured rather than argued (A29, 2026-08-13, VS Code 1.133 on
 * win32, both terminal locations):
 *
 *   act                              location   code        reason
 *   the cross on the tab             editor     undefined   user
 *   "Kill Terminal"                  either     undefined   user
 *   the process exiting on its own   editor     a number    user
 *   the process exiting on its own   panel      a number    process
 *   our own dispose                  either     undefined   extension
 *   the window reloading or closing  either     undefined   shutdown
 *
 * Read that third row before using this field for intent. In the editor area --
 * this build's default -- a `claude` that exits by itself arrives as `user`,
 * because what the platform saw was its tab closing. So `user` alone is not a
 * person's decision; `user` with nothing exited is (see `_noteDeliberateClose`).
 *
 * `shutdown` is the row the whole design leans on: our terminals are transient,
 * so a reload closes every one of them, and it is reported as itself rather than
 * as anybody's act.
 *
 * `unknown` is a member rather than a hole, and it is the direction every
 * unmeasured case falls: an editor that reports something this build has no name
 * for leaves the record restorable, which costs a person one row they did not
 * want. Reading it as intent would cost them the conversation.
 */
export type TerminalExitReason = 'unknown' | 'shutdown' | 'process' | 'user' | 'extension';

/**
 * Why the terminal went away, in the two fields the editor has to say it with.
 *
 * `code` is `undefined` for a terminal nothing exited inside -- one the person
 * closed AND one we disposed ourselves, measured alike (A15). So the code alone
 * cannot say who did it, which is what `reason` is for: measured 2026-08-13
 * (A29) to separate all three of those cases by name. Both travel through the
 * port untouched, because the pair is what separates a failed launch (§4.3) from
 * a deliberate close (§4.2), and either one flattened is one of those rules gone.
 */
export interface TerminalExit {
  readonly code: number | undefined;
  readonly reason: TerminalExitReason;
}

export interface TerminalHandle {
  readonly terminalId: TerminalId;
  /**
   * The process the editor started for this terminal, or `null` when it does not
   * know one.
   *
   * On the default path this IS `claude` (§4.4), and it is the only evidence any
   * window has that a conversation stopped running: the restore predicate reads
   * a record with no pid as one that may still be going and refuses to bring it
   * back (M2.16 measured what that costs -- every restore refused, П2 broken).
   * Under `gripterm.launch.mode: shell` it is the shell, which answers the same
   * question one level out: nothing survives the shell that started it.
   *
   * A promise because the editor spawns the process asynchronously, and `null`
   * rather than `undefined` because "the platform has no answer" is a value this
   * project stores, not a hole in an object.
   */
  processId: () => Promise<number | null>;
  sendText: (text: string, execute: boolean) => void;
  show: (preserveFocus: boolean) => void;
  /**
   * Puts a new name on the terminal's own tab.
   *
   * Nothing is promised about WHEN it lands: on the editor this is built for,
   * renaming reaches only the terminal that is currently active, so an adapter
   * may have to wait for the person to look at it (M2.17). It cannot fail
   * loudly either -- much of the time nobody pressed anything, so there is
   * nobody to tell -- so it returns nothing, and an editor that refuses costs a
   * tab still wearing the name it had.
   */
  rename: (name: string) => void;
  dispose: () => void;
  onDidClose: (listener: (exit: TerminalExit) => void) => Disposable;
}

export interface TerminalGateway {
  create: (spec: TerminalSpec) => Promise<TerminalHandle>;
  /** The terminals this gateway created and has not seen close. */
  listKnown: () => readonly TerminalHandle[];
}
