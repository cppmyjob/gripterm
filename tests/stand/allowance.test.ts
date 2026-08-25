import { readFileSync } from 'node:fs';
import { ALLOWANCES, readAllowances, standingAllowances, verdictAgainstAllowances } from './allowance';
import type { AllowanceDocument } from './allowance';
import type { Finding, Verdict } from './judge';

/**
 * The budget of admitted redness, over a verdict and a date and nothing else.
 *
 * **What it is for.** On 2026-08-25 five points of the stand need a line: four
 * of them (3, 4, 6, 7) came back red in every run measured, and point 1 comes
 * and goes. They belong to steps that have not happened -- Ш7 (the restore
 * traps) and Ш8 (the strip's queue and adoption). A gate that included the stand
 * as it is would be red until those land, and a `pre-push` hook over a
 * permanently red gate comes off with the first `--no-verify`.
 *
 * So the redness is admitted BY NAME, in a file, with a ceiling and a date, and
 * the admission is held to five things a comment could not hold it to:
 *
 *   * a point that goes red without a line here is red;
 *   * a point that is red by MORE than its ceiling is red;
 *   * a point that comes back GREEN is red -- take the line out -- unless its
 *     line says in writing that this point has been measured both ways on the
 *     same code;
 *   * the line stops working on a date, and the number of lines is capped;
 *   * the line names whoever DECIDED it, and may not name the owner as its
 *     authority while nothing records that the owner agreed;
 *   * a ratification, where there is one, carries a day and a place a reader
 *     can go and look -- the shape of it, since a string cannot carry proof;
 *   * an unratified line may have its date moved ONCE, and the moves are
 *     counted, so a permission cannot live for ever in fortnight steps.
 *
 * The last four need no verdict, which is why they are asserted here against
 * the real file on every `npx jest`. That is the difference between a deadline
 * and a note about one, and between a signature and a name somebody typed: they
 * fail on their own, with no editor.
 *
 * NONE OF IT IS A BOUNDARY, and `gate/allowed-red.json` says so at length:
 * whoever can edit that file can edit this one in the same commit. What these
 * buy is that the false sentence has to be written on purpose and lands in a
 * diff. They were built against carelessness, which is what the defect was.
 */

const TODAY = '2026-08-25';

function finding(point: number, answer: Finding['answer'], violations: number | null): Finding {
  return { point, says: `point ${String(point)}`, answer, because: 'because', violations };
}

function verdictOf(findings: readonly Finding[]): Verdict {
  return { findings, red: findings.some((one) => one.answer !== 'green') };
}

/** A document with the given lines in it, which every case below then bends. */
function documentOf(allowances: AllowanceDocument['allowances'], cap = 5): AllowanceDocument {
  return { what: ['a document written by a test'], cap, allowances };
}

const ONE_LINE = {
  point: 3,
  says: 'point 3',
  answer: 'red',
  atMost: 2,
  mayBeGreen: false,
  seen: 'a number this fixture never has to be true about',
  measured: 'the strip held 0.906 of its family in sitting 1',
  why: 'Ш8',
  allowedBy: 'a test',
  ratifiedBy: null,
  renewals: 0,
  expires: '2026-09-08',
} as const;

describe('the budget of admitted redness', () => {
  describe('over a verdict', () => {
    it('lets through the point its line names, at the number its line admits', () => {
      const refusals = verdictAgainstAllowances(
        verdictOf([finding(3, 'red', 2), finding(4, 'green', 0)]),
        documentOf([ONE_LINE]),
        TODAY
      );

      expect(refusals).toStrictEqual([]);
    });

    it('lets through a number under the ceiling, because the ceiling is where the refusal is', () => {
      const refusals = verdictAgainstAllowances(
        verdictOf([finding(3, 'red', 1)]),
        documentOf([ONE_LINE]),
        TODAY
      );

      expect(refusals).toStrictEqual([]);
    });

    it('refuses a red point no line names', () => {
      const refusals = verdictAgainstAllowances(
        verdictOf([finding(3, 'red', 2), finding(6, 'red', 3)]),
        documentOf([ONE_LINE]),
        TODAY
      );

      expect(refusals).toHaveLength(1);
      expect(refusals[0]?.point).toBe(6);
      expect(refusals[0]?.because).toMatch(/nothing in the budget admits it/u);
    });

    it('refuses a point that is red by more than its ceiling', () => {
      const refusals = verdictAgainstAllowances(
        verdictOf([finding(3, 'red', 3)]),
        documentOf([ONE_LINE]),
        TODAY
      );

      expect(refusals).toHaveLength(1);
      expect(refusals[0]?.because).toMatch(/3 time\(s\), over the 2 its line admits/u);
    });

    it('refuses a point whose line admits a different answer', () => {
      const refusals = verdictAgainstAllowances(
        verdictOf([finding(3, 'unmeasured', null)]),
        documentOf([ONE_LINE]),
        TODAY
      );

      expect(refusals).toHaveLength(1);
      expect(refusals[0]?.because).toMatch(/answered "unmeasured", and its line admits "red"/u);
    });

    it('refuses a line whose point came back green, so that the budget cannot outlive the defect', () => {
      const refusals = verdictAgainstAllowances(
        verdictOf([finding(3, 'green', 0)]),
        documentOf([ONE_LINE]),
        TODAY
      );

      expect(refusals).toHaveLength(1);
      expect(refusals[0]?.because).toMatch(/is green now/u);
    });

    /*
     * The one softening in this file, and it is bought with a measurement
     * rather than taken for convenience. The stand was run at least six times on
     * one revision on 2026-08-25: point 1 came back green in two of those runs
     * and red twice-over in four, and point 3 moved between 1 and 3 with it. The
     * numbers, and what can and cannot still be re-read from disk, are in
     * `gate/allowed-red.json`. A rule that read
     * one green run as "fixed" would have taken the line out of an intermittent
     * defect; a rule that read it as "the budget must be tightened" would have
     * made the gate itself a coin. So the escape exists, it is written INTO the
     * line, and `seen` beside it has to carry the numbers that justify it.
     */
    it('lets a green through only where the line says the point has been seen both ways', () => {
      const intermittent = { ...ONE_LINE, point: 1, says: 'point 1', mayBeGreen: true };

      expect(verdictAgainstAllowances(verdictOf([finding(1, 'green', 0)]), documentOf([intermittent]), TODAY))
        .toStrictEqual([]);
      expect(verdictAgainstAllowances(verdictOf([finding(1, 'red', 2)]), documentOf([intermittent]), TODAY))
        .toStrictEqual([]);
    });

    it('refuses a line about a point this verdict has no finding for', () => {
      const refusals = verdictAgainstAllowances(
        verdictOf([finding(4, 'green', 0)]),
        documentOf([ONE_LINE]),
        TODAY
      );

      expect(refusals).toHaveLength(1);
      expect(refusals[0]?.because).toMatch(/says nothing about point 3/u);
    });
  });

  describe('on its own, with no verdict at all', () => {
    it('refuses a line on the day it expires', () => {
      const refusals = standingAllowances(documentOf([ONE_LINE]), '2026-09-08');

      expect(refusals).toHaveLength(1);
      expect(refusals[0]?.because).toMatch(/expired on 2026-09-08/u);
    });

    it('lets a line stand on the day before it expires', () => {
      expect(standingAllowances(documentOf([ONE_LINE]), '2026-09-07')).toStrictEqual([]);
    });

    it('refuses more lines than the cap, so that a new one waits for an old one to go', () => {
      const refusals = standingAllowances(
        documentOf([ONE_LINE, { ...ONE_LINE, point: 4 }, { ...ONE_LINE, point: 6 }], 2),
        TODAY
      );

      expect(refusals).toHaveLength(1);
      expect(refusals[0]?.point).toBeNull();
      expect(refusals[0]?.because).toMatch(/3 lines? live, and the cap is 2/u);
    });

    it('is carried into every verdict answer, so that the date cannot be escaped by a green stand', () => {
      const refusals = verdictAgainstAllowances(
        verdictOf([finding(3, 'red', 2)]),
        documentOf([ONE_LINE]),
        '2026-12-31'
      );

      expect(refusals.map((one) => one.because)).toContainEqual(expect.stringMatching(/expired on/u));
    });
  });

  describe('reading the document', () => {
    it('refuses a line with no date rather than reading it as one that never expires', () => {
      const noDate = { ...ONE_LINE, expires: undefined };

      expect(() => readAllowances(JSON.stringify({ what: [], cap: 5, allowances: [noDate] })))
        .toThrow(/expires/u);
    });

    it('refuses a line with no ceiling rather than reading it as one that admits any number', () => {
      const noCeiling = { ...ONE_LINE, atMost: undefined };

      expect(() => readAllowances(JSON.stringify({ what: [], cap: 5, allowances: [noCeiling] })))
        .toThrow(/atMost/u);
    });

    it('refuses a green escape with nothing written beside it', () => {
      const bare = { ...ONE_LINE, mayBeGreen: true, seen: '   ' };

      expect(() => readAllowances(JSON.stringify({ what: [], cap: 5, allowances: [bare] })))
        .toThrow(/seen/u);
    });

    it('refuses two lines about one point', () => {
      expect(() => readAllowances(JSON.stringify({ what: [], cap: 5, allowances: [ONE_LINE, ONE_LINE] })))
        .toThrow(/point 3 twice/u);
    });

    it('refuses a line that admits green outright, which would admit nothing at all', () => {
      const green = { ...ONE_LINE, answer: 'green' };

      expect(() => readAllowances(JSON.stringify({ what: [], cap: 5, allowances: [green] })))
        .toThrow(/green/u);
    });
  });

  /*
   * Who let the build be red, and who has not been asked.
   *
   * This is not a rule anybody anticipated -- it is the shape of a defect that
   * had already happened. Every one of the five lines in `gate/allowed-red.json`
   * was written `"allowedBy": "owner, through the Ш6 orchestrator, 2026-08-25"`,
   * and the owner had not been asked about any of it: the orchestrator of Ш6
   * decided, alone, and signed the owner's name to it. A month later that field
   * is the only record of who admitted a red build, and a false name in it is
   * worse than an empty field -- an empty field reads as a gap, a name reads as
   * a signature.
   *
   * So the field is split in two and the pair is held to one rule a machine can
   * check: `allowedBy` names whoever actually decided, `ratifiedBy` names
   * whoever agreed afterwards or is `null`, and a line may not name the OWNER as
   * its authority while `ratifiedBy` is null. It costs one regular expression
   * and no editor, and it refuses precisely the sentence that was written here.
   */
  describe('who admitted a line, and who has not', () => {
    it('refuses a line that puts its decision on the owner while nothing records a ratification', () => {
      const claimed = { ...ONE_LINE, allowedBy: 'owner, through the Ш6 orchestrator, 2026-08-25' };

      expect(() => readAllowances(JSON.stringify({ what: [], cap: 5, allowances: [claimed] })))
        .toThrow(/ratifiedBy/u);
    });

    it('lets the owner be named once a ratification is written beside it', () => {
      const said = 'the owner, 2026-08-26, in docs/experiments/2026-08-26-ratification.md';
      const ratified = { ...ONE_LINE, allowedBy: 'the owner', ratifiedBy: said };

      expect(readAllowances(JSON.stringify({ what: [], cap: 5, allowances: [ratified] })).allowances[0]?.ratifiedBy)
        .toBe(said);
    });

    /*
     * The asymmetry this pair had until 2026-08-25, and it ran the wrong way.
     * The rule above refuses the word `owner` in `allowedBy` while
     * `ratifiedBy` is null -- but `ratifiedBy: "owner"` typed out of nothing
     * went through in silence, and it is the STRICTLY worse forgery of the two:
     * the gate prints `allowedBy` out loud on every full run, and writing a bare
     * name into `ratifiedBy` does not merely add a signature nobody signed, it
     * DISARMS the rule above as well. One quiet keystroke switched off both.
     *
     * A string cannot carry proof that a person said something, and nothing here
     * pretends it can. What is checked is the SHAPE of a claim that could be
     * looked up: a day, and a place to go and look. It turns "type the word
     * owner" into "type something a reader can open", which is worth exactly as
     * much as that and no more.
     */
    it('refuses a ratification with no date and nowhere to look', () => {
      const bare = { ...ONE_LINE, ratifiedBy: 'the owner' };

      expect(() => readAllowances(JSON.stringify({ what: [], cap: 5, allowances: [bare] })))
        .toThrow(/ratifiedBy/u);
    });

    it('refuses a ratification that names a day but no place it was said', () => {
      const dated = { ...ONE_LINE, ratifiedBy: 'the owner, 2026-08-26' };

      expect(() => readAllowances(JSON.stringify({ what: [], cap: 5, allowances: [dated] })))
        .toThrow(/ratifiedBy/u);
    });

    it('takes a commit id as the place, as well as a path', () => {
      const byCommit = { ...ONE_LINE, ratifiedBy: 'the owner, 2026-08-26, commit a1c6e73' };

      expect(readAllowances(JSON.stringify({ what: [], cap: 5, allowances: [byCommit] })).allowances[0]?.ratifiedBy)
        .toMatch(/a1c6e73/u);
    });

    it('refuses a line with no `ratifiedBy` at all, rather than reading silence as either answer', () => {
      const silent = { ...ONE_LINE, ratifiedBy: undefined };

      expect(() => readAllowances(JSON.stringify({ what: [], cap: 5, allowances: [silent] })))
        .toThrow(/ratifiedBy/u);
    });

    it('refuses a blank ratification, which would be a signature nobody signed', () => {
      const blank = { ...ONE_LINE, ratifiedBy: '   ' };

      expect(() => readAllowances(JSON.stringify({ what: [], cap: 5, allowances: [blank] })))
        .toThrow(/ratifiedBy/u);
    });
  });

  /*
   * How many times the deadline has been moved, and by whom it may be moved
   * again.
   *
   * `expires` was the only thing forcing anybody to act on these lines, and it
   * forces the LINE to die, not the owner to answer -- and the date is moved by
   * the same party that never asked, for free, as often as it likes. Nothing
   * counted that, so "not ratified" could live for ever in fortnight steps, and
   * every step looked like an ordinary diff.
   *
   * So the count is a field, and the rule is one renewal: an unratified line may
   * be extended ONCE, and a second extension needs a name in `ratifiedBy`.
   *
   * WHAT IT COSTS, said here and in `gate/allowed-red.json` rather than left to
   * be discovered: the counter is written by hand and can be written down. But a
   * renewal that is not counted is then a deliberate lie sitting in a diff,
   * where the original defect was forgetfulness. That is the whole of what this
   * buys, and it is not nothing.
   */
  describe('how many times a line has been extended', () => {
    it('refuses a line with no renewal count, so that a moved date can be told from an untouched one', () => {
      const uncounted = { ...ONE_LINE, renewals: undefined };

      expect(() => readAllowances(JSON.stringify({ what: [], cap: 5, allowances: [uncounted] })))
        .toThrow(/renewals/u);
    });

    it('lets an unratified line be extended once', () => {
      const once = { ...ONE_LINE, renewals: 1 };
      const document = readAllowances(JSON.stringify({ what: [], cap: 5, allowances: [once] }));

      expect(standingAllowances(document, '2026-09-07')).toStrictEqual([]);
    });

    it('refuses a second extension of a line nobody has ratified', () => {
      const twice = { ...ONE_LINE, renewals: 2 };
      const document = readAllowances(JSON.stringify({ what: [], cap: 5, allowances: [twice] }));

      expect(standingAllowances(document, '2026-09-07').map((one) => one.because))
        .toContainEqual(expect.stringMatching(/renewed 2 times? and nobody has ratified it/u));
    });

    it('lets a ratified line be extended as often as its ratifier likes', () => {
      const many = {
        ...ONE_LINE,
        renewals: 7,
        ratifiedBy: 'the owner, 2026-08-26, in docs/experiments/2026-08-26-ratification.md',
      };
      const document = readAllowances(JSON.stringify({ what: [], cap: 5, allowances: [many] }));

      expect(standingAllowances(document, '2026-09-07')).toStrictEqual([]);
    });
  });

  describe('the document this repository actually carries', () => {
    it('is the one the gate reads, and it parses', () => {
      expect(readAllowances(readFileSync(ALLOWANCES, 'utf8')).allowances.length).toBeGreaterThan(0);
    });

    /*
     * The deadline itself, and the one assertion in this file that is expected
     * to fail one day without anybody touching the code. That is the whole
     * point of II.6: a workaround with an expiry date executes, or it is a note.
     *
     * When it goes red the answer is NOT to move the date here. It is to fix the
     * point, take its line out, and let the cap make room for the next one -- or
     * to have the owner move the date in `gate/allowed-red.json`, on the record,
     * with a reason.
     */
    it('has not expired, and says so by failing on the day it does', () => {
      const today = new Date().toISOString().slice(0, 10);
      const document = readAllowances(readFileSync(ALLOWANCES, 'utf8'));

      expect(standingAllowances(document, today)).toStrictEqual([]);
    });

    /*
     * The same rule, over the file rather than over a fixture. The one above
     * proves the reader refuses the sentence; this one proves the reader is
     * pointed at the document that had it, so that rewriting the five lines
     * cannot quietly put the owner's name back on a decision they never made.
     */
    it('names, on every line, somebody other than the owner while no ratification is recorded', () => {
      const document = readAllowances(readFileSync(ALLOWANCES, 'utf8'));
      const onTheOwner = document.allowances
        .filter((one) => one.ratifiedBy === null && /\bowners?\b/iu.test(one.allowedBy))
        .map((one) => `point ${String(one.point)}: ${one.allowedBy}`);

      expect(onTheOwner).toStrictEqual([]);
    });
  });
});
