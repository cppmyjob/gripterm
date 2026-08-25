import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every label the runner config declares is named by a script, and every label
 * a script names is declared.
 *
 * **The defect this exists for is one this step introduced.** Until 2026-08-25
 * `pnpm test:integration` was a bare `vscode-test`, which runs EVERY label in
 * `.vscode-test.mjs`, and there was nothing to drift: a new label ran the day it
 * was written. Ш9 added a third label -- `cursor` -- which must NOT join the
 * live suites, because it runs in a different editor, takes a different amount
 * of time and is judged by a file rather than by an exit code. So the two live
 * labels are now named explicitly, and the moment they are named explicitly a
 * fourth label can be written that nothing ever runs. It would look exactly like
 * coverage in a diff and be none.
 *
 * **Both directions**, because they rot differently. A label nobody runs is a
 * suite that silently stops existing. A script naming a label that is not there
 * is a command that runs NOTHING and exits 0 -- `vscode-test --label typo`
 * matches no configuration, and a gate stage over it would be green about an
 * empty set.
 *
 * **Read as TEXT, and that is deliberate.** `.vscode-test.mjs` is not imported
 * here and must not be: importing it runs `refuseStaleBuilds()`, seeds a
 * restorable record into two stores and reads the editor's `product.json`, none
 * of which belongs in a Jest run that is supposed to need no build and no
 * editor. What is checked is the shape of a line -- `label: 'name'` -- which is
 * crude, and crude in the safe direction: a label written some other way is not
 * seen here, and a label seen here is really there.
 */

const REPO = join(__dirname, '..', '..');

/** `label: 'integration'` and nothing cleverer. */
const DECLARED = /^\s*label:\s*'([\w-]+)'/gmu;

/** `--label integration`, as a script spells it. */
const NAMED = /--label\s+([\w-]+)/gu;

function labelsInTheConfig(): readonly string[] {
  const text = readFileSync(join(REPO, '.vscode-test.mjs'), 'utf8');
  return [...text.matchAll(DECLARED)].map((found) => found[1] ?? '');
}

function labelsTheScriptsName(): ReadonlyMap<string, readonly string[]> {
  const manifest = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const named = new Map<string, string[]>();
  for (const [script, body] of Object.entries(manifest.scripts ?? {})) {
    for (const found of body.matchAll(NAMED)) {
      const label = found[1] ?? '';
      named.set(label, [...(named.get(label) ?? []), script]);
    }
  }
  return named;
}

describe('the labels of the runner config', () => {
  it('are each named by at least one script, so that none of them is a suite nobody runs', () => {
    const named = labelsTheScriptsName();
    const unrun = labelsInTheConfig().filter((label) => !named.has(label));

    expect(unrun).toStrictEqual([]);
  });

  it('are each really there, so that no script is a command over an empty set', () => {
    const declared = new Set(labelsInTheConfig());
    const missing = [...labelsTheScriptsName()]
      .filter(([label]) => !declared.has(label))
      .map(([label, scripts]) => `${label} (named by ${scripts.join(', ')})`);

    expect(missing).toStrictEqual([]);
  });

  /*
   * That the two readers above see anything at all. Without this, a regular
   * expression that matched nothing would make both assertions above pass over
   * empty lists for ever -- the classic way a guard stops guarding, and one this
   * repository has already been bitten by (`named-tests-exist.test.ts` exists
   * because a name in a comment was the only place a suite existed).
   */
  it('are found by both readers, so that neither assertion above is about an empty list', () => {
    expect(labelsInTheConfig().length).toBeGreaterThanOrEqual(2);
    expect(labelsTheScriptsName().size).toBeGreaterThanOrEqual(2);
  });
});
