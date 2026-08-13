import * as vscode from 'vscode';
import { CONTEXT_LIVE, terminalIdFrom } from '@gripterm/core';
import { pickTerminal } from './pick-terminal';
import type { Logger, SessionRegistry, TerminalLifecycleService } from '@gripterm/core';

export const CLOSE_TERMINAL_COMMAND = 'gripterm.closeTerminal';

/**
 * `gripterm.closeTerminal` -- the person is finished with this conversation.
 *
 * It produces `closedAt`, which is what separates "this terminal is over" from
 * "this terminal is not running at the moment": ours are transient and die at
 * every editor shutdown, so only a deliberate close can mean the record should
 * not come back (§4.2). The same act done in the editor -- the cross on the
 * terminal's own tab -- produces it too, on the path through `_onClosed` that
 * A29 opened; this command is the one a person reaches from the list.
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
        title: 'Close Terminal',
        placeHolder: 'Close which terminal?',
        rows: [CONTEXT_LIVE],
        whenEmpty: 'Gripterm: there is no running terminal to close.',
        // Asked even when there is one, unlike the edit commands (M2.18): this
        // ends a conversation and opens no second dialog, so the picker is the
        // last place a person sees what they are about to close.
        whenSole: 'ask',
      }));
    if (terminalId === null) {
      return;
    }
    lifecycle.close(terminalId);
  });
}
