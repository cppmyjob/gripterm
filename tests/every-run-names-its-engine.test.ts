import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A run that opens a window with the product in it SAYS which engine it is
 * measuring, instead of taking whatever the manifest's default happens to be.
 *
 * **The defect this exists for, found 2026-08-30 while moving the default.**
 * Four of our runs pinned no engine at all: the `integration` label of
 * `.vscode-test.mjs`, `tests/stand/run.mjs`, `tests/eyes/run.mjs` and
 * `tests/acceptance/run.mjs`. Nothing said so, and nothing could: a window that
 * sets nothing reads the manifest's default, and `getConfiguration().get()`
 * hands back that default with the same shape as a value somebody chose. So the
 * suites that exist to measure the EDITOR engine -- the strip in the editor
 * area, the tabs drawn on it, the nine points of the stand about groups -- were
 * measuring it only for as long as nobody moved the default. The day the
 * default moved they would have gone on being green while measuring the other
 * engine, and the whole of the `editor` coverage would have been lost without a
 * red anywhere.
 *
 * **Why this is a TEXT test and not an assertion inside a window.** The live
 * half already exists and cannot catch this: `pty-engine.test.ts` asserts that
 * the engine which ANSWERED is the one the window was asked for, and a window
 * that was asked for nothing passes it trivially -- the default answers, the
 * default was read, the two agree. What is missing is upstream of any window:
 * did the run SAY. And two of these runs -- the stand and the eyes -- are not
 * mocha suites at all; they drive an editor from outside, so there is no window
 * of theirs an assertion of ours could be placed in. Reading the runner as text
 * is the only instrument that reaches all of them.
 *
 * Read as TEXT, and deliberately, for the reason `every-label-is-run.test.ts`
 * gives: importing `.vscode-test.mjs` runs `refuseStaleBuilds()`, seeds records
 * into two stores and reads an editor's `product.json`, none of which belongs in
 * a Jest run that needs no build and no editor. What is checked is the shape of
 * a line, which is crude, and crude in the safe direction: a setting written
 * some other way is not seen here, and a setting seen here is really written.
 *
 * **What this does NOT promise.** That the window read it. A profile written to
 * a directory the editor was never pointed at would satisfy every line below.
 * That half is `pty-engine.test.ts`'s, which asserts from inside a live window
 * that the setting it can see is the one that answered -- the two tests are
 * halves of one claim and neither is worth much alone.
 */

const REPO = join(__dirname, '..');

/** The runner config, whose labels are several runs in one file. */
const CONFIG = '.vscode-test.mjs';

/**
 * `'gripterm.terminal.engine': 'editor'` as a settings entry, and not the same
 * name written in a sentence.
 *
 * The colon and the quoted value are what tell a profile from prose: this file
 * would otherwise count the four comments that explain WHY an engine is pinned
 * as if each were a pin of its own.
 */
const PINNED = /['"]gripterm\.terminal\.engine['"]\s*:\s*['"](\w+)['"]/gu;

/** The engines there are. Spelled here rather than imported: this test is about text. */
const ENGINES = new Set(['editor', 'own']);

/**
 * Every run that opens a window the product makes terminals in, and where it
 * writes the profile that window reads.
 *
 * `tests/vsix/run.mjs` is here although it has always pinned its engine: a list
 * that held only the runs which were once wrong would stop being a rule and
 * become a record of one afternoon.
 */
const RUNS = [
  { what: 'the stand', file: join('tests', 'stand', 'run.mjs'), pins: 1 },
  { what: 'the eyes', file: join('tests', 'eyes', 'run.mjs'), pins: 1 },
  // TWO, and the second one is the whole of Ш32. Until 2026-08-31 this run was
  // pinned to `editor` with a comment calling that a debt: walking it under `own`
  // as well cost real turns of the owner's account, so it had never been done.
  // The double in `tests/acceptance/fake-claude/` removed the price, and the run
  // now writes a profile for each engine and chooses between them with
  // `GRIPTERM_ACCEPTANCE_ENGINE`. Both spellings are literal in that file so that
  // this reader can see them; one window still gets one engine.
  { what: 'the acceptance run', file: join('tests', 'acceptance', 'run.mjs'), pins: 2 },
  { what: 'the VSIX run', file: join('tests', 'vsix', 'run.mjs'), pins: 1 },
] as const;

/**
 * The labels of `.vscode-test.mjs` that open a window with the product WORKING
 * in it, and the one that does not.
 *
 * `cursor` is excluded and the reason is the one its own suite states at length:
 * nothing under `tests/cursor` exercises Gripterm. It measures the fork's
 * workbench -- `workbench.action.newGroupBelow` -- with a command and two
 * read-only APIs, and would measure it identically on either engine. Pinning one
 * there would be a promise about a subject that stage does not have.
 */
const LABELS_WITHOUT_THE_PRODUCT = new Map([
  ['cursor', 'nothing under `tests/cursor` exercises Gripterm -- its subject is the fork`s own workbench'],
]);

/** `label: 'integration'` and nothing cleverer, the same reader `every-label-is-run.test.ts` uses. */
const DECLARED = /^\s*label:\s*'([\w-]+)'/gmu;

function textOf(file: string): string {
  return readFileSync(join(REPO, file), 'utf8');
}

/** Every engine a file pins, in the order it pins them. */
function enginesPinnedIn(file: string): readonly string[] {
  return [...textOf(file).matchAll(PINNED)].map((found) => found[1] ?? '');
}

/** The labels of the runner config whose windows really run the product. */
function labelsThatRunTheProduct(): readonly string[] {
  return [...textOf(CONFIG).matchAll(DECLARED)]
    .map((found) => found[1] ?? '')
    .filter((label) => !LABELS_WITHOUT_THE_PRODUCT.has(label));
}

describe('a run that opens a window with the product in it', () => {
  it('names an engine at all, rather than living on whatever the manifest defaults to', () => {
    const silent = RUNS.filter(({ file }) => enginesPinnedIn(file).length === 0).map(
      ({ what, file }) => `${what} (${file}) names no engine`
    );
    const labels = labelsThatRunTheProduct();
    const config = enginesPinnedIn(CONFIG);
    const unsaid =
      config.length < labels.length
        ? [`${CONFIG} pins ${config.length} engines for the ${labels.length} labels ${labels.join(', ')}`]
        : [];

    expect([...silent, ...unsaid]).toStrictEqual([]);
  });

  it('names as many engines as it walks, so that two lines cannot disagree about one window', () => {
    const miscounted = RUNS.filter(({ file, pins }) => enginesPinnedIn(file).length !== pins).map(
      ({ what, file, pins }) => `${what} (${file}) pins ${enginesPinnedIn(file).length}, not ${pins}`
    );

    expect(miscounted).toStrictEqual([]);
    expect(enginesPinnedIn(CONFIG)).toHaveLength(labelsThatRunTheProduct().length);
  });

  it('names an engine this build has, so that a typo is not a silent fallback', () => {
    const unknown = [...RUNS.map(({ file }) => file), CONFIG].flatMap((file) =>
      enginesPinnedIn(file)
        .filter((engine) => !ENGINES.has(engine))
        .map((engine) => `${file} pins '${engine}'`)
    );

    expect(unknown).toStrictEqual([]);
  });

  /*
   * That the reader above sees anything at all. Without this, a regular
   * expression that matched nothing would leave every assertion here passing
   * over empty lists -- the way a guard stops guarding, and one this repository
   * has been bitten by twice (`named-tests-exist.test.ts`,
   * `every-label-is-run.test.ts` both carry a line like this for the same
   * reason).
   */
  it('is looked for at all, so that no assertion above is about an empty list', () => {
    expect([...textOf(CONFIG).matchAll(DECLARED)].length).toBeGreaterThanOrEqual(2);
    expect(LABELS_WITHOUT_THE_PRODUCT.size).toBeGreaterThan(0);
    expect(RUNS.length).toBeGreaterThanOrEqual(4);
  });

  /*
   * The exclusion list cannot name a label that is not there: a renamed stage
   * would otherwise turn an exclusion into an exclusion of nothing, and the
   * label it used to name would slip in unpinned and unnoticed. The same shape
   * as `NOT_UNDER_OWN` in `.vscode-test.mjs`, which throws for the same reason.
   */
  it('excludes only labels that exist, so that a rename cannot empty the exclusion', () => {
    const declared = new Set([...textOf(CONFIG).matchAll(DECLARED)].map((found) => found[1] ?? ''));
    const gone = [...LABELS_WITHOUT_THE_PRODUCT].filter(([label]) => !declared.has(label)).map(([label]) => label);

    expect(gone).toStrictEqual([]);
  });
});
