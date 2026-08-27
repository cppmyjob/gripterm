import { wayOut } from '../../packages/extension/src/commands/way-out';
import type { RestoreRefusal } from '../../packages/core/src/index';

/**
 * The sentence a refused adoption ends with, pinned before it is changed.
 *
 * **Why this file exists at all.** `wayOut` lived inside `adopt-terminal.ts`,
 * which imports `vscode`, so nothing outside a running Extension Host could ask
 * it anything -- and the change this pins is a DELETION. III.7 is explicit
 * about that order: a branch whose reason cannot be recovered is fixed by a test
 * first and changed behind it, and a branch nothing can call is a branch nothing
 * can pin. Moved out whole, sentence and reasoning unchanged, so that the
 * deletion below is the only difference this suite ever sees.
 *
 * **The register is total on purpose.** Every member of `RestoreRefusal` is
 * named here, so a refusal added to the union arrives at a compiler error rather
 * than at an untested default -- the same rule `REFUSAL_WORDS` follows in the
 * domain, and for the same reason: this decides whether a person is offered a
 * move or left with a fact.
 */

/** What each refusal is answered with, spelled out rather than derived. */
const ADVICE: Readonly<Record<RestoreRefusal, string>> = {
  'closed': '',
  'owner-live': '',
  'owner-unknown': '',
  'foreign-folder': '',
  'session-running': '',
  'session-unknown': '',
  'session-listed': '',
  'process-listed': '',
  'agents-unavailable': '',
  'transcripts-unavailable': '',
  // **Reachable by nobody, measured 2026-08-27.** `restore-planner.test.ts`
  // holds that `planRestore` cannot produce a skip with this reason -- both
  // pushes are past its `startsFresh` test -- and `planRestore` is the only
  // thing the adopt command reads a refusal out of. The whole reason this
  // function exists was written for THIS case: the row a `Start Over` leaves
  // behind, which the owner could not get rid of. The owner's decision of
  // 2026-08-21 answered it a better way -- such a record comes back with a NEW
  // conversation rather than being refused -- so what is left here is the side
  // case, and this row is now silent like every other unreachable one.
  'no-transcript': '',
  'duplicate-session': ' You can delete its record from the row\'s menu.',
};

const EVERY_REFUSAL = Object.keys(ADVICE) as RestoreRefusal[];

describe('what a refused adoption offers the person who asked for it', () => {
  it.each(EVERY_REFUSAL)('answers %s the same way it always has', (reason) => {
    expect(wayOut(reason)).toBe(ADVICE[reason]);
  });

  it('offers a move to a named few, so silence stays the rule and not the exception', () => {
    // The other half of the register: a change that made every refusal offer the
    // same sentence would pass the rule above one row at a time. The rule the
    // command was written to is that MOST refusals are about this moment and get
    // no advice at all, and that is a fact about the count.
    expect(EVERY_REFUSAL.filter((reason) => wayOut(reason) !== '')).toStrictEqual(['duplicate-session']);
  });
});
