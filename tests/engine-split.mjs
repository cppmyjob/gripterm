import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * WHICH LIVE SUITE RUNS UNDER WHICH ENGINE, and why, one line per suite.
 *
 * **The state this replaced, and the owner's decision that ended it.** Until
 * 2026-09-01 `.vscode-test.mjs` gave the `integration` label the whole directory
 * as a glob and the `own` label the same directory minus six names. Twenty-eight
 * suites of thirty-four therefore ran TWICE -- once under the editor's engine,
 * which stopped being the manifest's default on 2026-08-30 -- and the second run
 * of most of them measured nothing the first had not. The owner's words that
 * day: concentrate every effort on the `own` mode. What is switched off here is
 * DUPLICATION and not coverage, and the three sets below are how the difference
 * is said out loud rather than assumed.
 *
 * **The editor engine is not retired and these sets say so.** It is the fallback
 * a person really gets: when the addon cannot be loaded the extension moves to
 * the editor's gateway and tells them (`ADDON_REFUSAL`,
 * `terminal-gateway-factory.ts`), which on Linux is every window there is. So
 * every suite whose SUBJECT is that engine still runs under it, and the one
 * suite that answers the two engines OPPOSITELY runs under both.
 *
 * **The criterion, in one sentence.** A suite belongs under both labels only
 * when the window's own `gripterm.terminal.engine` changes what it measures.
 * Most of these suites make their gateway themselves -- `makeGateway({setting:
 * 'own', ...})` is written into eight of them -- or make no terminal at all, and
 * for those the label is a name on a repeat.
 *
 * **Loadable, and that is a requirement rather than a property.** Nothing here
 * happens on import: no build is refused, no store is seeded, no profile is
 * written, no environment is read. `tests/live-runs-split-by-engine.test.ts`
 * loads this module in a `node` of its own and holds the division to being
 * declared, disjoint and total -- every compiled suite named by exactly one set,
 * so that none of them runs nowhere.
 */

/** Where the compiled suites are, worked out and not read. Nothing here touches the disk. */
const COMPILED = join(dirname(fileURLToPath(import.meta.url)), '..', 'out', 'tests', 'integration');

/**
 * The suites whose SUBJECT is the editor's engine, or the terminal's place among
 * the editors. They run under `integration` and nowhere else.
 *
 * This is the list M3.10 was given, unchanged and with its reasons unchanged:
 * the criterion was never "it passes under the editor", it was "the editor is
 * what it is about".
 */
export const EDITOR_SUBJECT = new Map([
  ['quiet-shell.test.js', 'its subject is `gripterm.launch.mode: shell`, which our own engine refuses outright (M2.25, `chooseEngine`)'],
  ['editor-strip.test.js', 'its subject is the terminal`s place in the editor area -- it reads `window.tabGroups`'],
  ['terminal-rename.test.js', 'its subject is the name on an editor terminal -- it reads `window.terminals`'],
  ['closing-a-terminal.test.js', 'its subject is what the EDITOR does to a record when its tab or its group is closed'],
  // The second sentence is new on 2026-09-01 and it is load-bearing. This suite
  // asserts `readiness.engine === 'editor'` twice, against a constant, so it is
  // where the `integration` label goes on measuring that the window really came
  // up on the engine its own launch arguments pinned -- the half of that claim
  // `pty-engine.test.js` used to make from inside the same run.
  ['tab-decoration.test.js', 'its subject is what is drawn on an EDITOR tab, and a terminal of our own has none; it is also where this label still measures that the window it opened is on the engine it asked for'],
  ['terminal-gateway.test.js', 'its subject is the editor`s gateway itself; the half that is common to both engines is `terminal-gateway-contract.test.js`'],
]);

/**
 * The suites that measure something DIFFERENT under each engine, and therefore
 * run under both labels.
 *
 * One member, and it is here by its own words rather than by a guess. Every
 * other suite either pins the engine it wants or never asks which engine it
 * got; this one branches on the answer.
 */
export const UNDER_BOTH_ENGINES = new Map([
  ['orphan-processes.test.js', 'the farewell branches on `readiness.engine` and asserts the OPPOSITE outcome on each side -- under `editor` a window leaving ends nothing (O5, M2.16), under `own` the pty goes with the window (P7) -- so a single run measures half of it'],
]);

/**
 * Everything else: suites whose measurement does not move with the window's
 * engine. They run under `own`, which is the engine the product defaults to.
 *
 * A reason at every name, and each one says HOW it was established -- what the
 * suite makes a terminal with, or that it makes none. "It does not depend on the
 * engine" repeated twenty-seven times would be a list nobody could audit.
 */
export const OWN_SUBJECT = new Map([
  ['activation.test.js', 'it asks the host whether the extension is there and one command is registered; no gateway is built, and the editor label still proves activation because every suite it runs activates in its own `api()`'],
  ['activation-restore.test.js', 'S01 through activation: what is under test is that the restore RAN before mocha loaded a file, and which gateway made the terminal afterwards changes nothing it asserts'],
  ['agent-listing.test.js', 'its subject is the real CLI answering `claude agents --json` against a captured scene, compared with what the same CLI answered on 2026-08-27; no terminal of ours is made at all'],
  ['attention.test.js', 'its subject is the manifest -- the commands a notification names and the states its settings enum offers -- and neither is reached through a gateway'],
  ['engine-fallback.test.js', 'O5, and it builds its own gateway with `setting: own` out of a directory that holds no addon; it never reads the window`s setting, so the label it runs under changes nothing it measures'],
  ['lifecycle.test.js', 'it reads the manifest`s menus and posts to our own receiver; `gripterm.newTerminal` is asserted to be REGISTERED and is never pressed, so no terminal is made'],
  ['owner-identity.test.js', 'its subject is what this editor calls itself and which process it is, both of them the host`s facts and not the gateway`s'],
  ['panel-behaviour.test.js', 'its subject is what the EDITOR does to our panel view; it drives a `vscode.window.createTerminal` probe of its own and asks the page, so our engine is not in the picture'],
  ['pty-engine.test.js', 'its subject is our own engine and every gateway in it is built by the suite; the one line that reads the window`s setting asserts "asked for X, got X", and the `editor` direction of that is measured in the editor run by `tab-decoration.test.js`'],
  ['reconcile.test.js', 'the sweep against a real `owners/` directory: it writes a presence file a dead window would have left and watches it go, starting no terminal'],
  ['restore.test.js', 'the `--resume` half, driven by hand; the line that compares the record`s engine with this window`s says in its own comment that its teeth are in the run under `own`'],
  ['resume-failed.test.js', 'the `resume_failed` branch, produced by an `--mcp-config` whose file is gone -- a refusal the CLI makes BEFORE a session exists, which is the same refusal whichever gateway holds the pty'],
  ['resume-never-spoken.test.js', 'the green button on a record nothing was said in; the answer is `planRestore``s and the seam is a command, a record and the real `claude agents --json` behind it'],
  ['settings-reload.test.js', 'it flips `terminal.engine` to whichever value the window is not on, and `reloadNotices` (`ui/reload-notice.ts`) keys on the section rather than on the direction -- so the second run was the same measurement written backwards'],
  ['shared-base.test.js', 'M2.5: a change another window makes to the shared store, arriving through a real recursive `fs.watch`; no terminal is made'],
  ['start-breakdown.test.js', 'the parts of a start, read out of the log file in the store; the list of parts is the composition root`s and names no engine'],
  ['tab-order.test.js', 'the order of the tabs over a terminal of OURS -- it makes its gateway with `setting: own`, so the editor run was measuring our engine anyway'],
  ['terminal-details.test.js', 'the details half of our own panel, on a gateway the suite makes with `setting: own`'],
  ['terminal-gateway-contract.test.js', 'ONE suite over BOTH engines, and it builds a gateway of each itself; it never reads the window`s setting, so running it a second time repeats it rather than widening it'],
  ['terminal-in-view.test.js', 'our own terminal on our own screen; the stand it attaches is made with `setting: own`, and the editor`s engine has no page for any of these numbers to come from'],
  ['terminal-keyboard.test.js', 'the keyboard of our own panel, on a stand made with `setting: own`; a terminal of the editor`s takes its keys from the editor'],
  ['terminal-strip.test.js', 'the strip of tabs over our own terminal, on a gateway made with `setting: own`'],
  ['transcript-index.test.js', 'where this machine keeps its conversations, asked through the core`s own reader; no editor and no terminal are involved beyond the host it happens to run in'],
  ['trash.test.js', 'what the trash holds, seen and brought back from the interface: a command, a picker and a store, none of which a gateway touches'],
  ['tree-drag.test.js', 'a row of the list dragged with the platform`s own drag and drop; the controller is handed nodes and a `DataTransfer`, never a terminal'],
  ['tree-view.test.js', 'the rows of the list and the buttons on them, drawn from records this window holds rather than from anything a gateway made'],
  ['workbench-view.test.js', 'the page: its own box, its own font and its own policy violations, all reported by the webview, which is ours under either engine and asks neither'],
]);

/** The three sets by the name of the set, in the order a reader meets them above. */
const SETS = new Map([
  ['editor-subject', EDITOR_SUBJECT],
  ['under-both-engines', UNDER_BOTH_ENGINES],
  ['own-subject', OWN_SUBJECT],
]);

/** Which sets each label runs. The middle one is in both, which is what it is for. */
const LABELS = new Map([
  ['integration', ['editor-subject', 'under-both-engines']],
  ['own', ['own-subject', 'under-both-engines']],
]);

/**
 * The compiled suites a label runs, as absolute paths.
 *
 * **Read from disk and checked BOTH WAYS**, which is the whole guard and the
 * reason this is a function rather than a constant. A name in a set that matches
 * no compiled suite is a rename that turned a decision into a decision about
 * nothing -- that half has thrown since M3.10. A compiled suite that no set
 * names is the newer failure and the one a glob could never have: a suite
 * written today, run by neither label, and green in the only sense that nothing
 * red is ever said about it.
 *
 * @param {string} label the runner label, `integration` or `own`
 * @returns {string[]} the compiled suites of that label, absolute and sorted
 */
export function suitesFor(label) {
  const sets = LABELS.get(label);
  if (sets === undefined) {
    throw new Error(`no engine split is declared for the label '${label}' -- it is ${[...LABELS.keys()].join(' or ')}`);
  }

  // A missing directory is a build that has not been run, and it is said in
  // those words: the alternative is an ENOENT stack over a path nobody
  // recognises.
  let compiled;
  try {
    compiled = readdirSync(COMPILED);
  } catch {
    throw new Error(`no compiled suites in ${COMPILED} -- run \`pnpm run build:integration\` first`);
  }
  const present = new Set(compiled.filter((name) => name.endsWith('.test.js')));

  for (const [set, members] of SETS) {
    for (const [name, why] of members) {
      if (!present.has(name)) {
        throw new Error(`the engine split puts '${name}' in ${set} (${why}), and there is no such compiled suite -- rename it in tests/engine-split.mjs or drop it`);
      }
    }
  }
  const named = new Set([...SETS.values()].flatMap((members) => [...members.keys()]));
  const nowhere = [...present].filter((name) => !named.has(name));
  if (nowhere.length > 0) {
    throw new Error(`${nowhere.join(', ')} is compiled and in no set of the engine split, so nothing runs it -- name it in tests/engine-split.mjs`);
  }

  return sets
    .flatMap((set) => [...(SETS.get(set)?.keys() ?? [])])
    .sort()
    .map((name) => join(COMPILED, name));
}
