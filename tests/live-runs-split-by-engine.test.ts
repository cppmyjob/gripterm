import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Every live suite runs somewhere, and no suite runs twice for nothing.
 *
 * **The defect this exists for, 2026-09-01.** `.vscode-test.mjs` declared two
 * labels over one directory: `integration` took `out/tests/integration/**` whole
 * and pinned the editor's engine, `own` took the same directory minus six names
 * and pinned ours. Twenty-eight suites of thirty-four therefore ran TWICE, and
 * the second time under an engine that stopped being the default on 2026-08-30.
 * Nothing said so, and nothing could: a glob is not a statement about coverage,
 * it is the absence of one.
 *
 * **What is asked here instead.** That the division is DECLARED -- three named
 * sets, a reason at each name -- and that the declaration is total: the three do
 * not overlap, and between them they name every suite there is. A suite left out
 * of all three is a suite that runs nowhere, which is the failure a glob can
 * never have and a list always can.
 *
 * **Read as TEXT, and the reason is the one its siblings give.**
 * `every-label-is-run.test.ts` and `every-run-names-its-engine.test.ts` both say
 * at length why `.vscode-test.mjs` is not imported here: importing it runs
 * `refuseStaleBuilds()`, seeds a restorable record into two stores and reads an
 * editor's `product.json`. The split module is the opposite -- it is required to
 * be loadable -- and it is loaded, in a `node` of its own, because this run is
 * CommonJS and the module is ESM. That spawn is not a workaround: a module that
 * did something on the way in would show it there.
 *
 * **What this does NOT promise.** That the suites in each set belong there. That
 * is a judgement about what each one measures, it is written down as the reason
 * beside each name in `tests/engine-split.mjs`, and no reader of text can check
 * it. What this holds is the shape: declared, disjoint, total.
 */

const REPO = resolve(__dirname, '..');

/** The runner config, whose labels are several runs in one file. */
const CONFIG = '.vscode-test.mjs';

/** Where the division is declared, and the only place it may be. */
const SPLIT = join('tests', 'engine-split.mjs');

/** The suites themselves, as sources -- see `everySuite` for why not as output. */
const SOURCES = join('tests', 'integration');

/** The labels that carry the live suites. `cursor` runs somebody else's workbench. */
const LIVE_LABELS = ['integration', 'own'] as const;

/**
 * The modules whose import DOES something, named so that the split cannot pull
 * one in.
 *
 * Each of these is a side effect the whole design of the split module refuses:
 * a stale-build refusal, a record seeded into a store, a profile written to
 * disk. A division that needed any of them could not be read by a test.
 */
const SIDE_EFFECTS = ['refuse-stale-builds', 'seed-restorable-record', 'host-user-data'];

/** `label: 'integration'` and nothing cleverer, the same reader the sibling guards use. */
const DECLARED = /^\s*label:\s*'([\w-]+)'/gmu;

/** `files: <anything>` -- the rest of that line, tidied by `expressionOf` rather than by the pattern. */
const FILES = /^[ \t]*files:(.*)$/mu;

/** The names a module brings in from the split, as an import statement writes them. */
const IMPORTED = /import\s*\{([^}]+)\}\s*from\s*'\.\/tests\/engine-split\.mjs'/u;

function textOf(file: string): string {
  return readFileSync(join(REPO, file), 'utf8');
}

/**
 * The `files:` expression of each label, as it is written.
 *
 * Taken from the label's own slice of the file rather than by a two-line
 * pattern: a reader that required `files` to follow `label` immediately would
 * turn a reordering of two keys into a failure about coverage.
 */
function filesByLabel(): ReadonlyMap<string, string> {
  const text = textOf(CONFIG);
  const at = [...text.matchAll(DECLARED)].map((found) => ({ label: found[1] ?? '', from: found.index }));
  const found = new Map<string, string>();
  for (const [index, one] of at.entries()) {
    const to = at[index + 1]?.from ?? text.length;
    found.set(one.label, expressionOf(text.slice(one.from, to)));
  }
  return found;
}

/** The `files:` expression of one label's slice, without the line's own punctuation. */
function expressionOf(slice: string): string {
  return (FILES.exec(slice)?.[1] ?? '').trim().replace(/,$/u, '');
}

/** What `.vscode-test.mjs` takes from the split module, or an empty list. */
function importedFromTheSplit(): readonly string[] {
  return (IMPORTED.exec(textOf(CONFIG))?.[1] ?? '')
    .split(',')
    .map((one) => one.trim())
    .filter((one) => one.length > 0);
}

/**
 * Every suite there is, by the name the compiled run calls it.
 *
 * Read from the SOURCES and mapped, rather than listed out of `out/`, and the
 * reason is which failure each direction can have.  `tsconfig.integration.json`
 * compiles `tests/integration/**` into `out/` one for one, so the two lists are
 * the same set whenever the build is current -- but a Jest run needs no build,
 * and a run that read an empty `out/` would pass this file over nothing at all.
 * The compiled directory is checked in the live run instead, by the split module
 * itself, which refuses a name that is not there and a suite that is not named.
 */
function everySuite(): readonly string[] {
  return readdirSync(join(REPO, SOURCES))
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => name.replace(/\.ts$/u, '.js'))
    .sort();
}

interface Split {
  /** Suite name -> why it is in this set. */
  readonly editor: Record<string, string>;
  readonly both: Record<string, string>;
  readonly own: Record<string, string>;
}

/**
 * The three sets, read by LOADING the module in a node of its own.
 *
 * The spawn is the measurement: a module that seeded a store, read an
 * environment variable or refused a stale build on the way in would say so here,
 * either by failing or by printing. Nothing but the JSON may come out.
 */
function loadTheSplit(): Split {
  const moduleUrl = pathToFileURL(join(REPO, SPLIT)).href;
  const script =
    `const split = await import(${JSON.stringify(moduleUrl)});\n` +
    'process.stdout.write(JSON.stringify({\n' +
    '  editor: Object.fromEntries(split.EDITOR_SUBJECT),\n' +
    '  both: Object.fromEntries(split.UNDER_BOTH_ENGINES),\n' +
    '  own: Object.fromEntries(split.OWN_SUBJECT),\n' +
    '}));\n';
  const printed = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: REPO,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(printed) as Split;
}

/** The three sets as one list of names, with whichever of them is asked for left out. */
function unionOf(split: Split, without: readonly (keyof Split)[] = []): readonly string[] {
  return (['editor', 'both', 'own'] as const)
    .filter((set) => !without.includes(set))
    .flatMap((set) => Object.keys(split[set]))
    .sort();
}

/** The suites no set names, given a union. Empty is the promise; anything else is the defect. */
function unaccountedFor(union: readonly string[]): readonly string[] {
  const named = new Set(union);
  return everySuite().filter((suite) => !named.has(suite));
}

describe('the two live labels of the runner config', () => {
  it('take their suites from a declared division rather than from a glob over the whole directory', () => {
    const imported = importedFromTheSplit();
    const files = filesByLabel();
    const globbed = LIVE_LABELS.filter((label) => {
      const expression = files.get(label) ?? '';
      return !imported.some((name) => expression.includes(`${name}(`));
    }).map((label) => `${label} takes \`files: ${String(files.get(label))}\`, which is not a call into ${SPLIT}`);

    expect(globbed).toStrictEqual([]);
  });

  it('read that division out of a module whose import does nothing at all', () => {
    expect(existsSync(join(REPO, SPLIT))).toBe(true);

    const text = textOf(SPLIT);
    const pulled = SIDE_EFFECTS.filter((sideEffect) => text.includes(sideEffect));

    expect(pulled).toStrictEqual([]);
    // `process.env` is the other way a module decides something on the way in,
    // and a division that read one would be a different division per machine.
    expect(text).not.toContain('process.env');
    expect(() => loadTheSplit()).not.toThrow();
  });

  it('divide the suites into three sets that do not overlap', () => {
    const split = loadTheSplit();
    const seen = new Map<string, string[]>();
    for (const set of ['editor', 'both', 'own'] as const) {
      for (const suite of Object.keys(split[set])) {
        seen.set(suite, [...(seen.get(suite) ?? []), set]);
      }
    }
    const twice = [...seen]
      .filter(([, sets]) => sets.length > 1)
      .map(([suite, sets]) => `${suite} is in ${sets.join(' and ')}`);

    expect(twice).toStrictEqual([]);
  });

  it('name every suite there is between them, so that none of them runs nowhere', () => {
    expect(unaccountedFor(unionOf(loadTheSplit()))).toStrictEqual([]);
  });

  it('give a reason at every name, because a set with no reasons is a list somebody will edit blind', () => {
    const split = loadTheSplit();
    const mute = (['editor', 'both', 'own'] as const).flatMap((set) =>
      Object.entries(split[set])
        .filter(([, why]) => why.trim().length < 20)
        .map(([suite, why]) => `${set}/${suite} says '${why}'`)
    );

    expect(mute).toStrictEqual([]);
  });

  /*
   * The positive control, and it is here for the reason every reader in this
   * repository now carries one: `[] === []` is what a broken walk looks like
   * from the outside. This one does not assert that the walk found something --
   * it takes the answer APART. With one whole set left out of the union, the
   * suites of that set must come back named; if they do not, the assertion above
   * is green over a comparison that cannot fail.
   */
  it('is a comparison that can fail, checked by leaving one whole set out of the union', () => {
    const split = loadTheSplit();
    const missed = unaccountedFor(unionOf(split, ['editor']));

    expect([...missed].sort()).toStrictEqual(Object.keys(split.editor).sort());
    expect(missed.length).toBeGreaterThan(0);
    // And the walk over the suites themselves saw a repository, not a mistyped
    // directory: thirty-four on 2026-09-01, and the floor is what stops this
    // from passing over three.
    expect(everySuite().length).toBeGreaterThan(30);
  });
});
