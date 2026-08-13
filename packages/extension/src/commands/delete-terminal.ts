import * as vscode from 'vscode';
import { presentTerminal } from '@gripterm/core';
import { FINISHED_ROWS, whichTerminal } from './pick-terminal';
import { say } from '../ui/say';
import type { Logger, SessionRegistry, TerminalLifecycleService } from '@gripterm/core';

export const DELETE_TERMINAL_COMMAND = 'gripterm.deleteTerminal';

/** The button, and the word this command is confirmed by. */
const CONFIRM = 'Delete Record';

/**
 * `gripterm.deleteTerminal` -- the person is throwing the record away (M2.7).
 *
 * **The dialog names what survives, not only what goes**, and that is the whole
 * of the acceptance criterion this command exists for. A person deleting a row
 * from a list of terminals has every reason to fear they are deleting the
 * conversation behind it; they are not, and a confirmation that left them to
 * guess would be a confirmation of something they did not understand. What
 * survives is said in the same breath as what does not: the Claude Code
 * conversation, which is not ours and which this codebase never writes to, and
 * the event journal, which no later version can go back for (§10.1а).
 *
 * **Modal on purpose.** A toast with a button can be missed, is dismissed by
 * accident, and does not stop the person carrying on. This is the one command in
 * the extension that takes something away.
 *
 * The record itself goes to `trash/<stamp>/<terminalId>/` rather than to
 * nothing, which is what makes it an act somebody can undo (§I.3). That is said
 * in the dialog as well, because a promise a person only learns about after they
 * needed it is not a promise they could use.
 */
export function registerDeleteTerminal(
  lifecycle: TerminalLifecycleService,
  registry: SessionRegistry,
  logger: Logger
): vscode.Disposable {
  return vscode.commands.registerCommand(DELETE_TERMINAL_COMMAND, async (target: unknown) => {
    const terminalId = await whichTerminal(registry, logger, {
      target,
      title: 'Delete Record',
      placeHolder: 'Delete the record of which terminal?',
      rows: FINISHED_ROWS,
      whenEmpty: 'Gripterm: every terminal of this window is still running.',
      // Asked even when there is one (M2.18). The modal below names what goes
      // and what stays, and this is where the person reads WHICH record that
      // is about.
      whenSole: 'ask',
    });
    if (terminalId === null) {
      return;
    }

    const entry = registry.get(terminalId);
    if (entry === undefined) {
      // Gone between the picker and the choice. Nothing to confirm and nothing
      // to say: what they asked for is already true.
      return;
    }

    const answer = await vscode.window.showWarningMessage(
      `Delete Gripterm's record of "${presentTerminal(entry).label}"?`,
      {
        modal: true,
        detail:
          'The Claude Code conversation is kept, and so is this terminal\'s event journal. ' +
          'What goes is the Gripterm record — its name, task, notes and tags — and it is moved ' +
          'to the trash folder of your Gripterm storage rather than deleted.',
      },
      CONFIRM
    );
    // Anything but the button -- Cancel, Escape, the dialog closing -- is no.
    if (answer !== CONFIRM) {
      return;
    }

    if (lifecycle.discard(terminalId) === 'still-running') {
      say(
        'warning',
        'Gripterm: close this terminal before deleting its record.',
        logger
      );
    }
  });
}
