import * as vscode from 'vscode';
import {
  BRING_IT_BACK,
  END_IT_FOR_GOOD,
  answerAfterClosing,
  closedInTheEditorOffer,
} from '@gripterm/core';
import type { Logger, SessionRegistry, TerminalEntry } from '@gripterm/core';

/**
 * The question the editor's own cross does not ask, asked afterwards.
 *
 * **Why afterwards and not before.** There is no event before it. The editor
 * closes the terminal and tells us it has -- `onDidCloseTerminal` -- so a build
 * that wanted a dialog in front of that gesture would need a seam the platform
 * does not offer. The owner met the gap on 2026-08-27 and chose this over a
 * build that guesses which gesture it was, with the price named in his own
 * terms: five tabs, five questions.
 *
 * **A notification and not a modal, deliberately.** A modal here would stop the
 * editor on every tab a person closes, and `workbench.action.closeAllEditors`
 * would put five of them in a row in front of somebody who was tidying. What
 * this is allowed to cost is attention, not the window.
 *
 * **HOW LONG IT IS IN FRONT OF THEM, measured 2026-08-27 in the shipped
 * workbench of VS Code 1.135.0, because the answer decides whether this closes
 * the owner's report at all.** `NotificationsToasts.PURGE_TIMEOUT` is
 * `{Info:1e4, Warning:12e3, Error:15e3}` and a notification is sticky only when
 * `hasActions && severity === Error` (`get sticky()`). So an INFO toast WITH
 * buttons -- which is this one -- is taken off the screen after ten seconds.
 * Making it stick would mean calling it an error, and nothing here failed.
 *
 * What the ten seconds do NOT do is take the question away: `purgeNotification`
 * calls `removeToast`, not close, so the offer and both its buttons stay in the
 * notification centre until somebody dismisses them. The timer also restarts
 * while the pointer is over the toast or it has focus, and does not run at all
 * while the window is unfocused -- so it is ten seconds of a person being AT
 * this window, not ten seconds of clock. **The consequence, stated rather than
 * discovered:** a person who closes a tab and looks away answers this from the
 * bell or not at all, and not answering leaves the record exactly as the editor
 * left it -- which is the state the owner reported on 2026-08-27.
 *
 * **WHAT NO SUITE PROVES ABOUT THIS FILE, said here rather than discovered
 * later.** The words, the three outcomes and the record's two transitions are
 * checked by `jest` -- `closed-in-the-editor.test.ts`, `terminal-entry.test.ts`
 * and `terminal-lifecycle.test.ts`. What is NOT checked anywhere is that the
 * toast reaches a screen and that pressing a button amends the record, because
 * a suite cannot answer `showInformationMessage`: M3.13 measured that replacing
 * `vscode.window` from a run does not reach the object this bundle calls, which
 * is why `ui/ask.ts` exists for the one modal a run drives. The live suite pins
 * the DEFAULT instead -- a close in the editor with nobody pressing anything
 * leaves the record `closedBy: 'editor'` (`closing-a-terminal.test.ts`) -- so
 * the outcome most people get is measured and the two pressed ones are not.
 * REMOVED WHEN: this offer goes through a seam of ours the way the modal does.
 *
 * **The record is read again before it is written.** Between the offer going up
 * and a button being pressed a person may have deleted the record, brought it
 * back from its row, or another window may have taken it over -- so the entry
 * the service handed us is the SUBJECT of the question and never the value
 * written back.
 */
export function offerToBringItBack(
  registry: SessionRegistry,
  logger: Logger,
  closed: TerminalEntry
): void {
  void ask(registry, logger, closed).catch((cause: unknown) => {
    // A question that could not be put is a record left exactly as the editor
    // left it, which is the same answer as nobody pressing anything.
    logger.warn('a terminal closed in the editor could not be asked about', {
      terminalId: closed.terminalId.value,
      cause,
    });
  });
}

async function ask(
  registry: SessionRegistry,
  logger: Logger,
  closed: TerminalEntry
): Promise<void> {
  const pressed = await vscode.window.showInformationMessage(
    closedInTheEditorOffer(closed.metadata.displayName),
    BRING_IT_BACK,
    END_IT_FOR_GOOD
  );
  const answer = answerAfterClosing(pressed);
  if (answer === 'no-answer') {
    return;
  }

  const { terminalId } = closed;
  const now = registry.get(terminalId);
  if (now?.closedAt == null) {
    // Deleted, or already brought back from its own row. Either way the person
    // has since said something about this record with more of it in front of
    // them than a toast, and that is the answer that stands.
    logger.info('an answer arrived about a record that had already moved on', {
      terminalId: terminalId.value,
      answer,
    });
    return;
  }

  registry.amend(answer === 'bring-it-back' ? now.reopened() : now.closedForGood());
  logger.info('a person said what they meant by closing a terminal in the editor', {
    terminalId: terminalId.value,
    answer,
  });
}
