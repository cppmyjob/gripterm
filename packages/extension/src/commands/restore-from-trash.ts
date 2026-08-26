import * as vscode from 'vscode';
import { labelOf, offerOf, restoredSentence } from './trash-offer';
import type { Announcer } from '../ui/say';
import type { Logger, TrashStore } from '@gripterm/core';
import type { Picker } from '../ui/pick';

export const RESTORE_FROM_TRASH_COMMAND = 'gripterm.restoreFromTrash';

export interface RestoreFromTrashParts {
  /** `null` in a window that is not reading the shared store. */
  readonly trash: TrashStore | null;
  readonly picker: Picker;
  /**
   * Through the announcer rather than through `say` directly, and it is the one
   * command in this build that does.
   *
   * `say.ts` says why the seam exists and why the other commands may skip it:
   * they are checked by WHERE they appear, because no suite executes them. This
   * one is executed by a suite -- it is the whole of what "brought back from the
   * interface" means -- so the sentence it produces has to be readable from
   * inside a run, and a notification cannot be read back through the editor API.
   */
  readonly announcer: Announcer;
  readonly logger: Logger;
}

/**
 * `gripterm.restoreFromTrash` -- the way back out of `trash/` (Ш15).
 *
 * **Why it exists.** Four things in this build put a person's record into
 * `trash/`, and every one of them was written as reversible on the strength of
 * one sentence: the folder is still in the trash. That sentence was true and
 * useless. Reversing it meant knowing where the store is, which of two dozen
 * stamped folders holds the record, and which directory to drag it into -- so
 * "reversible" meant reversible by somebody who could copy directories by hand,
 * and the retention was quietly deleting the undo of everybody else.
 *
 * **What it shows is the three FORMS, not one list of folders**, because they do
 * not mean the same thing and a person choosing between them is choosing between
 * different acts: a whole terminal folder that is gone from the store, the two
 * cards of a record whose folder never left, and a presence file belonging to
 * another window. The detail line says which, and what putting it back would do.
 *
 * **Nothing here overwrites anything and nothing is moved.** `TrashStore` copies
 * and then removes, so a return dropped half way leaves the copy in the trash
 * where it was; this command's part of that bargain is to say what happened
 * rather than to assume it -- including the case where the record is back and its
 * copy could not be taken away.
 *
 * No confirmation. This is the one command in the build that only ever GIVES
 * something back, and the modal in front of it would be a question whose wrong
 * answer costs nothing.
 */
export function registerRestoreFromTrash(parts: RestoreFromTrashParts): vscode.Disposable {
  return vscode.commands.registerCommand(RESTORE_FROM_TRASH_COMMAND, async () => {
    const { trash, picker, announcer, logger } = parts;
    if (trash === null) {
      announcer.say(
        'info',
        'Gripterm: this window is not reading the shared store, so it has no trash to look in.'
      );
      return;
    }

    try {
      await run(trash, picker, announcer, logger);
    } catch (cause: unknown) {
      logger.error('nothing could be brought back out of the trash', { cause });
      announcer.say('error', 'Gripterm: nothing could be brought back out of the trash, see the log.');
    }
  });
}

async function run(
  trash: TrashStore,
  picker: Picker,
  announcer: Announcer,
  logger: Logger
): Promise<void> {
  const items = await trash.list();
  if (items.length === 0) {
    announcer.say(
      'info',
      'Gripterm: there is nothing in the Gripterm trash — either nothing has been thrown away, ' +
        'or the retention has already cleared it.'
    );
    return;
  }

  const chosen = await picker.pick(items.map(offerOf), {
    title: 'Restore from Trash',
    placeHolder: 'Which one goes back into the store?',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  // Anything but a choice -- Escape, the list closing -- is no.
  if (chosen === undefined) {
    return;
  }

  const { item } = chosen;
  logger.info('a person is bringing something back out of the trash', {
    batch: item.batch,
    name: item.name,
    form: item.form,
    from: item.from,
    to: item.to,
  });
  try {
    const outcome = await trash.restore(item);
    announcer.say('info', restoredSentence(item, outcome.files.length, outcome.trashCopyRemoved));
  } catch (cause: unknown) {
    logger.warn('something could not be brought back out of the trash', {
      batch: item.batch,
      name: item.name,
      cause,
    });
    announcer.say('warning', `Gripterm: "${labelOf(item)}" was not brought back — ${String(cause)}`);
  }
}
