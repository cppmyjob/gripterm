import * as vscode from 'vscode';
import { FOCUS_TERMINAL_COMMAND, TerminalId, isGriptermError } from '@gripterm/core';
import type { Logger } from '@gripterm/core';
import type { VsCodeTerminalGateway } from '../adapters/vscode-terminal-gateway';

/**
 * `gripterm.focusTerminal` -- brings a terminal to the front.
 *
 * It belongs to M1.12, and it is here early for a stated reason rather than by
 * drift: M1.11a's notification offers a "Show terminal" button, and a button
 * whose command does not exist is a promise the extension cannot keep. The rest
 * of M1.12 -- creating, closing, and reading an exit code -- stays where it is.
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
    const terminalId = readTerminalId(target);
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

/**
 * The argument, whatever the caller sent.
 *
 * A command is reachable from a notification button (a string), from the
 * command palette (nothing at all) and, once M1.12 contributes the menus, from
 * a tree row. Everything unrecognised is refused rather than guessed at.
 */
function readTerminalId(target: unknown): TerminalId | null {
  if (typeof target !== 'string') {
    return null;
  }
  try {
    return TerminalId.fromString(target);
  } catch (error: unknown) {
    if (isGriptermError(error)) {
      return null;
    }
    throw error;
  }
}
