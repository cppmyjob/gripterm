import { refusalAnywhere } from './restore-planner';
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
