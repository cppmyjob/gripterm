import * as vscode from 'vscode';
import { SHOW_RECORD_COMMAND, terminalTargetOf } from '@gripterm/core';
import { TERMINALS_VIEW_ID } from '../ui/terminal-tree';
import { say } from '../ui/say';
import type { TerminalTreeDataProvider, TerminalTreeNode } from '../ui/terminal-tree';
import type { Logger } from '@gripterm/core';

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
 * The node comes from the tree rather than from the registry, because the list
 * is grouped (M2.14) and `reveal` walks a node up through `getParent`. A record
 * the tree does not hold is one it cannot select -- which includes a record
 * deleted between the toast and the press.
 *
 * Not offered in the palette or on a row: it takes a terminal id, and pressing
 * it on a row would mean "show me the row I am pointing at".
 */
export function registerShowRecord(
  view: vscode.TreeView<TerminalTreeNode>,
  tree: TerminalTreeDataProvider,
  logger: Logger
): vscode.Disposable {
  return vscode.commands.registerCommand(SHOW_RECORD_COMMAND, async (target: unknown) => {
    const resolved = terminalTargetOf(target);
    const node = resolved.kind === 'terminal' ? tree.nodeFor(resolved.terminalId) : null;
    if (node === null) {
      // Deleted between the toast and the press. Opening the list is still the
      // right answer: it is where the person was going.
      await vscode.commands.executeCommand(`${TERMINALS_VIEW_ID}.focus`);
      return;
    }

    try {
      await view.reveal(node, { select: true, focus: true });
    } catch (cause: unknown) {
      // `reveal` is the platform's, and it throws when it cannot find the
      // element in the tree it drew. The list itself is still worth opening.
      logger.warn('a record could not be selected in the list', {
        terminalId: node.terminalId.value,
        cause: String(cause),
      });
      await vscode.commands.executeCommand(`${TERMINALS_VIEW_ID}.focus`);
      say('warning', `Gripterm: "${node.metadata.displayName}" is in the list below.`, logger);
    }
  });
}
