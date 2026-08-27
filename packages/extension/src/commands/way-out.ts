import type { RestoreRefusal } from '@gripterm/core';

/**
 * The refusals that will still be refusals tomorrow, told apart from the ones
 * that are about this moment (M2.22).
 *
 * A person who pressed "take over" and was told why, with nothing they could do
 * about it, has been given a fact and no move. Two records naming one
 * conversation is such a case and it does not mend itself: neither record can be
 * resumed while the other stands, and which of them is real is a judgement about
 * whose notes matter -- so the sentence names the one thing left to do with it.
 * The other refusals are deliberately silent here: a window that is asleep, a
 * conversation the CLI is running, a listing that failed are all states that
 * change, and telling somebody to throw the record away would be advice to lose
 * their notes over a bad minute.
 *
 * **`no-transcript` used to be named here too, and it was the case this function
 * was written for** -- the row a `Start Over` leaves behind, which the owner
 * could not get rid of. It was removed on 2026-08-27, and not because the case
 * stopped mattering: the owner answered it a better way on 2026-08-21, so a
 * record nothing was said in comes back with a NEW conversation instead of being
 * refused. `planRestore` has not produced that refusal since, and it is the only
 * thing the adopt command reads one out of, so the branch could not fire. The
 * measurement is `restore-planner.test.ts`, "never hands `no-transcript` to a
 * caller"; the value itself is alive elsewhere and stays in the union.
 *
 * **Its own module, and only so that it can be asked.** It sat inside
 * `adopt-terminal.ts`, which imports `vscode`, so no unit run could reach it and
 * the sentence a refused adoption ends with had never been checked by anything.
 * `tests/extension/way-out.test.ts` is what asks it now, over every member of
 * the union, which is how the branch above was shown to be answerable at all.
 */
export function wayOut(reason: RestoreRefusal): string {
  return reason === 'duplicate-session' ? ' You can delete its record from the row\'s menu.' : '';
}
