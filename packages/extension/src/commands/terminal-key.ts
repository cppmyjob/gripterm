import * as vscode from 'vscode';
import type { TerminalKeyboard } from '../ui/terminal-keyboard';

/**
 * The one command every chord of `keys.ts` is bound to.
 *
 * One command with an argument rather than six commands: the list of chords
 * lives in the table, and a command per chord would be a second list -- in the
 * manifest, in the composition root, and in whatever forgets to grow when the
 * table does.
 *
 * It is deliberately NOT contributed to `contributes.commands`. There is no
 * sense in which a person can run "send Ctrl+R to the terminal" from the
 * palette: the whole point of it is the key press it is bound to.
 */
export const TERMINAL_KEY_COMMAND = 'gripterm.terminalKey';

export function registerTerminalKey(keyboard: TerminalKeyboard): vscode.Disposable {
  return vscode.commands.registerCommand(TERMINAL_KEY_COMMAND, (chord: unknown) => {
    keyboard.press(chord);
  });
}
