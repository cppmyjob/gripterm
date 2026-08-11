import * as vscode from 'vscode';
import { FOCUS_TERMINAL_COMMAND, terminalIdFrom } from '@gripterm/core';
import type { Logger } from '@gripterm/core';
import type { VsCodeTerminalGateway } from '../adapters/vscode-terminal-gateway';

/**
 * `gripterm.focusTerminal` -- brings a terminal to the front.
 *
 * A terminal that is no longer there is NOT an error. Between the notification
 * appearing and somebody pressing its button, a turn can finish and a process
 * can exit; a popup saying "that terminal is gone" would be a second
 * interruption to report something the person can already see.
 */
export function registerFocusTerminal(
  gateway: VsCodeTerminalGateway,
  logger: Logger
): vscode.Disposable {
  return vscode.commands.registerCommand(FOCUS_TERMINAL_COMMAND, (target: unknown) => {
    const terminalId = terminalIdFrom(target);
    if (terminalId === null) {
      logger.warn('focusTerminal was called without a terminal id', { target: String(target) });
      return;
    }

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
