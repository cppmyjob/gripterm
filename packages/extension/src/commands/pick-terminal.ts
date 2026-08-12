import * as vscode from 'vscode';
import { CONTEXT_LIVE, CONTEXT_OVER, presentTerminal } from '@gripterm/core';
import { say } from '../ui/say';
import type { Logger, SessionRegistry, TerminalId } from '@gripterm/core';

/**
 * Rows a person may edit: every record this window holds, running or finished.
 *
 * Editing an ended terminal is not a mistake -- a record kept for its task and
 * its notes is exactly the kind somebody comes back to name properly. What is
 * absent is `CONTEXT_FOREIGN`, and that is the single-writer rule (§4.8) rather
 * than a matter of taste.
 *
 * This list and the `when` clauses in `package.json` say the same thing in two
 * places, which is a rule that can rot. What stops it is a test in a real
 * editor: `tests/integration/lifecycle.test.ts` reads the manifest back out of
 * the host and asserts which commands are offered on which row, against these
 * same two constants.
 */
export const EDITABLE_ROWS: readonly string[] = [CONTEXT_LIVE, CONTEXT_OVER];

/** Rows a person may throw away: ours, and no longer running. */
export const DISCARDABLE_ROWS: readonly string[] = [CONTEXT_OVER];

interface TerminalPick extends vscode.QuickPickItem {
  readonly terminalId: TerminalId;
}

export interface TerminalPickRequest {
  readonly placeHolder: string;
  /** Which rows to offer, by the same value the menus are keyed on. */
  readonly rows: readonly string[];
  /** What to say when there is nothing to offer. */
  readonly whenEmpty: string;
}

/**
 * Which terminal, when the caller did not say.
 *
 * Every one of these commands is reachable two ways and both are real: a menu on
 * a tree row hands over the row's element, and the palette hands over nothing --
 * which is why there is a picker here rather than a refusal.
 *
 * One picker rather than one per command, because the interesting part is the
 * same in all of them and it is a rule: only records this window can act on are
 * offered. `own()` removes what the base projected in from other windows, and
 * the row filter then removes the ones this particular command has no business
 * with. Written six times it would eventually be written five ways -- the close
 * picker was, once, and it offered another window's terminals in a dialog that
 * then blocked on a choice this window could not act on.
 */
export async function pickTerminal(
  registry: SessionRegistry,
  logger: Logger,
  request: TerminalPickRequest
): Promise<TerminalId | null> {
  const picks: TerminalPick[] = registry
    .own()
    .map((entry) => ({ entry, shown: presentTerminal(entry) }))
    .filter(({ shown }) => request.rows.includes(shown.contextValue))
    .map(({ entry, shown }) => ({
      label: shown.label,
      description: shown.description,
      detail: entry.launch.cwd,
      terminalId: entry.terminalId,
    }));

  if (picks.length === 0) {
    say('info', request.whenEmpty, logger);
    return null;
  }

  const chosen = await vscode.window.showQuickPick(picks, { placeHolder: request.placeHolder });
  // `undefined` is the person pressing Escape, and that is an answer: do
  // nothing, say nothing.
  return chosen?.terminalId ?? null;
}
