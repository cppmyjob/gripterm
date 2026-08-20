import * as vscode from 'vscode';
import { disposalOf, presentTerminal } from '@gripterm/core';
import { DISCARDABLE_ROWS, whichTerminal } from './pick-terminal';
import { say } from '../ui/say';
import type {
  Logger,
  OwnerLiveness,
  RecordDisposal,
  Reconciler,
  SessionRegistry,
  StorageCleaner,
  TerminalEntry,
  TerminalLifecycleService,
} from '@gripterm/core';

export const DELETE_TERMINAL_COMMAND = 'gripterm.deleteTerminal';

/** The button, and the word this command is confirmed by. One word per case. */
const CONFIRM = 'Delete Record';
const CONFIRM_SILENT = 'Delete Anyway';

/**
 * What throwing away somebody ELSE's record needs, and it is both or neither.
 *
 * The store to move the directory in, and the sweep that says whether anybody is
 * still answering for it. A window with no shared base has neither and needs
 * neither: it holds nothing but its own records.
 */
export interface DisposalBase {
  readonly cleaner: StorageCleaner;
  readonly reconciler: Reconciler;
}

export interface DeleteTerminalParts {
  readonly lifecycle: TerminalLifecycleService;
  readonly registry: SessionRegistry;
  /** `null` in a window that is not reading the shared store. */
  readonly base: DisposalBase | null;
  readonly logger: Logger;
}

/**
 * `gripterm.deleteTerminal` -- the person is throwing the record away (M2.7).
 *
 * **The dialog names what survives, not only what goes**, and that is the whole
 * of the acceptance criterion this command exists for. A person deleting a row
 * from a list of terminals has every reason to fear they are deleting the
 * conversation behind it; they are not, and a confirmation that left them to
 * guess would be a confirmation of something they did not understand. What
 * survives is said in the same breath as what does not: the Claude Code
 * conversation, which is not ours and which this codebase never writes to, and
 * -- on our own records -- the event journal, which no later version can go back
 * for (§10.1а).
 *
 * **Modal on purpose.** A toast with a button can be missed, is dismissed by
 * accident, and does not stop the person carrying on. This is the one command in
 * the extension that takes something away.
 *
 * The record goes to `trash/<stamp>/` rather than to nothing, which is what
 * makes it an act somebody can undo (§I.3). That is said in the dialog as well,
 * because a promise a person only learns about after they needed it is not a
 * promise they could use.
 *
 * **IT ALSO DELETES A RECORD THIS WINDOW DOES NOT OWN (M2.22).** Not a second
 * command and not a second dialog: from the person's side there is one act, and
 * splitting it would have meant a row whose menu says "Delete Record" and a row
 * whose menu says something else for the same reason. What differs is on the
 * inside -- `disposalOf` decides, the lifecycle service discards a record of
 * ours and the cleaner moves a directory of somebody else's -- and in the
 * sentence the dialog adds about whose window it was.
 *
 * That is a write into another window's territory, and it is bounded by the same
 * rule adoption uses: only where NOBODY is answering for the record. While that
 * window is there it is the single writer of it (§4.8) and this command refuses.
 * Once it is not, the record has no writer at all, and until this existed such a
 * row could not be got rid of from anywhere -- which is what the owner reported
 * on 2026-08-13 as "detached records I cannot delete".
 */
export function registerDeleteTerminal(parts: DeleteTerminalParts): vscode.Disposable {
  return vscode.commands.registerCommand(DELETE_TERMINAL_COMMAND, async (target: unknown) => {
    const { lifecycle, registry, base, logger } = parts;
    // A window with no shared base sees only its own records, so "every owner is
    // answering" is the truthful reading there rather than a fallback: the only
    // owner it can be asked about is itself.
    const livenessOf = (entry: TerminalEntry): OwnerLiveness =>
      base === null ? 'live' : base.reconciler.livenessOf(entry.owner.ownerId);

    const terminalId = await whichTerminal(registry, logger, {
      target,
      title: 'Delete Record',
      placeHolder: 'Delete the record of which terminal?',
      rows: DISCARDABLE_ROWS,
      whenEmpty:
        'Gripterm: there is no record to delete — every terminal of this window is still ' +
        'running, and every other record belongs to a window that is still there.',
      // Asked even when there is one (M2.18). The modal below names what goes
      // and what stays, and this is where the person reads WHICH record that
      // is about.
      whenSole: 'ask',
      // Nothing moved to the top, for the reason above: this list is read, not
      // answered by reflex.
      showing: null,
      liveness: livenessOf,
    });
    if (terminalId === null) {
      return;
    }

    // `list()` and not `get()`: the record may be another window's, and this is
    // the one command that acts on those as well.
    const entry = registry.list().find((one) => one.terminalId.equals(terminalId));
    if (entry === undefined) {
      // Gone between the picker and the choice. Nothing to confirm and nothing
      // to say: what they asked for is already true.
      return;
    }

    const ours = registry.knows(terminalId);
    const liveness = livenessOf(entry);
    const disposal = disposalOf(ours, liveness);
    const label = presentTerminal(entry, { ours, liveness }).label;
    if (disposal.kind === 'owned-elsewhere') {
      // Reachable from a row drawn a moment before that window answered again.
      say(
        'warning',
        `Gripterm: "${label}" belongs to a window that is still there, and only that window can throw it away.`,
        logger
      );
      return;
    }

    const confirm = disposal.kind === 'abandoned' && disposal.liveness === 'unknown'
      ? CONFIRM_SILENT
      : CONFIRM;
    const answer = await vscode.window.showWarningMessage(
      `Delete Gripterm's record of "${label}"?`,
      { modal: true, detail: detailFor(entry, disposal) },
      confirm
    );
    // Anything but the button -- Cancel, Escape, the dialog closing -- is no.
    if (answer !== confirm) {
      return;
    }

    if (disposal.kind === 'ours') {
      if (lifecycle.discard(terminalId) === 'still-running') {
        say('warning', 'Gripterm: close this terminal before deleting its record.', logger);
      }
      return;
    }
    await sweep({ base, entry, label, logger });
  });
}

/**
 * Moves another window's record out of the store, and says where it went.
 *
 * The whole directory, which is the difference from a record of ours worth
 * saying out loud: `discard` takes the two cards and leaves the journal in
 * place, because this window goes on holding that terminal's history. Here
 * there is nobody to hold it, so the folder travels whole -- name, history,
 * journal -- and putting it back is one move.
 */
async function sweep(parts: {
  readonly base: DisposalBase | null;
  readonly entry: TerminalEntry;
  readonly label: string;
  readonly logger: Logger;
}): Promise<void> {
  const { base, entry, label, logger } = parts;
  if (base === null) {
    // Unreachable through a row -- a window with no base holds no record of
    // anybody else's -- and said rather than assumed away.
    say('warning', 'Gripterm: this window is not reading the shared store, so it cannot move that record.', logger);
    return;
  }

  const terminalId = entry.terminalId.value;
  logger.info('a record of another window is being thrown away by a person', {
    terminalId,
    name: entry.metadata.displayName,
    owner: entry.owner.ownerId.value,
    folder: entry.owner.workspaceFolder,
  });
  try {
    const outcome = await base.cleaner.sweep([terminalId]);
    if (outcome.moved.length === 0) {
      say('warning', `Gripterm: "${label}" could not be moved out of the store, see the log.`, logger);
      return;
    }
    say(
      'info',
      `Gripterm: "${label}" was moved to trash/${outcome.batch} in your Gripterm storage folder — move the folder back to undo.`,
      logger
    );
  } catch (cause: unknown) {
    logger.error('a record of another window could not be thrown away', {
      terminalId,
      reason: String(cause),
    });
    say('error', `Gripterm: "${label}" could not be moved out of the store, see the log.`, logger);
  }
}

/**
 * What the person is agreeing to, in the words of the case they are in.
 *
 * Three sentences that are all about the same fear -- "am I deleting the
 * conversation" -- answered first and in every case. What the two foreign cases
 * add is whose record this is, because a person who has ten projects on one
 * machine sees rows of windows they have never had open.
 *
 * The `unknown` half says the thing this build cannot know: a stale heartbeat is
 * also what an editor asleep looks like. The cost of being wrong is small and
 * reversible -- that window rewrites its record when it comes back, and the
 * folder is in the trash meanwhile -- which is exactly why it is offered at all,
 * and why saying so is enough.
 */
function detailFor(entry: TerminalEntry, disposal: RecordDisposal): string {
  const kept = 'The Claude Code conversation is kept — this deletes Gripterm\'s record of the terminal, not the conversation behind it.';
  if (disposal.kind === 'ours') {
    return (
      `${kept} So is this terminal's event journal. What goes is the record — its name, task, ` +
      'notes and tags — and it is moved to the trash folder of your Gripterm storage rather ' +
      'than deleted.'
    );
  }

  const whose = entry.owner.workspaceFolder ?? 'a window with no folder open';
  const window = disposal.kind === 'abandoned' && disposal.liveness === 'unknown'
    ? `The window that opened it (${whose}) has stopped saying it is there, but has NOT been ` +
      'established to be gone — which is also what a sleeping or stalled editor looks like. If ' +
      'it is in fact still open, it will write this record again.'
    : `The window that opened it (${whose}) is gone, so no window is keeping this record.`;
  return (
    `${window}\n\n${kept} What goes is this terminal's whole Gripterm folder — its name, task, ` +
    'notes, tags and its event journal — moved into the trash folder of your Gripterm storage ' +
    'rather than deleted, so putting it back is moving one folder.'
  );
}
