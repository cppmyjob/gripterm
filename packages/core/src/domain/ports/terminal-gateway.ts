import type { TerminalId } from '../entities/terminal-id.js';
import type { Disposable } from './disposable.js';

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
  readonly env: Readonly<Record<string, string>>;
  /** Absolute path to the executable that becomes the terminal process, or `null` to run the user's shell and type the command in afterwards (`gripterm.launch.mode: shell`). */
  readonly shellPath: string | null;
  readonly shellArgs: readonly string[];
}

/**
 * Why the terminal went away.
 *
 * `undefined` is not "we do not know": the editor uses it for a terminal the
 * person closed themselves, and a number for a process that exited. That is the
 * only thing separating a failed launch from a deliberate close, so it is
 * carried through the port rather than flattened into a boolean.
 */
export interface TerminalExit {
  readonly code: number | undefined;
}

export interface TerminalHandle {
  readonly terminalId: TerminalId;
  sendText: (text: string, execute: boolean) => void;
  show: (preserveFocus: boolean) => void;
  dispose: () => void;
  onDidClose: (listener: (exit: TerminalExit) => void) => Disposable;
}

export interface TerminalGateway {
  create: (spec: TerminalSpec) => Promise<TerminalHandle>;
  /** The terminals this gateway created and has not seen close. */
  listKnown: () => readonly TerminalHandle[];
}
