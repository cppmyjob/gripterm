import * as vscode from 'vscode';
import {
  CONTEXT_ADOPTABLE,
  CONTEXT_LIVE,
  CONTEXT_OVER,
  chooseTerminal,
  presentTerminal,
} from '@gripterm/core';
import { say } from '../ui/say';
import type {
  Logger,
  OwnerLiveness,
  SessionRegistry,
  SoleTerminal,
  TerminalEntry,
  TerminalId,
  TerminalPresentation,
} from '@gripterm/core';

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

/**
 * Rows whose terminal is over: ours, and with no process of ours behind them.
 *
 * Two commands take it, and both are about a record rather than a terminal --
 * throwing it away, and starting its conversation over (M2.13).
 */
export const FINISHED_ROWS: readonly string[] = [CONTEXT_OVER];

/**
 * Rows another window owns and this one may take: its window is gone, or there
 * and silent (M2.14).
 *
 * The only rows of somebody else's this window offers anything on, and the only
 * thing it offers is adoption.
 */
export const ADOPTABLE_ROWS: readonly string[] = [CONTEXT_ADOPTABLE];

interface TerminalPick extends vscode.QuickPickItem {
  readonly terminalId: TerminalId;
}

export interface TerminalPickRequest {
  /**
   * What the command is, above the box.
   *
   * Required rather than optional, and this is the M2.18 defect written into
   * the type: a quick pick without a title is an empty line with a list under
   * it, indistinguishable from a box asking for a name -- which is exactly what
   * a person took it for. A new picker cannot be added without answering this.
   */
  readonly title: string;
  readonly placeHolder: string;
  /**
   * What to do when this window holds exactly one row this command could act
   * on. Required for the same reason as `title`: it is a decision about the
   * command, and a default here would make it silently.
   */
  readonly whenSole: SoleTerminal;
  /** Which rows to offer, by the same value the menus are keyed on. */
  readonly rows: readonly string[];
  /** What to say when there is nothing to offer. */
  readonly whenEmpty: string;
  /**
   * Offer the records this window does NOT hold, instead of its own.
   *
   * Exactly one command has business with them -- adoption (M2.14) -- and it
   * needs their owner's liveness to judge them at all: a foreign row is
   * `CONTEXT_FOREIGN` while its window answers and `CONTEXT_ADOPTABLE` once it
   * stops, and the difference is the whole of what may be offered. Passing the
   * question in rather than asking the reconciler here keeps this file free of
   * the sweep, which a window without a shared base does not have.
   */
  readonly foreignLiveness?: (entry: TerminalEntry) => OwnerLiveness;
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
 *
 * Adoption is the one command whose candidates are the other set, and it says so
 * (`foreignLiveness`) rather than growing a picker of its own -- one function
 * still decides what a chosen row means.
 *
 * What it does NOT do any more is ask a question with one possible answer
 * (M2.18): where the window holds a single row and the command allows it
 * (`whenSole`), that row is taken and the person goes straight to the dialog
 * they came for. `chooseTerminal` makes that decision, in the domain, because it
 * is a decision -- and because this package is outside the coverage thresholds
 * (§3.5), where a rule about which terminal to act on has no business being.
 */
export async function pickTerminal(
  registry: SessionRegistry,
  logger: Logger,
  request: TerminalPickRequest
): Promise<TerminalId | null> {
  const picks: TerminalPick[] = candidates(registry, request)
    .filter(({ shown }) => request.rows.includes(shown.contextValue))
    .map(({ entry, shown }) => ({
      label: shown.label,
      description: shown.description,
      detail: entry.launch.cwd,
      terminalId: entry.terminalId,
    }));

  const choice = chooseTerminal(picks.map((pick) => pick.terminalId), request.whenSole);
  if (choice.kind === 'nothing') {
    say('info', request.whenEmpty, logger);
    return null;
  }
  if (choice.kind === 'take') {
    return choice.terminalId;
  }

  const chosen = await vscode.window.showQuickPick(picks, {
    title: request.title,
    placeHolder: request.placeHolder,
  });
  // `undefined` is the person pressing Escape, and that is an answer: do
  // nothing, say nothing.
  return chosen?.terminalId ?? null;
}

/** The records a request is about, each judged the way its row would be drawn. */
function candidates(
  registry: SessionRegistry,
  request: TerminalPickRequest
): readonly { readonly entry: TerminalEntry, readonly shown: TerminalPresentation }[] {
  const { foreignLiveness } = request;
  if (foreignLiveness === undefined) {
    return registry.own().map((entry) => ({ entry, shown: presentTerminal(entry) }));
  }
  return registry
    .list()
    .filter((entry) => !registry.knows(entry.terminalId))
    .map((entry) => ({
      entry,
      shown: presentTerminal(entry, { ours: false, liveness: foreignLiveness(entry) }),
    }));
}
