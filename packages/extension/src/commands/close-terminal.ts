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
 * **One dialog on every road, and never none (M3.14).** Where the person was
 * handed a picker, the picker IS the last place they see what they are about to
 * end, and Escape backs out of it. Where they were not -- the cross on a tab of
 * our strip, a menu on a tree row -- they are asked here. The acceptance run
 * found the cross ending a live conversation on a single click at a target the
 * width of a tab's corner, which is a slip away from every click that merely
 * switches tabs, and the owner decided on 2026-08-20 that a live conversation
 * is worth a question. A conversation already over is not: that cross only
 * takes a tab away.
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
