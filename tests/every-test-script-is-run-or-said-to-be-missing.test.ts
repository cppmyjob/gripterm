import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A check does not leave the gate in silence.
 *
 * **The defect this exists for, found 2026-09-01 while taking the stand out of
 * the gate.** `tools/gate.mjs` decides what "checked" means here, and the whole
 * of its honesty is the pair `STAGES` / `MISSING`: what it runs, and what it
 * says out loud it does not run. Nothing held the two against the list of runs
 * this repository actually has. So a stage could be deleted, or marked
 * `onItsOwn` -- one word -- and the gate would go on printing the same green
 * over a smaller question, with no red anywhere and nothing in `MISSING` to
 * read. That is the failure this file refuses, and it is the one step Ш36 was
 * about to make on purpose: the `stand` stage was being taken out.
 *
 * TWO SCRIPTS WERE ALREADY IN THAT STATE when this was first run, which is why
 * it is a rule and not a review of one afternoon. `test:eyes` was a stage that
 * NO LEVEL RUNS (`onItsOwn: true`, by design) while the gate's `MISSING` entry
 * about the eyes named `pnpm run gate:eyes` and never the script itself; and
 * `test:coverage` appeared nowhere in `tools/gate.mjs` at all -- 0 occurrences,
 * measured that day.
 *
 * **What is asserted.** Every script of the root `package.json` whose name
 * begins `test:` gives one of three answers:
 *
 *   1. A STAGE OF THE GATE RUNS IT -- `tools/gate.mjs` carries
 *      `command: ['pnpm', 'run', '<name>']` inside a stage that belongs to a
 *      level.
 *   2. `MISSING` NAMES IT -- the gate's own list of what it does not cover,
 *      printed on every run green or red, and the record that names the script
 *      carries a reason of at least `REASON_AT_LEAST` characters.
 *   3. `SPELT_ANOTHER_WAY` BELOW NAMES IT -- a stage does that script's work
 *      under a different command, so nothing is uncovered and an entry in
 *      `MISSING` would announce a loss that has not happened. Held to the same
 *      length.
 *
 * Saying nothing is the failure. The three are not ranked: which answer a script
 * should give is a judgement about that script and about what a green gate is
 * worth, and this file only refuses to let anybody avoid making it.
 *
 * **Why `onItsOwn` is read and not only the command.** `stagesHere()` composes
 * the run and `main()` filters it with `stage.onItsOwn !== true`, so a stage
 * carrying that flag exists to be found by `--only <name>` and is in no level.
 * A rule that counted every `command:` line as coverage would therefore be
 * defeated by one word -- and by the very word somebody reaching for this escape
 * would type. The eyes are the honest use of it; this rule cannot tell the
 * honest use from the quiet one, so it asks for the sentence in both cases.
 *
 * **Read as TEXT, and not imported.** `tools/gate.mjs` RUNS A GATE when it is
 * imported -- the reason `refuted-claims-stay-refuted.test.ts` gives for reading
 * that same file the same way. The manifest is JSON and is parsed, which
 * executes nothing and is a better reader than a regular expression over a data
 * file. Reading the gate as text is crude, and crude in the safe direction: a
 * stage whose command is spelled some other way is not seen here and would fail
 * this, and a stage seen here is really written.
 *
 * **What this does NOT promise, and it is the larger half.**
 *
 *   * That a reason is TRUE. A record in `MISSING` is a sentence, and a sentence
 *     is only worth the person who wrote it. What this buys is that the sentence
 *     exists where the gate is, so the next reader learns what a green does not
 *     cover from the gate itself rather than from somebody's memory.
 *   * That a stage which IS in a level really runs the script. The command is
 *     read, not executed. A stage whose `before` throws, or whose script has
 *     been emptied, satisfies every line below.
 *   * That the gate covers everything worth covering. This is about the scripts
 *     that exist. A check nobody ever wrote is invisible to it and to everything
 *     else.
 */

const REPO = join(__dirname, '..');

/** The gate, whose text is both halves of the question. */
const GATE = join('tools', 'gate.mjs');

/** The manifest whose scripts are what a person types. */
const MANIFEST = 'package.json';

/**
 * The prefix that says a script RUNS a set of tests.
 *
 * `test` itself is deliberately outside this: it is the plain unit run and it is
 * what the `unit` stage already is, so a rule about it would be a rule about a
 * name. `build:stand` and `build:eyes` are outside for the mirror reason -- they
 * compile, they check nothing.
 */
const A_TEST_SCRIPT = 'test:';

/**
 * How much of a reason counts as one: about three lines of prose.
 *
 * A number, and therefore arbitrary -- what it refuses is the one-clause reason
 * ("too slow", "needs a desktop"), which is the entry's own name restated and
 * tells the next reader nothing about what a green is missing. It cannot refuse
 * a bad paragraph, and does not pretend to.
 *
 * WHY 200 AND NOT THE 80 ITS NEIGHBOUR USES.
 * `every-run-says-whose-claude-it-starts.test.ts` holds a declaration to 80,
 * about two lines, because a declaration answers ONE question: whose agent that
 * run starts. A record here answers three -- what the check measures, why the
 * gate does not run it, and what a green therefore does not cover -- so the
 * floor is raised in proportion rather than borrowed.
 *
 * WHY NOT HIGHER. Measured 2026-09-01, the four records the gate carried that
 * day are 3576, 6693, 277 and 3231 characters of prose. The shortest is
 * `mutation`, and it is a record this repository is content with: it names the
 * tool, the date it was measured, the two defects and the two conditions that
 * would lift the bar. A floor that reddened it would be a rule about LENGTH and
 * not about reasons. 200 leaves it 77 characters of room, and leaves no room at
 * all for a clause.
 */
const REASON_AT_LEAST = 200;

/**
 * Scripts a stage covers under another command, and what covers each.
 *
 * The third answer, and the narrowest: it does not say "this is fine", it says
 * "the gate runs this check, spelled differently". An entry here is refused the
 * day the gate learns to run the script by name, so it cannot outlive its
 * reason.
 */
const SPELT_ANOTHER_WAY: Readonly<Record<string, string>> = {
  'test:coverage':
    'The CHECK this script performs is the coverage thresholds of `jest.config.js`, and the gate`s `unit` '
    + 'stage performs it: `npx jest --coverage`, chosen over a bare `npx jest` in that stage`s own comment '
    + 'because "the thresholds ARE the promise". The rest of the script is preparation the gate does in its '
    + 'own stages -- `pnpm run build` and the `tsconfig.eslint.json` pass are the `types` stage. So nothing '
    + 'is uncovered and an entry in `MISSING` would announce a loss that has not happened, which is the one '
    + 'thing that list must never carry. WHAT IS NOT CLAIMED: that the two spellings are the same command. '
    + '`test:coverage` also runs `build:extension`, which no gate stage does; that is a build and not a '
    + 'check, and a bundle that fails to build fails the `live` stage a minute later.',
};

/** The gate's own list of what it does not cover, as it opens in the file. */
const MISSING_OPENS = 'const MISSING = [';

/** How every record of that list opens, and how every stage of the gate opens too. */
const A_RECORD_OPENS = 'name: \'';

/** One record's own name, off the line that opens it. */
const A_RECORD_NAME = /name: '([\w-]+)'/u;

/** One piece of a reason, as the source spells it: single-quoted, joined with `+`. */
const A_QUOTED_PIECE = /'([^']*)'/gu;

/** The flag that takes a stage out of every level and leaves it reachable by name. */
const ON_ITS_OWN = 'onItsOwn: true';

function textOf(file: string): string {
  return readFileSync(join(REPO, file), 'utf8');
}

/**
 * Every script of the root manifest whose name says it runs tests.
 *
 * It THROWS when there are no scripts at all, rather than answering an empty
 * list. An absent input that reads like a clean measurement is how this
 * repository last talked itself into a fact nobody had checked.
 */
function testScripts(): readonly string[] {
  const manifest = JSON.parse(textOf(MANIFEST)) as { scripts?: Readonly<Record<string, string>> };
  const scripts = manifest.scripts;
  if (scripts === undefined) {
    throw new Error(
      `${MANIFEST} declares no scripts at all -- this rule is about them, and cannot read a list that is not there`
    );
  }
  return Object.keys(scripts).filter((name) => name.startsWith(A_TEST_SCRIPT));
}

/**
 * The stage of the gate that runs one script, as source text, or null.
 *
 * Sliced from that stage's own name to the next name in the file, which is crude
 * and crude in the safe direction: the slice OVER-reaches into whatever follows,
 * so it can only find an `onItsOwn` that is not this stage's -- and a false "this
 * stage is out of the levels" costs a sentence in `MISSING`, while the miss in
 * the other direction costs the whole rule.
 */
function stageRunning(text: string, script: string): string | null {
  const at = text.indexOf(`command: ['pnpm', 'run', '${script}']`);
  if (at < 0) {
    return null;
  }
  const from = text.lastIndexOf(A_RECORD_OPENS, at);
  const to = text.indexOf(A_RECORD_OPENS, at);
  return text.slice(from < 0 ? 0 : from, to < 0 ? text.length : to);
}

/**
 * Every record of `MISSING`, by name, with its reason as the prose it prints.
 *
 * The pieces of the concatenated string rather than the source slice: the source
 * carries quotes, `+` signs and indentation that a person reading the gate's
 * output never sees, and counting those towards a floor would let scaffolding
 * pass for a reason.
 *
 * It THROWS when the list is not found, for the reason `theCursorLiveRecord` in
 * `refuted-claims-stay-refuted.test.ts` gives: an absent input that reads like a
 * clean measurement is a failure this repository has already paid for.
 */
function missingRecords(text: string): ReadonlyMap<string, string> {
  const from = text.indexOf(MISSING_OPENS);
  if (from < 0) {
    throw new Error(
      `${GATE} has no \`${MISSING_OPENS}\` -- this rule is about that list, and cannot read one that is not there`
    );
  }
  const ends = text.indexOf('\n];', from);
  const records = new Map<string, string>();
  for (const record of text.slice(from, ends < 0 ? text.length : ends).split('\n  {\n').slice(1)) {
    const name = A_RECORD_NAME.exec(record)?.[1];
    const why = record.indexOf('why:');
    if (name !== undefined && why >= 0) {
      records.set(name, [...record.slice(why).matchAll(A_QUOTED_PIECE)].map((piece) => piece[1] ?? '').join(''));
    }
  }
  return records;
}

interface Answer {
  /** How the answer is spoken about in a refusal. */
  readonly name: string;
  /** The prose behind it, empty for an answer that needs none. */
  readonly reason: string;
}

/** Every answer one script gives, and not the first one it gives. */
function answersFor(script: string, text: string, missing: ReadonlyMap<string, string>): readonly Answer[] {
  const answers: Answer[] = [];
  const stage = stageRunning(text, script);
  if (stage !== null && !stage.includes(ON_ITS_OWN)) {
    answers.push({ name: 'a stage of the gate runs it', reason: '' });
  }
  for (const [record, why] of missing) {
    if (why.includes(script)) {
      answers.push({ name: `the \`${record}\` record of MISSING names it`, reason: why });
    }
  }
  const spelt = SPELT_ANOTHER_WAY[script];
  if (spelt !== undefined) {
    answers.push({ name: 'SPELT_ANOTHER_WAY names it', reason: spelt });
  }
  return answers;
}

describe('a `test:` script of this repository', () => {
  it('is run by the gate, or is written down where the gate says what it does not cover', () => {
    const text = textOf(GATE);
    const missing = missingRecords(text);
    const silent = testScripts()
      .filter((script) => answersFor(script, text, missing).length === 0)
      .map(
        (script) =>
          `\`pnpm run ${script}\` is in no level of ${GATE} and is named in neither MISSING nor `
          + 'SPELT_ANOTHER_WAY, so a green gate says nothing about it and nothing says so'
      );

    expect(silent).toStrictEqual([]);
  });

  it('gives a reason when the gate does not run it, and not a one-clause one', () => {
    const text = textOf(GATE);
    const missing = missingRecords(text);
    const thin = testScripts().flatMap((script) =>
      answersFor(script, text, missing)
        .filter(({ reason }) => reason !== '' && reason.length < REASON_AT_LEAST)
        .map(
          ({ name, reason }) =>
            `${script}: ${name} with ${String(reason.length)} characters of reason, `
            + `and ${String(REASON_AT_LEAST)} is the least this counts as one`
        )
    );

    expect(thin).toStrictEqual([]);
  });

  it('is not exempted here once the gate has learned to run it, so an exemption cannot outlive its reason', () => {
    const text = textOf(GATE);
    const scripts = new Set(testScripts());
    const stale = Object.keys(SPELT_ANOTHER_WAY).flatMap((script) => {
      if (!scripts.has(script)) {
        return [`${script} is exempted here and is not a script of ${MANIFEST} any more`];
      }
      const stage = stageRunning(text, script);
      return stage !== null && !stage.includes(ON_ITS_OWN)
        ? [`${script} is exempted here AND run by a stage of the gate -- one of the two is wrong`]
        : [];
    });

    expect(stale).toStrictEqual([]);
  });

  it('is looked for with readers that find something, so that no assertion above is about an empty list', () => {
    // Without this, a reader that matched nothing would leave the first
    // assertion red for every script at once and the second green over an empty
    // list -- the way a guard stops guarding, which this repository has been
    // bitten by four times (`named-tests-exist.test.ts`, `every-label-is-run.test.ts`,
    // `every-run-names-its-engine.test.ts` and
    // `every-run-says-whose-claude-it-starts.test.ts` all carry a line like this).
    const text = textOf(GATE);
    const missing = missingRecords(text);
    const scripts = testScripts();
    const given = new Set(scripts.flatMap((script) => answersFor(script, text, missing).map(({ name }) => name)));

    expect(scripts.length).toBeGreaterThan(5);
    expect(missing.size).toBeGreaterThanOrEqual(4);
    expect([...missing.values()].every((why) => why.length > 0)).toBe(true);
    expect([...given].some((name) => name === 'a stage of the gate runs it')).toBe(true);
    expect([...given].some((name) => name.endsWith('record of MISSING names it'))).toBe(true);
  });
});
