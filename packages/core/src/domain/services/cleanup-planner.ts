import { refusalAnywhere } from './restore-planner';
import type { OwnerLiveness } from '../ports/owner-presence';
import type { RestoreInputs } from './restore-planner';
import type { TerminalEntry } from '../entities/terminal-entry';

/**
 * Why a record may be taken out of the store.
 *
 * Three, and every one of them is a permanent state of the world rather than a
 * judgement about what looks useful. Anything that might change tomorrow -- a
 * window that is asleep, a project nobody has open right now, a CLI that could
 * not be asked -- is not on this list, and the absence is the design.
 *
 * (It said "two" until 2026-08-27, and had said so since the third was added.)
 */
export type CleanupReason =
  /** A person closed its terminal THROUGH OUR LIST, and its window is gone. */
  | 'closed'
  /**
   * Its terminal went away in the editor and its window is gone.
   *
   * A separate reason from `closed` because the editor says one word for two
   * acts -- see `ClosedBy` -- and this is the one where nobody established what
   * the person meant -- until they are asked, which is what
   * `closedInTheEditorOffer` is for.
   */
  | 'closed-in-the-editor'
  /** Nothing was ever said in its conversation, and its window is gone. */
  | 'never-spoken';

export interface CleanupItem {
  readonly entry: TerminalEntry;
  readonly reason: CleanupReason;
}

export interface CleanupPlan {
  /** In the order the records arrived, so that two runs agree. */
  readonly sweep: readonly CleanupItem[];
  /** How many records were looked at and left where they are. */
  readonly kept: number;
}

const CLEANUP_WORDS: Readonly<Record<CleanupReason, string>> = {
  'closed': 'its terminal was closed and the window that owned it is gone',
  'closed-in-the-editor':
    'its terminal went away in the editor and the window that owned it is gone -- which may have been one cross on one tab, or a command that closed everything at once',
  'never-spoken':
    'nothing was ever said in its conversation, and the window that opened it is gone -- a window that opens its project again would start it in a NEW conversation',
};

/** The sentence a person reads before confirming, per record. */
export function explainCleanup(reason: CleanupReason): string {
  return CLEANUP_WORDS[reason];
}

/** What one run of `forgetClosedTerminals` did, as the person needs to hear it. */
export interface ForgottenBatch {
  readonly moved: number;
  readonly failed: number;
  /** The batch it all went into, `trash/<stamp>/`, without the `trash/`. */
  readonly batch: string;
}

/**
 * One sentence about the records that were forgotten without anybody being
 * asked, or `null` when there is nothing to say (Ш15).
 *
 * **The gap this closes.** Four ways lead into `trash/`, and three of them speak:
 * `Delete Record` names the batch and the way back, `Clean Up Storage` names the
 * batch, the way back and the retention, and the presence sweep carries off a
 * file about a window rather than anything a person wrote. `forgetClosedTerminals`
 * is the fourth, it is the ONLY one that takes a record with nobody asked, and
 * until this it left two lines in a log -- so from the chair it read as rows
 * quietly disappearing, which is the same complaint the restore refusals drew on
 * 2026-08-21.
 *
 * **Why the sentence carries the way back rather than only the count.** A person
 * told that something was taken and not told how to undo it has been handed the
 * worse half of the news; and until Ш15 there was no way back to name that did
 * not begin "open a file manager".
 *
 * Here rather than in the command, for the reason `restoreNotice` is: what is
 * said, and when nothing is said at all, is a decision -- and a decision belongs
 * where it can be read without a running editor.
 */
export function forgottenNotice(batch: ForgottenBatch): string | null {
  if (batch.moved === 0) {
    return batch.failed === 0
      ? null
      : `Gripterm could not move ${records(batch.failed)} of ${terminals(batch.failed)} you had closed out of the store, see the Gripterm log.`;
  }
  const they = batch.moved === 1 ? 'it' : 'them';
  const said =
    `Gripterm forgot ${records(batch.moved)} of ${terminals(batch.moved)} you had closed, and moved ` +
    `${they} to trash/${batch.batch} in your Gripterm storage folder — ` +
    `"Gripterm: Restore from Trash" brings ${they} back.`;
  return batch.failed === 0
    ? said
    : `${said} ${records(batch.failed)} could not be moved, see the Gripterm log.`;
}

/** `1 record` or `4 records`, so that the sentence above reads as English. */
function records(items: number): string {
  return items === 1 ? '1 record' : `${items} records`;
}

/** The other half of the same agreement, one word further along the sentence. */
function terminals(items: number): string {
  return items === 1 ? 'a terminal' : 'terminals';
}

/**
 * What may be taken out of the store, and how much was left alone.
 *
 * Pure, and it takes the same world the restore predicate takes -- deliberately
 * the SAME VALUE, gathered once by the caller. The two functions are two
 * readings of one moment, and the invariant between them is that no record is
 * in both answers: a record one window is about to start is a record no window
 * may move the files of.
 *
 * THE COST IS ONE-SIDED, the other way round from the restore predicate but for
 * the same reason. Leaving rubbish costs disk and a row that only ever refuses;
 * taking a record that was still wanted costs a person their task, their notes
 * and their tags. So every rule below is written to leave things alone, and
 * every uncertainty -- a window that has merely stopped answering, a CLI that
 * could not be asked, a transcript index that failed -- keeps a record where it
 * is.
 *
 * THE ORDER OF THE RULES IS THE DESIGN.
 *
 *   1. The owner first, and nothing else matters until it answers `dead`. A
 *      window that is there is the single writer of its own records (§4.8):
 *      sweeping one from under it is a file moved away from a process that will
 *      write it again, and `unknown` is a window that is there and silent, not
 *      one that is gone.
 *   2. Then the refusal EVERY window would give (`refusalAnywhere`), never the
 *      one this window gives. "Not this project" and "that window is asleep"
 *      are facts about the asker.
 *   3. Then the two reasons that are settled. `closed` is a person's own act,
 *      and no listing of running conversations can make it untrue -- which is
 *      why a store may be cleaned on a machine with no `claude` on it at all.
 *      `no-transcript` is measured (2026-08-10): `claude --resume` on a
 *      conversation nothing was ever said in exits 1, so that conversation is
 *      not coming back whatever anybody does.
 *
 *      **What it no longer means, since the owner's decision of 2026-08-21:**
 *      that the RECORD is beyond saving. A window that opens its project brings
 *      it back with a new conversation in it (`RestoreStep.intent`), name, task
 *      and notes included. So this stays a reason a PERSON may sweep -- they
 *      asked, they are reading the list, and they may not want that record
 *      starting again -- and it stays out of `UNASKED` below, where it always
 *      was. The sentence they read says which of the two it is.
 */
export function planCleanup(inputs: RestoreInputs): CleanupPlan {
  const sweep: CleanupItem[] = [];
  let kept = 0;

  for (const entry of inputs.entries) {
    const reason = reasonFor(entry, inputs);
    if (reason === null) {
      kept += 1;
      continue;
    }
    sweep.push({ entry, reason });
  }
  return { sweep, kept };
}

/**
 * Which reasons a window may act on WITHOUT asking anybody.
 *
 * A total record, so a third reason cannot be added without somebody deciding
 * this about it -- and the default it would otherwise fall into is the one that
 * moves a person's files while they are not looking.
 *
 * The boundary is the argument and not the count. `closed` is something the
 * person did to that terminal, with their own hand, on purpose: they have
 * already said it -- either through our own list, or by answering the offer a
 * close in the editor now raises (`closedInTheEditorOffer`). `never-spoken` is
 * the opposite kind of record -- a terminal they may have named, written a task
 * on, meant to come back to, and never got to say anything in -- and a build
 * that swept those on its own would be deleting an intention rather than
 * honouring one. Since 2026-08-21 it is more than an intention: such a record is
 * one a window will BRING BACK, so sweeping it unasked would take away a
 * terminal the person was about to get.
 */
const UNASKED: Readonly<Record<CleanupReason, boolean>> = {
  'closed': true,
  /*
   * The third reason, and the decision this record exists to force.
   *
   * Measured 2026-08-24: one `workbench.action.closeAllEditors` -- a keystroke
   * the editor documents as tidying tabs -- stamps every conversation in the
   * window "do not bring this back", and until this line existed the next
   * activation moved every one of them into the trash without asking. What a
   * person got for pressing it was the loss of everything the product is for.
   *
   * They still do not come back by themselves: that is `closedAt`, and it is
   * what the owner asked for about the cross on a tab. What they no longer do
   * is leave the store while nobody is looking. A person who meant it sweeps
   * them from the cleanup command, reading the sentence above.
   *
   * **RE-EXAMINED 2026-08-27 AND KEPT, which is worth more than never having
   * asked.** The owner reported that day that a record they had closed with the
   * cross came back into the list after a restart, and asked for it to be gone.
   * Flipping this line would have delivered that -- and would have handed
   * `closeAllEditors` the whole store again, because the separating signal is
   * not there: `exitStatus.reason` is `User` for both (A29), and
   * `window.tabGroups.onDidChangeTabs` fires ONCE PER TAB for the bulk gesture,
   * five milliseconds apart, which is the shape of a person closing two tabs by
   * hand (measured 2026-08-27). The owner chose the other road on the same day:
   * the build ASKS after the fact rather than guessing, and an answer of "for
   * good" writes `person`, which is `closed` above. So this line stays `false`
   * and the record's fate is settled by somebody who knows it.
   */
  'closed-in-the-editor': false,
  'never-spoken': false,
};

/**
 * What activation may take out of the store on its own (M2.20).
 *
 * The owner's rule, in their words: a terminal closed on purpose is one we
 * should forget. Until this existed, closing a terminal left a row that
 * outlived its window and could not be acted on from any other -- the record
 * belongs to a window that is gone, so no menu offers anything on it -- and the
 * only way out was the manual cleanup, which a person has to know about.
 *
 * **A SUBSET OF `planCleanup`, and never a second predicate.** Every guard that
 * one has is a guard this one has: a window that is merely silent keeps its
 * records, a project this window does not have open is not this window's
 * business, a record any window could still resume stays where it is. What is
 * filtered afterwards is only WHICH settled reason may be acted on unasked.
 * Written the other way round -- a rule of its own that checked `closedAt` --
 * it would drift from the one the confirmation dialog reads, and the drift
 * would be somebody's notes moved out from under a window that wanted them.
 *
 * **It is still reversible, which is what makes doing it unasked legitimate**
 * (§I.3): the caller moves each record whole into `trash/<stamp>/`, keeping its
 * name, its history and its journal, and the trash is kept for the journal's
 * retention. Undoing is moving a folder back.
 *
 * `kept` counts everything left behind, including the records this plan
 * deliberately did not touch. A count that only knew about the ones no cleanup
 * wants would tell a person the store is tidier than it is.
 */
export function planUnaskedCleanup(inputs: RestoreInputs): CleanupPlan {
  const plan = planCleanup(inputs);
  const sweep = plan.sweep.filter((item) => UNASKED[item.reason]);
  return { sweep, kept: plan.kept + plan.sweep.length - sweep.length };
}

/**
 * How ONE record, with a person's menu open on it, may be thrown away.
 *
 * A different question from the plans above and deliberately not built out of
 * them: those decide what a WINDOW may sweep on its own, over the whole base,
 * and this decides what a PERSON may do to the row in front of them. The rules
 * that keep a window from touching a record it cannot judge -- the folder, the
 * transcript, what the CLI is running -- are all about resuming, and none of
 * them is a reason to make somebody live with a row for ever.
 */
export type RecordDisposal =
  /**
   * This window holds it: the lifecycle service discards it, and refuses while a
   * process of ours is still behind it -- knowledge only that object has.
   */
  | { readonly kind: 'ours' }
  /**
   * Somebody else's, and nobody is answering for it. Its directory is moved into
   * the trash whole, journal included, because this window may not write that
   * record (§4.8) and moving a directory is not writing one.
   *
   * The liveness travels along because it is the difference the DIALOG has to
   * say out loud: a window that is gone is ordinary, and a window that has
   * merely stopped answering may be asleep and come back.
   */
  | { readonly kind: 'abandoned', readonly liveness: Exclude<OwnerLiveness, 'live'> }
  /** Somebody else's, and that window is running. Not this window's to touch. */
  | { readonly kind: 'owned-elsewhere' };

/**
 * Whose record this is to throw away (M2.22).
 *
 * The one rule, in one place, and it is short on purpose: ownership decides who
 * acts, and liveness decides whether "somebody else's" still means anybody. It
 * lives in the domain because `packages/extension` is outside the coverage
 * thresholds (§3.5) -- a decision taken there is a decision nothing checks --
 * and because the row menu and the picker must not be able to answer it
 * differently.
 *
 * Neither of the two answers that DO something is unconditional: `ours` still
 * meets the lifecycle service's refusal while a terminal is running, and
 * `abandoned` still meets a modal that names the window it belonged to. What
 * this function forbids is the fourth answer that used to exist by accident --
 * silence.
 */
export function disposalOf(ours: boolean, liveness: OwnerLiveness): RecordDisposal {
  if (ours) {
    return { kind: 'ours' };
  }
  return liveness === 'live' ? { kind: 'owned-elsewhere' } : { kind: 'abandoned', liveness };
}

function reasonFor(entry: TerminalEntry, inputs: RestoreInputs): CleanupReason | null {
  if ((inputs.ownerLiveness.get(entry.owner.ownerId.value) ?? 'unknown') !== 'dead') {
    return null;
  }

  const refusal = refusalAnywhere(entry, inputs);
  if (refusal === 'closed') {
    /*
     * `null` falls to the cautious side, and that is the whole of the rule for
     * records written before this build: nothing on disk says which hand closed
     * them, so nothing here claims to know. The cost is named rather than
     * hidden -- such a record stays a row until a person sweeps it from the
     * cleanup command -- and it is the cost that can be undone.
     */
    return entry.closedBy === 'person' ? 'closed' : 'closed-in-the-editor';
  }
  // Every other refusal is a state of the world that may move: a conversation
  // the CLI is running stops, a listing that failed succeeds next time. Only
  // these two are settled, so only these two are swept.
  return refusal === 'no-transcript' ? 'never-spoken' : null;
}
