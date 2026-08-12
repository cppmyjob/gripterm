import * as vscode from 'vscode';
import { SHOW_RECORD_COMMAND, terminalIdFrom } from '@gripterm/core';
import { TERMINALS_VIEW_ID } from '../ui/terminal-tree';
import { say } from '../ui/say';
import type { Logger, SessionRegistry, TerminalEntry } from '@gripterm/core';

/**
 * `gripterm.showRecord` -- puts the person in front of the row a notification is
 * about (M2.13).
 *
 * It is the button on the `resume_failed` toast, and it exists because that
 * signal is the one where the answer is neither the terminal nor the log. The
 * terminal is gone by the time the signal is born, and the log holds an exit
 * code; what is worth reaching is the RECORD -- the name, the task, the notes,
 * and the offer to start the conversation over, which lives on that row's menu.
 *
 * Not offered in the palette or on a row: it takes a terminal id, and pressing
 * it on a row would mean "show me the row I am pointing at".
 */
export function registerShowRecord(
  view: vscode.TreeView<TerminalEntry>,
  registry: SessionRegistry,
  logger: Logger
): vscode.Disposable {
  return vscode.commands.registerCommand(SHOW_RECORD_COMMAND, async (target: unknown) => {
    const terminalId = terminalIdFrom(target);
    const entry = terminalId === null ? undefined : registry.get(terminalId);
    if (entry === undefined) {
      // Deleted between the toast and the press, or another window's. Opening
      // the list is still the right answer: it is where the person was going.
      await vscode.commands.executeCommand(`${TERMINALS_VIEW_ID}.focus`);
      return;
    }

    try {
      await view.reveal(entry, { select: true, focus: true });
    } catch (cause: unknown) {
      // `reveal` is the platform's, and it throws when it cannot find the
      // element in the tree it drew. The list itself is still worth opening.
      logger.warn('a record could not be selected in the list', {
        terminalId: entry.terminalId.value,
        cause: String(cause),
      });
      await vscode.commands.executeCommand(`${TERMINALS_VIEW_ID}.focus`);
      say('warning', `Gripterm: "${entry.metadata.displayName}" is in the list below.`, logger);
    }
  });
}
