import * as vscode from 'vscode';
import { explainCleanup, planCleanup } from '@gripterm/core';
import { say } from '../ui/say';
import type {
  CleanupItem,
  CollectOutcome,
  Logger,
  RestoreInputs,
  StorageCleaner,
  SweepOutcome,
} from '@gripterm/core';

export const CLEAN_UP_STORAGE_COMMAND = 'gripterm.cleanUpStorage';

/** The word this command is confirmed by. It says what happens, not "yes". */
const CONFIRM = 'Move to Trash';

/**
 * How many records the dialog names before it stops.
 *
 * A modal a person cannot read is not a list before a confirmation, it is a
 * confirmation with a wall in front of it. The whole list goes to the log first
 * -- every time, not only when it is long -- so the cap costs nothing that
 * cannot be looked at.
 */
const LISTED_AT_MOST = 10;

/**
 * What cleaning up needs, and it is all or nothing: the store to work on and
 * the world to judge it by.
 */
export interface CleanupBase {
  readonly cleaner: StorageCleaner;
  /**
   * The same gatherer activation and adoption use.
   *
   * Not a convenience: the cleanup's rule is "nothing that any window could
   * bring back", and the only way that rule can be trusted is if it is read off
   * the same world the restore predicate is read off. A second gatherer would
   * disagree somewhere nobody looks, and the disagreement would be a record
   * moved away from the window about to resume it.
   */
  readonly gather: () => Promise<RestoreInputs>;
  /** Days a batch survives in the trash, for the sentence before the confirmation. */
  readonly retentionDays: number;
}

export interface CleanUpStorageParts {
  /** `null` in a window that is not reading the shared store. */
  readonly base: CleanupBase | null;
  readonly logger: Logger;
}

/**
 * `gripterm.cleanUpStorage` -- takes out of the store what no window can act on
 * any more (M2.15).
 *
 * **Why it exists.** The store is one directory per machine and it outlives
 * everything: uninstalling the extension does not touch it (§4.8), and no rule
 * elsewhere in this build ever removes a record. Two kinds of rubbish
 * accumulate. Records a person closed, or whose conversation nothing was ever
 * said in, belonging to windows that are gone -- rows that can only ever refuse.
 * And directories holding no readable record at all, which every deletion leaves
 * behind (`remove` takes the two cards and leaves the journal) and which no list
 * in this build can even show.
 *
 * **The precondition is a predicate, not a checkbox.** What may go is decided by
 * `planCleanup` over the same world the restore predicate reads, and its rules
 * fail towards leaving things alone: a window that is merely silent, a project
 * this window does not have open, a Claude Code that could not be asked -- every
 * one of them keeps a record where it is. The one thing the person is trusted to
 * decide is whether the list in front of them is rubbish.
 *
 * **Nothing here deletes anything.** Every swept directory is moved whole into
 * `trash/<stamp>/`, keeping its name and everything under it, so undoing a
 * cleanup is moving a folder back (§I.3). The list is shown BEFORE the
 * confirmation and written to the log before that, so the way back is not the
 * only trace.
 */
export function registerCleanUpStorage(parts: CleanUpStorageParts): vscode.Disposable {
  return vscode.commands.registerCommand(CLEAN_UP_STORAGE_COMMAND, async () => {
    const { base, logger } = parts;
    if (base === null) {
      say(
        'info',
        'Gripterm: this window is not reading the shared store, so it has no store to clean up.',
        logger
      );
      return;
    }

    try {
      await run(base, logger);
    } catch (cause: unknown) {
      logger.error('the store could not be cleaned up', { cause });
      say('error', 'Gripterm: the store could not be cleaned up, see the log.', logger);
    }
  });
}

async function run(base: CleanupBase, logger: Logger): Promise<void> {
  const world = await base.gather();
  const plan = planCleanup(world);
  // The ids that were READ, so that a directory is called nameless only when
  // this very reading could not name it.
  const known = new Set(world.entries.map((entry) => entry.terminalId.value));
  const strays = await base.cleaner.strays(known);

  if (plan.sweep.length === 0 && strays.length === 0) {
    // Still a pass over the trash: the person asked for the store to be tidied,
    // and what the daily pass would have done today is part of that.
    const collected = await base.cleaner.collect();
    say(
      'info',
      `Gripterm: nothing to clean up — every one of the ${plan.kept} records is in use or ` +
        `belongs to a window that is still there${tail(collected)}.`,
      logger
    );
    return;
  }

  for (const item of plan.sweep) {
    logger.info('a record is offered for the trash', {
      terminalId: item.entry.terminalId.value,
      name: item.entry.metadata.displayName,
      folder: item.entry.owner.workspaceFolder,
      owner: item.entry.owner.ownerId.value,
      reason: item.reason,
    });
  }
  if (strays.length > 0) {
    logger.info('directories holding no readable record are offered for the trash', {
      directories: strays,
    });
  }

  const answer = await vscode.window.showWarningMessage(
    `Move ${count(plan.sweep.length + strays.length)} out of the Gripterm store?`,
    { modal: true, detail: detailFor(plan.sweep, strays, base.retentionDays) },
    CONFIRM
  );
  // Anything but the button -- Cancel, Escape, the dialog closing -- is no.
  if (answer !== CONFIRM) {
    return;
  }

  const outcome = await base.cleaner.sweep([
    ...plan.sweep.map((item) => item.entry.terminalId.value),
    ...strays,
  ]);
  const collected = await base.cleaner.collect();
  report(outcome, collected, logger);
}

function report(outcome: SweepOutcome, collected: CollectOutcome, logger: Logger): void {
  const home = `trash/${outcome.batch} in your Gripterm storage folder`;
  if (outcome.failed.length > 0) {
    say(
      'warning',
      `Gripterm: moved ${count(outcome.moved.length)} to ${home}; ` +
        `${count(outcome.failed.length)} could not be moved, see the log.`,
      logger
    );
    return;
  }
  say(
    'info',
    `Gripterm: moved ${count(outcome.moved.length)} to ${home} — move the folder back to undo` +
      `${tail(collected)}.`,
    logger
  );
}

/**
 * What the person is agreeing to: every record by name, and what it is that
 * makes it rubbish.
 *
 * The reason per row rather than one sentence for the lot, because the two
 * reasons are not equally easy to agree with. "Its terminal was closed" is a
 * person's own act; "nothing was ever said in its conversation" is a terminal
 * they may have named and meant to come back to -- and that is exactly the row
 * they should be able to see and cancel over.
 */
function detailFor(
  sweep: readonly CleanupItem[],
  strays: readonly string[],
  retentionDays: number
): string {
  const lines = sweep
    .slice(0, LISTED_AT_MOST)
    .map((item) => `• "${item.entry.metadata.displayName}" — ${explainCleanup(item.reason)}`);
  if (sweep.length > LISTED_AT_MOST) {
    lines.push(`• and ${sweep.length - LISTED_AT_MOST} more — the whole list is in the Gripterm log.`);
  }
  if (strays.length > 0) {
    lines.push(
      `• ${count(strays.length)} left in the store with no record in them, which nothing can show you.`
    );
  }
  return (
    `${lines.join('\n')}\n\nEach one moves whole into a single folder in the trash, keeping its ` +
    'name, its history and its notes, so putting one back is moving its folder into ' +
    `terminals/. Nothing is deleted now; the trash itself is cleared after ${retentionDays} ` +
    'days (gripterm.journal.retentionDays). Claude Code\'s own conversations are not touched.'
  );
}

/** What the pass over the trash did, said only when it did something -- or would not. */
function tail(collected: CollectOutcome): string {
  if (collected.refused !== null) {
    // Said here rather than left in the log, because the person is standing in
    // front of the dialog they asked for: a pass that did not happen is part of
    // the answer to what they just clicked.
    return `, and the trash itself was left as it is — ${collected.refused}`;
  }
  if (collected.expired.length === 0) {
    return '';
  }
  const batches = collected.expired.length === 1 ? '1 batch' : `${collected.expired.length} batches`;
  return `, and the trash lost ${batches} older than the retention`;
}

function count(items: number): string {
  return items === 1 ? '1 item' : `${items} items`;
}
