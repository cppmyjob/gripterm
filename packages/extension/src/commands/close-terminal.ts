import * as vscode from 'vscode';
import { CONTEXT_LIVE, presentTerminal, terminalTargetOf } from '@gripterm/core';
import { whichTerminal } from './pick-terminal';
import type { Asker } from '../ui/ask';
import type {
  Logger,
  SessionRegistry,
  TerminalId,
  TerminalLifecycleService,
} from '@gripterm/core';

export const CLOSE_TERMINAL_COMMAND = 'gripterm.closeTerminal';

/** The word this is confirmed by. It says what happens, not "yes". */
const CONFIRM = 'End Conversation';

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
 *
 * **One dialog on every road THAT COMES THROUGH HERE -- which is not every
 * road, and until 2026-08-27 this block said otherwise.** Where the person was
 * handed a picker, the picker IS the last place they see what they are about to
 * end, and Escape backs out of it. Where they were not -- a menu on a tree row,
 * the cross on a tab of the DRAWN strip -- they are asked here. The acceptance
 * run found that cross ending a live conversation on a single click at a target
 * the width of a tab's corner, which is a slip away from every click that merely
 * switches tabs, and the owner decided on 2026-08-20 that a live conversation is
 * worth a question. A conversation already over is not: that cross only takes a
 * tab away.
 *
 * **"OUR STRIP" IS TWO DIFFERENT THINGS, and this block used to say it as if it
 * were one -- which is how the owner came to read it as covering his cross.**
 * The DRAWN strip is `ui/terminal-strip.ts`: tabs we paint inside our own
 * webview, and the only cross in the build that reaches this command
 * (`executeCommand(CLOSE_TERMINAL_COMMAND)`). It exists under
 * `gripterm.terminal.engine: own` and nowhere else. The other is
 * `VsCodeEditorStrip` -- `gripterm.launch.location: group`, the default of that
 * setting -- a group of the editor area whose tabs are the EDITOR'S, drawn by
 * the workbench, closed by the workbench. That is the strip the owner was
 * looking at. Since 2026-08-30 it is no longer what a window with no settings
 * gets: `gripterm.terminal.engine` defaults to `own`, which does not read
 * `gripterm.launch.location` at all, so reaching this strip now takes choosing
 * `editor`. What the owner was looking at is still there; it is one setting
 * further away.
 *
 * **On that road there is no dialog before the fact, and there cannot be.** The
 * editor closes the terminal and tells us afterwards, through
 * `onDidCloseTerminal` and `TerminalLifecycleService._noteDeliberateClose`.
 * Nothing in `packages/extension` turns that gesture into
 * `CLOSE_TERMINAL_COMMAND`, and nothing can: the platform raises no event
 * before the close for anybody to answer. The owner reported the gap on
 * 2026-08-27 -- "нажимаю на таб закрытия терминала - нет сообщения
 * предупреждения" -- and it was a defect of this sentence as much as of the
 * build, because the sentence had claimed the road was covered.
 *
 * **What is on that road now: a question AFTER the fact** (owner's decision,
 * 2026-08-27; `ui/closing-offer.ts` and `closedInTheEditorOffer`). The record is
 * stamped closed as it always was, and then the person is offered two named
 * buttons -- `Bring It Back`, which takes the close off the record, and `End It
 * For Good`, which writes `person` and lets the sweep have it. Ignoring the
 * offer is not an answer and leaves the record exactly as it is. The price is
 * the owner's own: five tabs closed at once are five questions, and folding
 * them into one was left undone on purpose.
 *
 * **What is NOT promised, and it is somebody else's setting.**
 * `terminal.integrated.confirmOnKill` defaults to `editor` and asks only when
 * the terminal `hasChildProcesses` -- a condition we neither set nor can read.
 * Both halves were read out of the shipped workbench of VS CODE 1.135.0 on
 * 2026-08-27 (`default:"editor"`, and
 * `(e==="editor"||e==="always")&&this._terminalInstance?.hasChildProcesses`).
 * **The fork the owner works in was not measured**, and the report is his, so
 * nothing here says what Cursor does with either. This build relies on none of
 * it: the offer above is ours and stands whatever that setting says.
 *
 * It answers `true` when the record was closed, because the strip must not take
 * a tab away from a person who said no.
 */
export function registerCloseTerminal(
  lifecycle: TerminalLifecycleService,
  registry: SessionRegistry,
  asker: Asker,
  logger: Logger
): vscode.Disposable {
  return vscode.commands.registerCommand(CLOSE_TERMINAL_COMMAND, async (target: unknown) => {
    // Read here as well as inside the picker, and deliberately: what decides
    // whether to ask is whether the person will have been shown a list, and
    // that is this same question. One rule, read twice, rather than two rules.
    const named = terminalTargetOf(target).kind === 'terminal';
    const terminalId = await whichTerminal(registry, logger, {
      target,
      title: 'Close Terminal',
      placeHolder: 'Close which terminal?',
      rows: [CONTEXT_LIVE],
      whenEmpty: 'Gripterm: there is no running terminal to close.',
      // Asked even when there is one, unlike the edit commands (M2.18): this
      // ends a conversation, and the picker is where a person sees which.
      whenSole: 'ask',
      // And for the same reason nothing is moved to the top of that list: an
      // Enter pressed by reflex on a pre-sorted list is the mistake this picker
      // exists to prevent.
      showing: null,
    });
    if (terminalId === null) {
      return false;
    }
    if (named && !(await agreed(registry, asker, terminalId))) {
      return false;
    }
    lifecycle.close(terminalId);
    return true;
  });
}

/**
 * Whether a person who was shown no picker means to end this conversation.
 *
 * The record is not destroyed by a close and the dialog says so: what a close
 * takes away is the automatic return at the next start, and `Resume Terminal`
 * puts that back until the sweep of the next window start carries the record
 * into Gripterm's own trash (M2.15). Naming the way back is the point -- a
 * question with no answer in it is a speed bump rather than a choice.
 */
async function agreed(
  registry: SessionRegistry,
  asker: Asker,
  terminalId: TerminalId
): Promise<boolean> {
  const entry = registry.get(terminalId);
  if (entry === undefined) {
    // Not ours to ask about: the close will find nothing either, and a dialog
    // over a record this window does not hold would be a question about nothing.
    return true;
  }
  const shown = presentTerminal(entry);
  if (shown.contextValue !== CONTEXT_LIVE) {
    return true;
  }
  return await asker.confirm(
    `End the conversation in "${shown.label}"?`,
    'The record stays here with its name, task and notes, and Resume Terminal starts the ' +
      'conversation again. What ends is the automatic return: a terminal you closed does not come ' +
      'back on its own, and the next window start moves its record into the Gripterm trash.',
    CONFIRM
  );
}
