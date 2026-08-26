import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALLOWANCES, cursorAgainstBudget, ratesAgainstBudget, readAllowances, refusalForTheStart, standingAllowances, verdictAgainstAllowances } from './allowance';
import { BUDGET, judge } from './judge';
import { parseRecording } from './recording';
import type { AllowanceDocument, RateMeasured, WorkbenchSaid } from './allowance';
import type { Finding, Verdict } from './judge';

/**
 * The budget of admitted redness, over a verdict and a date and nothing else.
 *
 * **What it is for.** On 2026-08-25 three points of the stand need a line: two
 * of them (6 and 7) came back red in every run measured, and point 1 comes and
 * goes with the window it is handed. 6 and 7 belong to a step that has not
 * happened -- Ш7, the restore traps. Points 3 and 4 had lines of their own
 * until the second half of Ш8 fixed them the same day, and `gate/allowed-red.json`
 * records what went out and why. A gate that included the stand as it is would
 * be red until Ш7 lands, and a `pre-push` hook over a permanently red gate
 * comes off with the first `--no-verify`.
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
function documentOf(
  allowances: AllowanceDocument['allowances'],
  cap = 5,
  rates: AllowanceDocument['rates'] = []
): AllowanceDocument {
  return { what: ['a document written by a test'], cap, allowances, rates };
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

    /*
     * THE RULE THIS FILE EXISTS FOR, HELD OVER A WINDOW THE STAND REALLY MEETS
     * -- and the one assertion here that reads a recording.
     *
     * On 2026-08-25 points 3 and 4 came back green four runs running and their
     * lines were taken out of `gate/allowed-red.json`. On the fifth run they
     * were red again and the budget refused the gate. What separated the fifth
     * run from the four was not the product: it was that Cursor restored an
     * editor of its OWN into the window, a tab labelled `New Agent`, which lives
     * in an editor part the grid does not hold while `tabGroups.all` lists it
     * all the same. `vscode.getEditorLayout` answers for the part that holds the
     * ACTIVE group, so with that tab focused the grid the observer writes down
     * is the agent pane's and not the editor area's -- and every point that
     * indexes the grid by a `ViewColumn` is then reading one container with
     * another's numbers.
     *
     * The four green runs cannot be re-read: `prepare()` deletes
     * `.vscode-test/stand-output/` at the start of every run, so "green with the
     * agent editor in the window" rested on a report, and the budget said so.
     * `agent-editor-2026-08-25.ndjson` is the fifth run's own recording, kept
     * before the next run could delete it, and this test is what it buys: the
     * budget now has to cover a window of that kind or fail here, in a second,
     * with no editor -- instead of four minutes into a gate on somebody's
     * desktop, once a fortnight, when Cursor happens to restore one.
     *
     * It does NOT pin which points were red that day, for the reason
     * `judge.test.ts` gives about the other real recording: that would turn
     * fixing one of them into a failing test. It pins the only thing the budget
     * is for -- that whatever this recording answers, the budget admits it.
     */
    it('admits the run of 2026-08-25 whose window carried Cursor`s own agent editor', () => {
      const recording = parseRecording(
        readFileSync(join(__dirname, 'fixtures', 'agent-editor-2026-08-25.ndjson'), 'utf8')
      );
      const document = readAllowances(readFileSync(ALLOWANCES, 'utf8'));

      expect(verdictAgainstAllowances(judge(recording, BUDGET), document, TODAY)).toStrictEqual([]);
    });
  });
  /*
   * THE OTHER HALF OF THE SAME DOCUMENT, and it is here rather than in a file of
   * its own because it is the same question asked of a different measurer.
   *
   * The stand answers in POINTS -- named things that went wrong -- and a point
   * is admitted with a ceiling because 2026-08-25 measured its answer to be
   * random. The Cursor strip answers in a RATE: how many of N attempts at one
   * editor command missed. Ш9 anticipated exactly this and named the rule for
   * it: "if the miss is really one in ten, a green run is unreachable, and the
   * rule has to be `the miss rate did not grow`". A rate needs the same four
   * things a point's line needs -- a ceiling, a date, a name, and a count of
   * renewals -- and putting it anywhere else would be a second budget with a
   * second expiry regime nobody reads.
   */
  describe('a ceiling on a rate, rather than on a point', () => {
    const CEILING = {
      check: 'cursor-newGroupBelow',
      says: 'a group below is made',
      of: 10,
      atMost: 0,
      seen: 'a number this fixture never has to be true about',
      measured: 'nothing, this is a fixture',
      why: 'a test',
      allowedBy: 'a test',
      ratifiedBy: null,
      renewals: 0,
      expires: '2026-09-08',
    } as const;

    function measured(misses: number, attempts = 10): readonly RateMeasured[] {
      return [{ check: 'cursor-newGroupBelow', attempts, misses }];
    }

    it('lets through a rate at the ceiling its line admits', () => {
      const document = documentOf([], 5, [{ ...CEILING, atMost: 1 }]);

      expect(ratesAgainstBudget(measured(1), document)).toStrictEqual([]);
    });

    it('lets through a rate BELOW its ceiling, because a rate that improved is not a regression', () => {
      const document = documentOf([], 5, [{ ...CEILING, atMost: 1 }]);

      expect(ratesAgainstBudget(measured(0), document)).toStrictEqual([]);
    });

    it('refuses a rate that grew past its ceiling, and says both numbers', () => {
      const document = documentOf([], 5, [CEILING]);

      const refusals = ratesAgainstBudget(measured(2), document);

      expect(refusals).toHaveLength(1);
      expect(refusals[0]?.because).toContain('2');
      expect(refusals[0]?.because).toContain('cursor-newGroupBelow');
    });

    /*
     * A rate is a fraction and this budget stores only its numerator, so the
     * denominator has to be held somewhere: nought misses out of one attempt and
     * nought out of ten are not the same fact, and the first is what a probe that
     * quietly gave up looks like.
     */
    it('refuses a run of fewer attempts than the ceiling was measured over', () => {
      const document = documentOf([], 5, [CEILING]);

      const refusals = ratesAgainstBudget(measured(0, 3), document);

      expect(refusals).toHaveLength(1);
      expect(refusals[0]?.because).toContain('3');
      expect(refusals[0]?.because).toContain('10');
    });

    it('refuses a check nothing in the budget admits', () => {
      const document = documentOf([], 5, []);

      expect(ratesAgainstBudget(measured(0), document)).toHaveLength(1);
    });

    /*
     * The other direction, and it is the one that rots quietly: a ceiling over a
     * check that no longer runs reads as coverage and is none. It is the same
     * rule `verdictAgainstAllowances` holds for a point nothing judged.
     */
    it('refuses a ceiling over a check nothing measured', () => {
      const document = documentOf([], 5, [CEILING]);

      const refusals = ratesAgainstBudget([], document);

      expect(refusals).toHaveLength(1);
      expect(refusals[0]?.because).toContain('cursor-newGroupBelow');
    });

    /*
     * The deadline and the renewal counter reach the rate lines through the same
     * function the points use, so that a Cursor ceiling nobody tightens dies on
     * its date under a bare `npx jest`, with no editor -- and not four minutes
     * into a gate.
     */
    it('expires on its date, like every other line in this document', () => {
      const document = documentOf([], 5, [{ ...CEILING, expires: '2026-08-25' }]);

      expect(standingAllowances(document, TODAY)).toHaveLength(1);
    });

    /*
     * The renewal cap is about a PERMISSION, and a ceiling of nought is not one.
     *
     * `renewals` exists so that a line admitting redness cannot live for ever in
     * fortnight steps taken by the party that never asked. A line whose ceiling
     * admits no misses at all admits nothing: it is an assertion that happens to
     * carry a date, because the fork it was measured on ships every few days and
     * the NUMBER goes stale even while it keeps passing. Making somebody get the
     * owner's signature every eight weeks for a check that is green would teach
     * exactly the habit this file is against -- signing to make a colour go away.
     */
    it('may be extended once unratified, and not twice, while it admits any miss at all', () => {
      const once = documentOf([], 5, [{ ...CEILING, atMost: 1, renewals: 1 }]);
      const twice = documentOf([], 5, [{ ...CEILING, atMost: 1, renewals: 2 }]);

      expect(standingAllowances(once, TODAY)).toStrictEqual([]);
      expect(standingAllowances(twice, TODAY)).toHaveLength(1);
    });

    it('may be re-measured as often as the fork ships, while its ceiling admits nothing', () => {
      const many = documentOf([], 5, [{ ...CEILING, atMost: 0, renewals: 7 }]);

      expect(standingAllowances(many, TODAY)).toStrictEqual([]);
    });

    it('still expires on its date, ceiling of nought or not, because the fork moves under it', () => {
      const stale = documentOf([], 5, [{ ...CEILING, atMost: 0, renewals: 7, expires: '2026-08-25' }]);

      expect(standingAllowances(stale, TODAY)).toHaveLength(1);
    });

    it('may not put its own decision on the owner with no ratification recorded', () => {
      const document = {
        what: [],
        cap: 5,
        allowances: [],
        rates: [{ ...CEILING, allowedBy: 'the owner' }],
      };

      expect(() => readAllowances(JSON.stringify(document))).toThrow(/owner/u);
    });

    it('is in the document this repository actually carries, and it stands today', () => {
      const document = readAllowances(readFileSync(ALLOWANCES, 'utf8'));

      expect(document.rates.map((one) => one.check)).toContain('cursor-newGroupBelow');
      expect(standingAllowances(document, new Date().toISOString().slice(0, 10))).toStrictEqual([]);
    });
  });

  /*
   * The third answer, and it is the reason the second one is worth anything.
   *
   * A rate is a fraction whose denominator is the number of attempts -- and
   * whose SUBJECT is the window they were attempted in. Cursor has two
   * workbenches; measured 2026-08-25 over 33 launches, `newGroupBelow` misses 10
   * of 10 in the glass one and 0 of 10 outside it. Which one the stage gets is
   * decided today by an argument that is there for something else. So a run that
   * does not say which workbench it measured has produced a number with nowhere
   * to be filed, and a budget that compared it anyway would report a defect of
   * the product on the day the window changed.
   *
   * The rule is the one `verdictAgainstAllowances` already holds for a point
   * nothing judged: an unmeasured thing and a failed one are two different
   * facts, and a line about one does not cover the other. It costs a colour --
   * an unmeasured run is red, exactly as a missing `rate.json` is red -- and it
   * buys the reason being true.
   */
  describe('which workbench the rates were measured in', () => {
    const CEILING = {
      check: 'cursor-newGroupBelow',
      says: 'a group below is made',
      of: 10,
      atMost: 0,
      seen: 'a number this fixture never has to be true about',
      measured: 'nothing, this is a fixture',
      why: 'a test',
      allowedBy: 'a test',
      ratifiedBy: null,
      renewals: 0,
      expires: '2026-09-08',
    } as const;

    function measured(misses: number): readonly RateMeasured[] {
      return [{ check: 'cursor-newGroupBelow', attempts: 10, misses }];
    }

    function workbench(is: string): WorkbenchSaid {
      return { is, because: `the window directory is window1_wb0 and 68 log lines say layout glass` };
    }

    it('judges the numbers when the run says it measured the workbench the budget was measured in', () => {
      const document = documentOf([], 5, [CEILING]);

      const judged = cursorAgainstBudget(measured(0), workbench('classic'), document);

      expect(judged.measured).toBe(true);
      expect(judged.refusals).toStrictEqual([]);
    });

    /*
     * The acceptance of Ш19, as a second: today this run answers "7 misses of
     * 10" and a person reads it as the product. The number is not restated at
     * all -- hence the 7, which nothing in the refusal may carry -- because a
     * rate from the other workbench is not a smaller fact about the product, it
     * is a fact about a different window.
     */
    it('refuses the numbers without restating them when the run measured the OTHER workbench', () => {
      const document = documentOf([], 5, [CEILING]);

      const judged = cursorAgainstBudget(measured(7), workbench('glass'), document);

      expect(judged.measured).toBe(false);
      expect(judged.refusals).toHaveLength(1);
      expect(judged.refusals[0]?.because).toContain('glass');
      expect(judged.refusals[0]?.because).not.toContain('7');
    });

    it('refuses when the run could not establish its workbench, and quotes what it read', () => {
      const document = documentOf([], 5, [CEILING]);

      const judged = cursorAgainstBudget(measured(0), workbench('unknown'), document);

      expect(judged.measured).toBe(false);
      expect(judged.refusals[0]?.because).toContain('window1_wb0');
    });

    /*
     * A `rate.json` written by a stage older than this reading. It is not
     * silence and it is not a pass: the file says nothing about the one variable
     * that decides what its numbers are about.
     */
    it('refuses when the run said nothing about a workbench at all', () => {
      const document = documentOf([], 5, [CEILING]);

      const judged = cursorAgainstBudget(measured(0), null, document);

      expect(judged.measured).toBe(false);
      expect(judged.refusals).toHaveLength(1);
    });

    /*
     * Not one refusal on top of the rate's own. When the workbench is wrong the
     * rates are not compared AT ALL -- neither the ceiling that nothing measured
     * nor the check nothing admits -- because every one of those sentences would
     * be about numbers that belong to no window.
     */
    it('does not compare the rates at all, so no refusal of theirs can be printed beside it', () => {
      const document = documentOf([], 5, [{ ...CEILING, check: 'a check nothing measured' }]);

      const judged = cursorAgainstBudget(measured(7), workbench('glass'), document);

      expect(judged.refusals).toHaveLength(1);
      expect(judged.refusals[0]?.because).toContain('glass');
    });
  });
});

/*
 * The budget of the START, which is not in `gate/allowed-red.json` and must not
 * be (Ш11): that document is the budget of admitted redness, unratified, and a
 * ceiling on time is not a redness anybody is admitting. So the gate refuses on
 * it directly -- and this is where that refusal is decided, so that the gate is
 * left doing the wiring.
 *
 * The case that matters most is the LAST one. `tests/stand/run.mjs` writes the
 * start's verdict into `verdict.json`; a gate reading a verdict without one is
 * reading a stand that did not ask, and "did not ask" must never come out green.
 */
describe('the budget of the start, at the gate', () => {
  test('a green start is not refused', () => {
    expect(refusalForTheStart({ answer: 'green', because: 'inside it', over: 0 })).toBeNull();
  });

  test('a red start is refused, and carries its own numbers', () => {
    const refusal = refusalForTheStart({
      answer: 'red',
      because: 'sitting 3 took 41000 ms to activate',
      over: 1,
    });

    expect(refusal?.point).toBeNull();
    expect(refusal?.because).toMatch(/41000/u);
  });

  test('an unmeasured start is refused too, because it is not a pass', () => {
    const refusal = refusalForTheStart({ answer: 'unmeasured', because: 'nothing was timed', over: 0 });

    expect(refusal?.because).toMatch(/unmeasured/u);
  });

  test('a verdict that says nothing about the start is refused, not read as green', () => {
    const refusal = refusalForTheStart(undefined);

    expect(refusal?.point).toBeNull();
    expect(refusal?.because).toMatch(/nothing about the start/u);
  });
});
