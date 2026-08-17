import * as vscode from 'vscode';
import { FOCUS_TERMINAL_COMMAND, terminalTargetOf } from '@gripterm/core';
import { say } from '../ui/say';
import type { Logger, TerminalGateway } from '@gripterm/core';

/**
 * `gripterm.focusTerminal` -- brings a terminal to the front.
 *
 * A terminal that is no longer there is NOT an error. Between the notification
 * appearing and somebody pressing its button, a turn can finish and a process
 * can exit; a popup saying "that terminal is gone" would be a second
 * interruption to report something the person can already see.
 */
export function registerFocusTerminal(
  gateway: TerminalGateway,
  logger: Logger
): vscode.Disposable {
  return vscode.commands.registerCommand(FOCUS_TERMINAL_COMMAND, (target: unknown) => {
    const resolved = terminalTargetOf(target);
    if (resolved.kind !== 'terminal') {
      // Said aloud when something WAS handed over, silent when nothing was
      // (M2.21). The first is a button or a row wired to the wrong thing and
      // nobody would ever find it in a log; the second is somebody running the
      // command from the palette, where it has nothing to act on and no popup
      // to offer.
      if (resolved.kind === 'unreadable') {
        say('warning', 'Gripterm: could not tell which terminal that was.', logger);
      }
      logger.warn('focusTerminal was called with no terminal to show', {
        target: String(target),
        why: resolved.kind,
      });
      return;
    }

    const terminalId = resolved.terminalId;
    const handle = gateway.handleFor(terminalId);
    if (handle === undefined) {
      logger.info('focusTerminal found no terminal to show', { terminalId: terminalId.value });
      return;
    }
    // `false`: take the focus. Someone pressed a button asking to be taken
    // there, and leaving the cursor where it was would be answering a different
    // request.
    handle.show(false);
  });
}
