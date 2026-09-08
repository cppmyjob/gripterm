import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Every acceptance suite is selected by exactly one `--grep`, and no `--grep`
 * selects two.
 *
 * **The hazard this exists for, 2026-09-08 (Ш37).** `tests/acceptance/run.mjs`
 * does not run a suite by file: it opens one editor host per criterion and picks
 * the suite inside it with mocha's `--grep`, which is a REGEX tested against
 * `test.fullTitle()` -- the suite's name, a space, and the test's
 * (`Mocha.prototype.grep`, mocha 10.8.2: a string is passed to `new RegExp`
 * unescaped; it is `fgrep` that escapes). So the selection is a SUBSTRING match
 * on prose, and prose is where names come from. The step that split
 * `rename from the CLI` into two suites is exactly the move that can go wrong
 * here: give the halves names where one contains the other, and the shorter one
 * runs both halves in one host while the longer runs one of them again in the
 * next -- two editor windows walking three suites, a store emptied between the
 * wrong pair, and every timing in `tools/gate.mjs` measuring a different run.
 * Nothing would say so. The suites pass either way.
 *
 * **What is asked here, and it is the shape `live-runs-split-by-engine.test.ts`
 * asks of the live suites:** that the selection is DECLARED, DISJOINT and TOTAL.
 * Each name the runner greps with selects at least one full title; no two names
 * select the same one; and between them they select every full title there is --
 * a suite no name selects is a suite that runs nowhere, which is the failure a
 * name can always have and a file glob never can.
 *
 * One more, and it is the mirror of the "excludes only labels that exist" line
 * its neighbours carry: every key of `NOT_UNDER_OWN` is one of the names the
 * runner really greps with. That map is looked up BY the grep string, so a key
 * that matches no call is an exclusion that excludes nothing -- and it would
 * read, in the file, exactly like one that works.
 *
 * **Read as TEXT, and not imported.** `tests/acceptance/run.mjs` opens editor
 * windows and refuses to be loaded without `GRIPTERM_ACCEPTANCE=yes`; importing
 * it here would either exit the Jest worker or open a desktop's worth of
 * windows. The same reasoning its neighbours give about `.vscode-test.mjs` and
 * `tools/gate.mjs`, and the same crudeness in the same safe direction: a suite
 * declared some other way is not seen here, and one seen here is really
 * declared.
 *
 * **What this does NOT promise.** That a suite belongs under the engine it is
 * given -- that is a judgement, it is written as prose beside `NOT_UNDER_OWN`,
 * and no reader of text can check it. That a suite passes. That the run walks
 * every criterion: `run.mjs` takes criteria on its command line, and a person
 * who asks for one gets one.
 */

const REPO = resolve(__dirname, '..');

/** The runner, whose `--grep` calls are one half of the question. */
const RUNNER = join('tests', 'acceptance', 'run.mjs');

/** Where the suites themselves are: the other half. */
const SUITES = join('tests', 'acceptance');

/** How `run.mjs` opens a host. Both spellings, because only one of them consults the exclusions. */
const GREPPED = /(?:hostUnlessTheEngineForbidsIt|host)\(\s*'((?:[^'\\]|\\.)*)'/gu;

/** `suite('...')` and `test('...')` as mocha's own files write them, at the start of a line. */
const DECLARED = /^[ \t]*(suite|test)\(\s*'((?:[^'\\]|\\.)*)'/gmu;

/** Where the exclusions open, and where the slice holding them ends. */
const EXCLUSIONS_OPEN = 'const NOT_UNDER_OWN = new Map([';
const EXCLUSIONS_CLOSE = ']);';

/** One entry of that map, whose first quoted string is the grep it is looked up by. */
const AN_EXCLUSION = /^\s*\['((?:[^'\\]|\\.)*)'/gmu;

function textOf(file: string): string {
  return readFileSync(join(REPO, file), 'utf8');
}

/** Every name the runner selects a host's suite with, in the order it uses them. */
function grepsOfTheRunner(): readonly string[] {
  return [...textOf(RUNNER).matchAll(GREPPED)].map((found) => found[1] ?? '');
}

/**
 * Every full title mocha will match a grep against: the suite's name and the
 * test's, joined the way `Runnable.fullTitle` joins them.
 *
 * A `test` before any `suite` throws rather than being attributed to nothing.
 * An absent input that reads like a clean answer is how this repository last
 * talked itself into a fact nobody had checked.
 */
function fullTitlesOfTheSuites(): readonly string[] {
  const titles: string[] = [];
  for (const file of readdirSync(join(REPO, SUITES)).filter((name) => name.endsWith('.test.ts'))) {
    let suiteTitle: string | null = null;
    for (const [, kind, title] of textOf(join(SUITES, file)).matchAll(DECLARED)) {
      if (kind === 'suite') {
        suiteTitle = title ?? '';
        continue;
      }
      if (suiteTitle === null) {
        throw new Error(`${file} declares a test before any suite, and this rule cannot say what its full title is`);
      }
      titles.push(`${suiteTitle} ${title ?? ''}`);
    }
  }
  return titles;
}

/** The keys of `NOT_UNDER_OWN`, which are grep strings and are looked up as such. */
function exclusionsOfTheRunner(): readonly string[] {
  const text = textOf(RUNNER);
  const from = text.indexOf(EXCLUSIONS_OPEN);
  if (from === -1) {
    throw new Error(`${RUNNER} no longer opens with \`${EXCLUSIONS_OPEN}\` -- this rule is about that map and cannot read one that is not there`);
  }
  const to = text.indexOf(EXCLUSIONS_CLOSE, from);
  if (to === -1) {
    throw new Error(`${RUNNER} opens \`${EXCLUSIONS_OPEN}\` and never closes it`);
  }
  return [...text.slice(from, to).matchAll(AN_EXCLUSION)].map((found) => found[1] ?? '');
}

/** What mocha would run for one name. The same construction `Mocha.prototype.grep` performs. */
function selectedBy(grep: string, titles: readonly string[]): readonly string[] {
  const pattern = new RegExp(grep, 'u');
  return titles.filter((title) => pattern.test(title));
}

describe('the acceptance run, which picks its suites with mocha`s --grep', () => {
  it('selects something with every name it greps for', () => {
    const titles = fullTitlesOfTheSuites();
    const empty = grepsOfTheRunner()
      .filter((grep) => selectedBy(grep, titles).length === 0)
      .map((grep) => `--grep '${grep}' selects no suite`);

    expect(empty).toStrictEqual([]);
  });

  it('selects each suite once, so that no host walks two and no suite is walked twice', () => {
    const titles = fullTitlesOfTheSuites();
    const greps = grepsOfTheRunner();
    const twice = titles
      .map((title) => ({ title, by: greps.filter((grep) => selectedBy(grep, titles).includes(title)) }))
      .filter(({ by }) => by.length !== 1)
      .map(({ title, by }) => `"${title}" is selected by ${by.length.toString()} names: ${JSON.stringify(by)}`);

    expect(twice).toStrictEqual([]);
  });

  it('leaves no suite unrun, so that a name nobody greps for is not silence', () => {
    const titles = fullTitlesOfTheSuites();
    const greps = grepsOfTheRunner();
    const selected = new Set(greps.flatMap((grep) => selectedBy(grep, titles)));
    const nowhere = titles.filter((title) => !selected.has(title));

    expect(nowhere).toStrictEqual([]);
  });

  it('excludes only names it really greps for, so that an exclusion cannot exclude nothing', () => {
    const greps = new Set(grepsOfTheRunner());
    const orphaned = exclusionsOfTheRunner().filter((key) => !greps.has(key));

    expect(orphaned).toStrictEqual([]);
  });

  it('is looked for at all, so that no assertion above is about an empty list', () => {
    expect(grepsOfTheRunner().length).toBeGreaterThanOrEqual(4);
    expect(fullTitlesOfTheSuites().length).toBeGreaterThanOrEqual(4);
    expect(exclusionsOfTheRunner().length).toBeGreaterThanOrEqual(1);
  });
});
