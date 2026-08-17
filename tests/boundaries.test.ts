import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * The architectural boundaries, asked of the linter rather than of the reader.
 *
 * Two of them, and both are one-way: the domain must not know the editor exists
 * (`vscode`), and nothing outside `packages/extension/src/adapters/` may know
 * that a native pty addon exists (`node-pty`, M3.3 / §4.2).
 *
 * A rule nobody exercises is a rule that can stop working silently, and this one
 * has a specific way of doing it that `eslint.config.mjs` warns about in prose:
 * **a later config object REPLACES the options of the same rule instead of
 * merging with them.** Adding `node-pty` to the wide block and forgetting to
 * repeat it in the two narrow ones would switch the native boundary off for
 * exactly the package it exists for; writing the narrow lists out afresh and
 * leaving `vscode` out of one would do the same to the older boundary. Neither
 * mistake changes anything a normal test can see, and both are one forgotten
 * line.
 *
 * The plants are TEXT, not files. Each one is linted under the path of a file
 * that really exists -- the path is what selects the config -- while its own
 * content is never read. Nothing is written to the source tree, so a run that
 * dies halfway cannot leave the repository unbuildable.
 *
 * What this cannot catch, said here rather than found out later: the rule reads
 * IMPORTS. The adapter of M3.4 loads the addon through a lazy `require` with a
 * computed path, deliberately -- a static import would make a missing addon the
 * failure of the whole extension instead of a fallback to the `editor` engine
 * (O5) -- and a computed `require` anywhere else would pass every rule here in
 * silence. Review is the only thing that sees that.
 */

const REPO_ROOT = path.resolve(__dirname, '..');
const RUNNER = path.join(__dirname, 'helpers', 'lint-plants.mjs');

/** ESLint builds the type-aware program for the whole workspace first: seconds, not milliseconds. */
const LINT_TIMEOUT_MS = 180_000;

const IMPORTS_NODE_PTY = 'import * as pty from \'node-pty\';\n\nexport const spawn = pty.spawn;\n';
const IMPORTS_VSCODE = 'import * as vscode from \'vscode\';\n\nexport const shell = vscode.env.shell;\n';

/** Only the path of each file matters. Its real content is replaced by the plant. */
const CORE_ENTRY = 'packages/core/src/index.ts';
const CORE_DOMAIN = 'packages/core/src/domain/services/terminal-exit-verdict.ts';
const ADAPTER = 'packages/extension/src/adapters/vscode-terminal-gateway.ts';
const COMPOSITION = 'packages/extension/src/extension.ts';

const PLANTS = [
  { name: 'node-pty in the core entry point', filePath: CORE_ENTRY, source: IMPORTS_NODE_PTY },
  { name: 'node-pty in the domain', filePath: CORE_DOMAIN, source: IMPORTS_NODE_PTY },
  { name: 'node-pty in the composition root', filePath: COMPOSITION, source: IMPORTS_NODE_PTY },
  { name: 'node-pty in the adapters', filePath: ADAPTER, source: IMPORTS_NODE_PTY },
  { name: 'vscode in the core entry point', filePath: CORE_ENTRY, source: IMPORTS_VSCODE },
  { name: 'vscode in the domain', filePath: CORE_DOMAIN, source: IMPORTS_VSCODE },
] as const;

type PlantName = (typeof PLANTS)[number]['name'];

let refusals: ReadonlyMap<PlantName, readonly string[]>;

beforeAll(() => {
  const printed = execFileSync(process.execPath, [RUNNER], {
    cwd: REPO_ROOT,
    input: JSON.stringify(PLANTS.map(({ filePath, source }) => ({ filePath, source }))),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const answers = JSON.parse(printed) as string[][];
  refusals = new Map(PLANTS.map((plant, index) => [plant.name, answers[index] ?? []]));
}, LINT_TIMEOUT_MS);

function refusalsFor(name: PlantName): readonly string[] {
  return refusals.get(name) ?? [];
}

describe('the linter refuses node-pty outside the adapters', () => {
  it('refuses it in the core entry point', () => {
    expect(refusalsFor('node-pty in the core entry point')).toHaveLength(1);
  });

  it('refuses it in the domain, where the options of the rule are replaced', () => {
    expect(refusalsFor('node-pty in the domain')).toStrictEqual([
      '\'node-pty\' import is restricted from being used by a pattern. node-pty belongs to packages/extension/src/adapters and nowhere else',
    ]);
  });

  it('refuses it in the composition root, which is not an adapter', () => {
    // The place it would most plausibly be typed, since the root is where the
    // engine gets chosen -- and the place where a static import would take the
    // rollback down together with the addon (O5).
    expect(refusalsFor('node-pty in the composition root')).toHaveLength(1);
  });

  it('allows it in the adapters, which is the one place it belongs', () => {
    // Without this row the suite would pass just as well on a rule that refuses
    // node-pty everywhere, which is a repository that cannot spawn a terminal.
    expect(refusalsFor('node-pty in the adapters')).toStrictEqual([]);
  });
});

describe('the linter still refuses the editor API in the core', () => {
  it('refuses vscode in the core entry point', () => {
    expect(refusalsFor('vscode in the core entry point')).toHaveLength(1);
  });

  it('refuses vscode in the domain, where the options of the rule are replaced', () => {
    // The older boundary, re-asked because the newer one shares its rule. This
    // is the assertion that goes red if a `patterns` list is written out afresh
    // in a later block and this entry is left out of it.
    expect(refusalsFor('vscode in the domain')).toStrictEqual([
      '\'vscode\' import is restricted from being used by a pattern. core must not depend on the editor API',
    ]);
  });
});
