import * as vscode from 'vscode';
import { CONTEXT_LIVE, presentTerminal, terminalIdFrom } from '@gripterm/core';
import { say } from '../ui/say';
import type { Logger, SessionRegistry, TerminalId, TerminalLifecycleService } from '@gripterm/core';

export const CLOSE_TERMINAL_COMMAND = 'gripterm.closeTerminal';

interface TerminalPick extends vscode.QuickPickItem {
  readonly terminalId: TerminalId;
}

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
 * picker rather than a refusal.
 */
export function registerCloseTerminal(
  lifecycle: TerminalLifecycleService,
  registry: SessionRegistry,
  logger: Logger
): vscode.Disposable {
  return vscode.commands.registerCommand(CLOSE_TERMINAL_COMMAND, async (target: unknown) => {
    const named = terminalIdFrom(target);
    const terminalId = named ?? (await chooseTerminal(registry, logger));
    if (terminalId === null) {
      return;
    }
    lifecycle.close(terminalId);
  });
}

/**
 * Which terminal, when the caller did not say.
 *
 * Only the ones this window can still act on are offered: `own()` removes the
 * records the base projected in from other windows -- closing one of those is a
 * write this window is forbidden to make -- and `contextValue` then removes the
 * ones that are over. The second half is the same answer the tree menus are
 * keyed on, so the palette and the right-click menu cannot come to different
 * conclusions about what is closable.
 */
async function chooseTerminal(
  registry: SessionRegistry,
  logger: Logger
): Promise<TerminalId | null> {
  const picks: TerminalPick[] = registry
    .own()
    .map((entry) => ({ entry, shown: presentTerminal(entry) }))
    .filter(({ shown }) => shown.contextValue === CONTEXT_LIVE)
    .map(({ entry, shown }) => ({
      label: shown.label,
      description: shown.description,
      detail: entry.launch.cwd,
      terminalId: entry.terminalId,
    }));

  if (picks.length === 0) {
    say('info', 'Gripterm: there is no running terminal to close.', logger);
    return null;
  }

  const chosen = await vscode.window.showQuickPick(picks, {
    placeHolder: 'Close which terminal?',
  });
  // `undefined` is the person pressing Escape, and that is an answer: do
  // nothing, say nothing.
  return chosen?.terminalId ?? null;
}
