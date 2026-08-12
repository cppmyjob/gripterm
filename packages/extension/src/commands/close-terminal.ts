import * as vscode from 'vscode';
import { CONTEXT_LIVE, terminalIdFrom } from '@gripterm/core';
import { pickTerminal } from './pick-terminal';
import type { Logger, SessionRegistry, TerminalLifecycleService } from '@gripterm/core';

export const CLOSE_TERMINAL_COMMAND = 'gripterm.closeTerminal';

/**
 * `gripterm.closeTerminal` -- the person is finished with this conversation.
 *
 * It is the only producer of `closedAt` in the system, which is what separates
 * "this terminal is over" from "this terminal is not running at the moment":
 * ours are transient and die at every editor shutdown, so only a deliberate
 * close can mean the record should not come back (§4.2).
 *
 * Reachable two ways, and both are real: a menu on a tree row hands over the
 * row's element, and the palette hands over nothing -- which is why there is a
 * picker rather than a refusal. Only running terminals are offered, which is the
 * same answer the tree menus are keyed on, so the palette and the right-click
 * menu cannot come to different conclusions about what is closable.
 */
export function registerCloseTerminal(
  lifecycle: TerminalLifecycleService,
  registry: SessionRegistry,
  logger: Logger
): vscode.Disposable {
  return vscode.commands.registerCommand(CLOSE_TERMINAL_COMMAND, async (target: unknown) => {
    const named = terminalIdFrom(target);
    const terminalId =
      named ??
      (await pickTerminal(registry, logger, {
        placeHolder: 'Close which terminal?',
        rows: [CONTEXT_LIVE],
        whenEmpty: 'Gripterm: there is no running terminal to close.',
      }));
    if (terminalId === null) {
      return;
    }
    lifecycle.close(terminalId);
  });
}
