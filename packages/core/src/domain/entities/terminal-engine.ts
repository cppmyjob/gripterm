/**
 * Which of the two engines a terminal runs on.
 *
 * `editor` is `vscode.window.createTerminal`: the platform owns the process, the
 * screen and the tab, and we hold a handle. `own` is a pty of ours, whose bytes
 * we carry to a screen we draw (M3).
 *
 * `editor` is the default and stays the way back, whole (O5). Under it a
 * `claude` outlives the death of the extension host -- measured in M2.16, 102
 * seconds of observation -- and that is the property no step of M3 is allowed to
 * touch.
 *
 * Stored per TERMINAL rather than derived from the setting, because the setting
 * says what was asked for and this says what happened. The two part company on
 * every fallback: `own` was asked for, the native addon did not load, the
 * `editor` engine made the terminal. A record repeating the setting there would
 * hand reconciliation -- which may kill `own` processes and only those -- a live
 * conversation to end.
 *
 * The list lives in the neutral domain although nothing in the domain reads the
 * strings, for the reason `LAUNCH_LOCATIONS` gives: the manifest's enum, the
 * settings reader and the adapter must not be able to drift, and one of them is
 * a JSON file no compiler checks.
 */
export const TERMINAL_ENGINES = ['editor', 'own'] as const;

export type TerminalEngine = (typeof TERMINAL_ENGINES)[number];

export function isTerminalEngine(value: string): value is TerminalEngine {
  return (TERMINAL_ENGINES as readonly string[]).includes(value);
}
