import * as vscode from 'vscode';
import {
  CONTEXT_ABANDONED,
  CONTEXT_ADOPTABLE,
  CONTEXT_LIVE,
  CONTEXT_OVER,
  chooseTerminal,
  presentTerminal,
  terminalTargetOf,
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
 * The only rows of somebody else's this window may START anything from, and the
 * only thing it offers there is adoption.
 */
export const ADOPTABLE_ROWS: readonly string[] = [CONTEXT_ADOPTABLE];

/**
 * Rows a person may throw away: ours once its terminal is over, and anybody's
 * once nobody is answering for it (M2.22).
 *
 * The two foreign values are both here and neither is redundant. `abandoned` is
 * the row that has nothing else at all -- no window to write it, no conversation
 * to resume -- and it is the row the owner could not get rid of. `adoptable` is
 * a row that CAN be taken over, and it is still here because "can be" is not
 * "will be": adoption is refused for reasons that never change -- nothing was
 * ever said in that conversation, two records name one -- and a person who does
 * not want it back should not have to take it over first in order to delete it.
 *
 * What is absent is `CONTEXT_FOREIGN`, and that is the single-writer rule
 * (§4.8): its window is there and answering, so the record is that window's
 * business and not this one's.
 */
export const DISCARDABLE_ROWS: readonly string[] = [
  CONTEXT_OVER,
  CONTEXT_ADOPTABLE,
  CONTEXT_ABANDONED,
];

interface TerminalPick extends vscode.QuickPickItem {
  readonly terminalId: TerminalId;
}

export interface TerminalPickRequest {
  /**
   * Whatever the editor handed the command: a row of the list, an id from a
   * button of ours, or nothing at all from the palette.
   *
   * Required, and passed in raw rather than resolved by each caller, because
   * resolving it is where M2.21 went wrong: an argument that could not be read
   * looked exactly like no argument, and the command asked WHICH terminal while
   * the person had one under the cursor. One place reads it, and the one place
   * knows the difference.
   */
  readonly target: unknown;
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
   * How to judge whether the window that owns a record is still there.
   *
   * Absent means "assume every owner is answering", which is the truthful
   * default for a window with no shared base -- it holds nothing but its own
   * records -- and which makes every foreign row `CONTEXT_FOREIGN`, so a command
   * that has no business with other windows' records offers none of them without
   * having to say so.
   *
   * The two commands that DO have such business pass the sweep's answer: taking
   * a record over (M2.14) and throwing one away (M2.22). Passing the question in
   * rather than asking the reconciler here keeps this file free of the sweep,
   * which a window without a shared base does not have.
   */
  readonly liveness?: (entry: TerminalEntry) => OwnerLiveness;
}

/**
 * Which terminal a command is about: the one it was invoked on, or the one the
 * person is asked for.
 *
 * Every one of these commands is reachable two ways and both are real: a menu on
 * a tree row hands over the row's element, and the palette hands over nothing --
 * which is why there is a picker here rather than a refusal.
 *
 * **The third case is neither, and it used to be silent (M2.21):** something was
 * handed over and could not be read. Asking then is the wrong answer twice over
 * -- the person already said which one, and the picker they get instead is a
 * list of OTHER terminals with the first one selected. So it is said aloud and
 * nothing is done, which is the only way a wiring defect of this kind ever
 * reaches anybody.
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
export async function whichTerminal(
  registry: SessionRegistry,
  logger: Logger,
  request: TerminalPickRequest
): Promise<TerminalId | null> {
  const target = terminalTargetOf(request.target);
  if (target.kind === 'terminal') {
    return target.terminalId;
  }
  if (target.kind === 'unreadable') {
    say('warning', 'Gripterm: could not tell which terminal that was.', logger);
    return null;
  }

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

/**
 * The records a request is about, each judged EXACTLY THE WAY ITS ROW WOULD BE
 * DRAWN -- same function, same two questions, so the picker and the menu cannot
 * disagree about what a command may act on.
 *
 * One list rather than "ours or theirs" (M2.22). The either/or was a second rule
 * about which records exist, and it made "offer both kinds" unspellable -- which
 * is what deletion needs, since a person deleting a row does not care whose
 * window it belonged to. What decides is `request.rows`, and that is the same
 * value the manifest's `when` clauses are keyed on.
 */
function candidates(
  registry: SessionRegistry,
  request: TerminalPickRequest
): readonly { readonly entry: TerminalEntry, readonly shown: TerminalPresentation }[] {
  const { liveness } = request;
  return registry.list().map((entry) => ({
    entry,
    shown: presentTerminal(entry, {
      ours: registry.knows(entry.terminalId),
      // A record this window holds is a record whose owner is this window --
      // adoption rewrites the owner ref, restoring goes through adoption -- so
      // the answer for our own rows is `live` either way.
      liveness: liveness?.(entry) ?? 'live',
    }),
  }));
}
