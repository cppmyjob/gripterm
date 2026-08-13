import { refusalAnywhere } from './restore-planner';
import type { OwnerLiveness } from '../ports/owner-presence';
import type { RestoreInputs } from './restore-planner';
import type { TerminalEntry } from '../entities/terminal-entry';

/**
 * Why a record may be taken out of the store.
 *
 * Two, and both are permanent states of the world rather than judgements about
 * what looks useful. Anything that might change tomorrow -- a window that is
 * asleep, a project nobody has open right now, a CLI that could not be asked --
 * is not on this list, and the absence is the design.
 */
export type CleanupReason =
  /** A person closed its terminal, and its window is gone. */
  | 'closed'
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
  'never-spoken':
    'nothing was ever said in its conversation, so no window can resume it, and the one that opened it is gone',
};

/** The sentence a person reads before confirming, per record. */
export function explainCleanup(reason: CleanupReason): string {
  return CLEANUP_WORDS[reason];
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
 *   3. Then the two reasons that are permanent. `closed` is a person's own act,
 *      and no listing of running conversations can make it untrue -- which is
 *      why a store may be cleaned on a machine with no `claude` on it at all.
 *      `no-transcript` is measured (2026-08-10): `claude --resume` on a
 *      conversation nothing was ever said in exits 1, so no window can bring it
 *      back, no demand lifts that refusal (M2.14), and starting it over belongs
 *      to the window that owns it -- which is the one that is gone.
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
 * already said it. `never-spoken` is the opposite kind of record -- a terminal
 * they may have named, written a task on, meant to come back to, and never got
 * to say anything in -- and a build that swept those on its own would be
 * deleting an intention rather than honouring one.
 */
const UNASKED: Readonly<Record<CleanupReason, boolean>> = {
  'closed': true,
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
    return 'closed';
  }
  // Every other refusal is a state of the world that may move: a conversation
  // the CLI is running stops, a listing that failed succeeds next time. Only
  // these two are settled, so only these two are swept.
  return refusal === 'no-transcript' ? 'never-spoken' : null;
}
