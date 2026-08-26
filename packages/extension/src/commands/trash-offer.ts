import type { QuickPickItem } from 'vscode';
import type { TrashItem } from '@gripterm/core';

/**
 * What a person READS about the trash: one row per thing in it, and one sentence
 * once it is back.
 *
 * Its own module, and the reason is not tidiness. Everything here is a total
 * function of a `TrashItem` -- no editor, no store, no clock -- and it imports
 * `vscode` for a TYPE alone, so plain jest can hold it to its word. What sits in
 * `restore-from-trash.ts` beside it cannot be: that file registers a command,
 * which needs a running Extension Host to exist at all.
 *
 * The split is worth the file because these sentences ARE the promise of Ш15.
 * The three forms do not mean the same thing and a person choosing between them
 * is choosing between different acts, so a row that said "restore" three times
 * would be a list that hid the whole of what it was for.
 */
export interface TrashPick extends QuickPickItem {
  readonly item: TrashItem;
}

/**
 * What the person reads on one row.
 *
 * The label is the name they gave the terminal when a record in the trash still
 * says one, and the directory name otherwise -- which is not a fallback but the
 * point: what the cleanup can reach INCLUDES directories no record could be read
 * from, and a list that drew only the ones it could name would hide exactly
 * those.
 */
export function offerOf(item: TrashItem): TrashPick {
  return {
    label: labelOf(item),
    description: `in trash/${item.batch}`,
    detail: detailFor(item),
    item,
  };
}

export function labelOf(item: TrashItem): string {
  return item.displayName ?? item.name;
}

/**
 * What happened, said with the number of files rather than with "done".
 *
 * The second half is the one worth typing out: a copy that could not be taken
 * out of the trash is not a failure of the return -- the record is back -- but a
 * person who then goes to look finds two of everything, and being told beats
 * discovering it.
 */
export function restoredSentence(item: TrashItem, files: number, copyRemoved: boolean): string {
  const said =
    `Gripterm: "${labelOf(item)}" is back in the store — ${countFiles(files)} out of ` +
    `trash/${item.batch} into ${item.to}.`;
  return copyRemoved
    ? said
    : `${said} Its copy is still in the trash, which the retention will take away; see the log.`;
}

/**
 * What putting this one back would do, in the words of its own form.
 *
 * The presence file gets the longest sentence and needs it: it is the one row
 * here that is not a terminal at all, and a person who puts one back should know
 * that it says a window is there.
 */
function detailFor(item: TrashItem): string {
  const count = countFiles(item.files.length);
  if (item.form === 'owner-file') {
    return (
      `${count} back into owners/. This is not a terminal: it is another window's presence ` +
      'file, and putting it back makes that window look like one that was there.'
    );
  }
  if (item.form === 'record-only') {
    return (
      `${count} back into terminals/${item.name}/, which is still in the store — its journal ` +
      'and its settings never left.'
    );
  }
  return `${count} back into terminals/${item.name}/, which is not in the store now.`;
}

function countFiles(files: number): string {
  return files === 1 ? '1 file' : `${String(files)} files`;
}
