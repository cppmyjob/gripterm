import * as vscode from 'vscode';
import { explainRefusal, planRestore, presentTerminal } from '@gripterm/core';
import { ADOPTABLE_ROWS, whichTerminal } from './pick-terminal';
import { wayOut } from './way-out';
import { say } from '../ui/say';
import type {
  Logger,
  OwnerLiveness,
  Reconciler,
  RestoreInputs,
  RestoreOrchestrator,
  SessionRegistry,
  TerminalEntry,
} from '@gripterm/core';

export const ADOPT_TERMINAL_COMMAND = 'gripterm.adoptTerminal';

/** The button, and the word this command is confirmed by. One word per case. */
const CONFIRM_GONE = 'Adopt';
const CONFIRM_SILENT = 'Adopt Anyway';

/**
 * What taking a record over needs, and it is all or nothing.
 *
 * The three arrive together or not at all -- they are what a shared base is made
 * of -- so they are one field rather than three that would have to be checked
 * for null one at a time and could be got wrong in two of the three ways.
 */
export interface AdoptionBase {
  /** The sweep, which is where a foreign owner's liveness comes from. */
  readonly reconciler: Reconciler;
  readonly orchestrator: RestoreOrchestrator;
  /**
   * The world the predicate needs, gathered exactly as activation gathers it.
   *
   * Passed in rather than built here so that the manual path and the automatic
   * one ask the same questions of the same machine -- a second gatherer would
   * disagree with the first somewhere nobody looks, and the disagreement would
   * be about whether a `claude` is running.
   */
  readonly gather: () => Promise<RestoreInputs>;
}

export interface AdoptTerminalParts {
  readonly registry: SessionRegistry;
  /** `null` in a window that is not reading the shared store. */
  readonly base: AdoptionBase | null;
  readonly logger: Logger;
}

/**
 * `gripterm.adoptTerminal` -- this window takes over another window's terminal
 * and brings its conversation back here (M2.14).
 *
 * **Why it exists at all.** Restoring is deliberately narrower than seeing (§6):
 * a window brings back only the records of ITS OWN folders, and only when the
 * owning window is established to be gone. Everything else is visible, marked,
 * and frozen -- which without a manual branch would mean frozen for ever. Two
 * cases need it: another project's terminals, whose window may never open again,
 * and an owner the store calls `unknown`, which no automatic rule may ever
 * displace.
 *
 * **The decision is not made here.** The command asks `planRestore` with the
 * record named as demanded, which lifts exactly two refusals -- the folder and
 * the stale heartbeat -- and lifts nothing about the conversation. So the answer
 * to "is a `claude` already running this" comes from the same predicate that
 * answers it at activation, and the sentences a person reads are the union's own
 * (`explainRefusal`). A second predicate here is what would eventually put two
 * processes on one transcript.
 *
 * **The dialog is modal, and it says which of the two cases this is.** A window
 * that is gone is ordinary. A window that is there and silent is the O3 hazard
 * itself: it is what a sleeping editor looks like, and adopting one starts a
 * second Claude Code on a live conversation. The person is the only one who can
 * know which it is, so the dialog says what to check rather than asking them to
 * agree with us.
 */
export function registerAdoptTerminal(parts: AdoptTerminalParts): vscode.Disposable {
  return vscode.commands.registerCommand(ADOPT_TERMINAL_COMMAND, async (target: unknown) => {
    const { registry, base, logger } = parts;
    if (base === null) {
      // No shared base: this window sees nothing but its own records, so there
      // is nothing of anybody else's here to take.
      say(
        'info',
        'Gripterm: this window is not reading the shared store, so it holds no other window\'s terminals.',
        logger
      );
      return;
    }

    const terminalId = await whichTerminal(registry, logger, {
      target,
      title: 'Take Over Terminal',
      placeHolder: 'Take over which terminal?',
      rows: ADOPTABLE_ROWS,
      // Asked even when there is one (M2.18): this takes a record from
      // another window, and the row says whose window and when it last spoke.
      whenSole: 'ask',
      whenEmpty: 'Gripterm: every terminal of another window belongs to a window that is still answering.',
      // Nothing of ours is a candidate here -- every row belongs to another
      // window -- so there is no terminal of this screen to put first.
      showing: null,
      liveness: (entry) => base.reconciler.livenessOf(entry.owner.ownerId),
    });
    if (terminalId === null) {
      return;
    }

    const entry = registry.list().find((one) => one.terminalId.equals(terminalId));
    if (entry === undefined) {
      // It left the base between the row and the click. Nothing to take, and
      // the list has already stopped showing it.
      return;
    }
    if (registry.knows(terminalId)) {
      say('info', `Gripterm: "${entry.metadata.displayName}" is already this window's.`, logger);
      return;
    }

    const liveness = base.reconciler.livenessOf(entry.owner.ownerId);
    if (liveness === 'live') {
      // Refused before the dialog rather than after it: there is nothing for a
      // person to decide while that window is plainly running.
      say('warning', `Gripterm: ${explainRefusal('owner-live')}.`, logger);
      return;
    }

    const label = presentTerminal(entry, { ours: false, liveness }).label;
    const confirm = liveness === 'unknown' ? CONFIRM_SILENT : CONFIRM_GONE;
    const answer = await vscode.window.showWarningMessage(
      `Take "${label}" over and resume its conversation in this window?`,
      { modal: true, detail: detailFor(entry, liveness) },
      confirm
    );
    // Anything but the button -- Cancel, Escape, the dialog closing -- is no.
    if (answer !== confirm) {
      return;
    }

    logger.info('a person asked this window to take over another window\'s terminal', {
      terminalId: terminalId.value,
      owner: entry.owner.ownerId.value,
      liveness,
      folder: entry.owner.workspaceFolder,
    });

    try {
      await take(base, logger, entry, label);
    } catch (cause: unknown) {
      logger.error('a terminal could not be taken over', {
        terminalId: terminalId.value,
        cause,
      });
      say('error', `Gripterm: "${label}" could not be taken over, see the log.`, logger);
    }
  });
}

/** The plan for one record, carried out, and what to tell the person about it. */
async function take(
  base: AdoptionBase,
  logger: Logger,
  entry: TerminalEntry,
  label: string
): Promise<void> {
  const plan = planRestore({ ...(await base.gather()), demanded: entry.terminalId });

  const refused = plan.skipped.at(0);
  if (refused !== undefined) {
    // The predicate said no, and it says why. This is the branch that keeps a
    // person from starting a second process on a conversation they cannot see.
    say(
      'warning',
      `Gripterm: "${label}" was not taken over — ${explainRefusal(refused.reason)}.${wayOut(refused.reason)}`,
      logger
    );
    return;
  }
  if (plan.steps.length === 0) {
    // Neither planned nor refused: the record left the base while the dialog
    // was open, which is another window deleting it or taking it first.
    say('info', `Gripterm: "${label}" is no longer in the store.`, logger);
    return;
  }

  const report = await base.orchestrator.run(plan);
  if (report.started === 1) {
    // Its pane is revealed by the orchestrator when the conversation answers,
    // or when the wait runs out -- which can be twenty seconds away, and a
    // person who clicked a button deserves to know it was taken.
    say('info', `Gripterm: "${label}" is this window's now — its terminal opens as soon as it answers.`, logger);
    return;
  }
  if (report.attempts.at(0)?.outcome === 'unstartable') {
    say('error', `Gripterm: "${label}" is this window's now, but its terminal could not be started. See the log.`, logger);
    return;
  }
  say('warning', `Gripterm: "${label}" was taken by another window first.`, logger);
}

/**
 * What the person is agreeing to, in the words of the case they are in.
 *
 * The `unknown` half is the one that matters. It is not a warning for form's
 * sake: a stale heartbeat is what a sleeping or stalled editor looks like, the
 * store refuses this adoption without `force` precisely because of that, and the
 * damage -- two Claude Code processes writing one transcript -- is not
 * something this extension can undo afterwards.
 */
function detailFor(entry: TerminalEntry, liveness: OwnerLiveness): string {
  const common =
    `A Claude Code terminal opens here, in ${entry.launch.cwd}, resuming the conversation ` +
    `${entry.sessionId.value}, and this window becomes the owner of the record — its name, ` +
    'task, notes and tags come with it.';
  if (liveness === 'unknown') {
    return (
      `${common}\n\nThe window that opened it has stopped saying it is there, but its process ` +
      'has NOT been established to be gone — which is also what a sleeping or stalled editor ' +
      'looks like. If that window is in fact still open, this starts a second Claude Code on ' +
      'one conversation and their messages end up mixed in one transcript. Check that it is ' +
      'closed before continuing.'
    );
  }
  return `${common}\n\nThe window that opened it is gone.`;
}
