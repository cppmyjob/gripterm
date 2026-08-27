import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `tools/what-fell.js`: which tests a stage's own output says went red.
 *
 * **The defect this exists for, and it is in this repository's own records.**
 * `.gate/receipts.ndjson` had 26 full runs over 12 revisions on 2026-08-26 and
 * every red stage in it says the same thing: `"ok": false`. Nothing else. Two
 * different failures of the same stage are therefore the same line, and the two
 * red-gate analyses of that day each spent hours recovering, from memory and
 * from re-runs, a name the receipt could have held as a string. This turns the
 * output the gate ALREADY prints into that string.
 *
 * **Every fixture below was captured from the real tool**, not written by hand,
 * and then had the paths of the machine it was captured on replaced -- the same
 * rule `tests/stand/no-machine-in-the-record.test.ts` holds over the stand's
 * recordings, for the same reason: `source` is a public repository. Nothing else
 * about them was touched; the Jest one still carries its real ANSI colour codes,
 * because a parser that only works on output nobody colours would work on
 * nothing the gate actually captures.
 *
 * **What this deliberately does not promise.** That every format is recognised.
 * A stage whose output matches none of them comes back `null`, and the gate
 * records that it looked and could name nothing -- which is a different fact
 * from a stage nobody looked at, and is the entry that says a format needs
 * teaching.
 */

interface Fell {
  readonly kind: string;
  readonly count: number | null;
  readonly named: readonly string[];
  readonly first: string | null;
}

interface DidNotRun {
  readonly kind: string;
  readonly skipped: number;
  readonly total: number;
}

interface Transcript {
  say: (text: string) => void;
  said: () => string;
  dropped: () => number;
}

/**
 * Loaded through `createRequire` rather than imported.
 *
 * `tools/what-fell.js` is CommonJS for the reason written at its head -- the
 * gate reads it before anything has been built -- and a `.d.ts` beside it would
 * be a TypeScript file outside `tsconfig.eslint.json`, which is a lint failure
 * rather than a type. So the shape is declared here, at the one place that
 * consumes it from TypeScript, and `tools/gate.mjs` takes it as it is.
 */
const load = createRequire(__filename);
const { transcript, whatDidNotRun, whatFell } = load(join(__dirname, '..', 'tools', 'what-fell.js')) as {
  transcript: (most: number) => Transcript;
  whatDidNotRun: (said: string) => DidNotRun | null;
  whatFell: (said: string) => Fell | null;
};

function fixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf8');
}

describe('what fell over, out of a stage`s own output', () => {
  describe('Mocha, which is what the live suites and the Cursor strip run under', () => {
    it('names every failing test, suite path and all', () => {
      const fell = whatFell(fixture('mocha-two-failing.txt'));

      expect(fell?.kind).toBe('mocha');
      expect(fell?.named).toStrictEqual([
        'a terminal of ours, on our own screen > the size of the screen reaches the terminal, and every later size reaches the pty',
        'a terminal of ours, on our own screen > nested > a nested one fails too',
      ]);
    });

    it('counts what Mocha counted, not what it managed to name', () => {
      expect(whatFell(fixture('mocha-two-failing.txt'))?.count).toBe(2);
    });

    it('keeps the first line of the first failure, which is where the numbers are', () => {
      expect(whatFell(fixture('mocha-two-failing.txt'))?.first).toContain(
        'waited 30000 ms for the pseudoconsole to acknowledge a resize at all'
      );
    });

    it('does not count the same failure twice for being listed twice', () => {
      // Mocha prints each failure in the run itself AND again in the block at
      // the end. A parser that read both would say four where Mocha says two.
      expect(whatFell(fixture('mocha-two-failing.txt'))?.named).toHaveLength(2);
    });

    it('says nothing about a run where nothing failed', () => {
      const green = '\n  a terminal of ours\n    ✔ one\n    ✔ two\n\n\n  2 passing (3s)\n\n';
      expect(whatFell(green)).toBeNull();
    });
  });

  describe('Jest, which is what the unit stage runs under', () => {
    it('names every failing test through its describe path', () => {
      const fell = whatFell(fixture('jest-two-failing.txt'));

      expect(fell?.kind).toBe('jest');
      expect(fell?.named).toStrictEqual([
        'a bounded transcript > says what it dropped',
        'a bounded transcript > nested > a nested one fails too',
      ]);
    });

    it('takes the count from the line Jest totals on', () => {
      expect(whatFell(fixture('jest-two-failing.txt'))?.count).toBe(2);
    });

    it('strips the colour Jest writes even into a pipe', () => {
      const first = whatFell(fixture('jest-two-failing.txt'))?.first;

      expect(first).toBe('waited 30000 ms for the pseudoconsole to acknowledge a resize at all');
      expect(first).not.toContain('\u001B[');
    });
  });

  describe('the compiler and the linter, which have files rather than tests', () => {
    it('names the files the compiler refused, and counts its errors', () => {
      const fell = whatFell(fixture('tsc-errors.txt'));

      expect(fell?.kind).toBe('types');
      expect(fell?.count).toBe(9);
      expect(fell?.named).toStrictEqual([
        'tests/integration/terminal-in-view.ts',
        'node_modules/@types/mocha/index.d.ts',
      ]);
      expect(fell?.first).toContain('error TS2322');
    });

    it('names the files the linter refused, and counts its problems', () => {
      const fell = whatFell(fixture('eslint-errors.txt'));

      expect(fell?.kind).toBe('lint');
      expect(fell?.count).toBe(4);
      expect(fell?.named).toStrictEqual(['D:\\gripterm\\tools\\gate.mjs']);
      expect(fell?.first).toContain('no-unused-vars');
    });
  });

  describe('the size of what it writes, because a receipt is a file that only grows', () => {
    it('names at most twelve, and still says how many there were', () => {
      const many = Array.from({ length: 40 }, (_, at) => `  ${String(at + 1)}) a suite\n       test number ${String(at + 1)}:\n     Error: no\n`);
      const fell = whatFell(`  0 passing (1s)\n  40 failing\n\n${many.join('\n')}`);

      expect(fell?.count).toBe(40);
      expect(fell?.named).toHaveLength(12);
    });

    it('cuts a name that would be a paragraph', () => {
      const long = 'x'.repeat(400);
      const fell = whatFell(`  0 passing (1s)\n  1 failing\n\n  1) a suite\n       ${long}:\n     Error: no\n`);

      expect(fell?.named[0]?.length).toBeLessThanOrEqual(160);
    });

    it('cuts a first line that would be a paragraph', () => {
      const long = 'y'.repeat(2000);
      const fell = whatFell(`  0 passing (1s)\n  1 failing\n\n  1) a suite\n       a test:\n     Error: ${long}\n`);

      expect(fell?.first?.length).toBeLessThanOrEqual(400);
    });
  });

  describe('a bounded transcript, which is how the gate holds four minutes of output', () => {
    it('keeps everything that fits', () => {
      const kept = transcript(100);
      kept.say('one ');
      kept.say('two');

      expect(kept.said()).toBe('one two');
      expect(kept.dropped()).toBe(0);
    });

    it('drops the oldest first, because Mocha says what failed at the END', () => {
      const kept = transcript(10);
      kept.say('aaaaa');
      kept.say('bbbbb');
      kept.say('ccccc');

      expect(kept.said()).toBe('bbbbbccccc');
      expect(kept.dropped()).toBe(5);
    });

    it('cuts a single chunk bigger than the whole bound', () => {
      const kept = transcript(4);
      kept.say('abcdefghij');

      expect(kept.said()).toBe('ghij');
      expect(kept.dropped()).toBe(6);
    });

    it('still finds the failure that a drop moved to the front', () => {
      const kept = transcript(4096);
      kept.say('n'.repeat(100_000));
      kept.say(fixture('mocha-two-failing.txt'));

      expect(kept.dropped()).toBeGreaterThan(0);
      expect(whatFell(kept.said())?.named).toHaveLength(2);
    });
  });
});

/**
 * How many of a stage's tests did NOT run, out of the output it already printed.
 *
 * **The defect this exists for, 2026-08-27.** The gate prints `GREEN ... 5 of 5
 * checked` and a list of what it does not cover, and beside a stage it prints a
 * time. It has never printed how many tests inside that stage were switched off.
 * A green stage with twenty disabled tests and a green stage with none are the
 * same line, and the difference between them is exactly the thing a person
 * reading a green wants to know.
 *
 * **Both fixtures were captured from the real runner** and not written by hand,
 * which is the rule `what-fell`'s own fixtures follow and for the same reason: a
 * parser tested against invented output is a parser tested against its author's
 * memory. `mocha-with-pending.txt` is Mocha 10.8.2's spec reporter over a
 * throwaway spec with three `it.skip`s, run directly with no editor involved;
 * `jest-with-skips.txt` is this repository's own `way-out` suite under `-t`,
 * ANSI and all.
 *
 * **What it deliberately does not promise.** That every stage can answer. A
 * stage whose output no runner wrote comes back `null`, and the gate then says
 * that the number is not known for that stage rather than printing a nought --
 * a nought nobody measured would be the worst of the three possible answers.
 */
describe('how many of a stage`s tests did not run', () => {
  describe('Mocha, whose word for it is `pending`', () => {
    it('counts the pending ones', () => {
      expect(whatDidNotRun(fixture('mocha-with-pending.txt'))?.skipped).toBe(3);
    });

    it('counts every test the run had, not only the ones that ran', () => {
      // 2 passing + 3 pending, and the total is what makes the skipped number
      // mean anything: `3 skipped` reads differently out of 5 than out of 500.
      expect(whatDidNotRun(fixture('mocha-with-pending.txt'))?.total).toBe(5);
      expect(whatDidNotRun(fixture('mocha-with-pending.txt'))?.kind).toBe('mocha');
    });

    it('says NONE were skipped where Mocha printed no pending line at all', () => {
      // Mocha prints `N pending` only when N is not nought, so the absence of
      // the line is the answer `0` and must not be read as "did not say".
      const none = whatDidNotRun(fixture('mocha-two-failing.txt'));

      expect(none?.kind).toBe('mocha');
      expect(none?.skipped).toBe(0);
      expect(none?.total).toBe(3);
    });
  });

  describe('Jest, whose word for it is `skipped`', () => {
    it('counts the skipped ones and the whole run', () => {
      const some = whatDidNotRun(fixture('jest-with-skips.txt'));

      expect(some?.kind).toBe('jest');
      expect(some?.skipped).toBe(12);
      expect(some?.total).toBe(13);
    });

    it('says NONE were skipped where the totals line names no skipped at all', () => {
      const none = whatDidNotRun(fixture('jest-two-failing.txt'));

      expect(none?.kind).toBe('jest');
      expect(none?.skipped).toBe(0);
      expect(none?.total).toBe(3);
    });

    it('counts a `todo` as a test that did not run, because it did not', () => {
      // Jest keeps `todo` apart from `skipped` in its own summary. Both are
      // tests that were not executed, and a reader asking "what did this green
      // not check" is asking one question, not two.
      expect(whatDidNotRun('Tests:       2 todo, 1 skipped, 4 passed, 7 total')?.skipped).toBe(3);
    });
  });

  describe('a stage no runner wrote the output of', () => {
    it('is null rather than nought, so an unmeasured number is never printed as one', () => {
      expect(whatDidNotRun(fixture('tsc-errors.txt'))).toBeNull();
      expect(whatDidNotRun(fixture('eslint-errors.txt'))).toBeNull();
      expect(whatDidNotRun('')).toBeNull();
    });
  });
});
