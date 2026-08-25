import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';

/**
 * What is kept of a run that was not green, and what the next run is allowed to
 * take away.
 *
 * **The defect this exists for.** A run of the stand empties three directories
 * before it starts -- the editor's own user data, the store the product writes
 * in, and the output where the recording and the verdict land. That is right:
 * a run that inherited yesterday's records would judge terminals nobody made
 * today. But it means a red run can be taken apart only until the moment the
 * next one starts, and the next one always starts, because the first thing a
 * person does when they see red is run it again. On 2026-08-25 the full gate
 * went red on the stand and the agent sent to take that run apart could not:
 * it proved the mechanism on its own run, which is a different run.
 *
 * **After the verdict, not before.** `prepare()` runs before anything has a
 * colour, so nothing there can tell a run worth keeping from a run nobody will
 * read. The copying is therefore done at the END, by whoever knows the answer --
 * and a run that DIED before there was a verdict counts as red, because "no
 * verdict" must never read as "green".
 *
 * **The store the owner of this machine keeps their own terminals in is not
 * reachable from here.** Every path this copies from, writes into or deletes is
 * checked against the `.vscode-test` it was handed, by `under` below, and a path
 * that is not beneath it is a refusal rather than a copy. That is the same
 * refusal `prepare()` states in front of the store, spelled once here and asked
 * of every path any of this reads, writes or deletes -- the three a run empties,
 * the four it copies, the trace it writes and each trace the pruning takes away.
 */

/** What a run turned out to be, as far as keeping its trace is concerned. */
export type Outcome = 'green' | 'red' | 'died';

/** Where one run of the stand works. Handed in, never derived here: the runner already spells each of these once, and a second spelling of them is a second thing to drift. */
export interface RunPlaces {
  /** The `.vscode-test` all of the others are under, and the only tree this may touch. */
  readonly base: string;
  /** The editor's own directory for this run. Its `logs` hold `exthost.log`. */
  readonly userData: string;
  /** The store the product was pointed at. */
  readonly store: string;
  /** Where the recording and the verdict are written. */
  readonly output: string;
  /** Where the traces of runs that were not green are kept. */
  readonly keepsakes: string;
}

/** One thing copied out of a run, and the name it lands under inside the trace. */
export interface Copy {
  readonly from: string;
  readonly as: string;
}

/** What came of keeping one run's trace, for whoever has to print it. */
export interface KeptTrace {
  /** The directory the trace is in. Its name is the run. */
  readonly at: string;
  /** What was copied, by the name it landed under. */
  readonly copied: readonly string[];
  /** What the run never made, so there was nothing to copy. A run that died early has several. */
  readonly missing: readonly string[];
  /** This trace, in bytes. */
  readonly bytes: number;
  /** How many traces are kept now, this one included. */
  readonly traces: number;
  /** All of them together, in bytes -- the number the ceiling below is about. */
  readonly keptBytes: number;
  /** The traces this keeping took away, oldest first, by name. */
  readonly removed: readonly string[];
}

/**
 * How many traces are kept.
 *
 * Five, and the number is about READERS rather than about disk: nobody has ever
 * gone back more than two runs, and a run that is five red runs old is being
 * asked about because something is being bisected -- at which point the run is
 * repeated rather than remembered. Measured 2026-08-25: one trace of a full
 * four-sitting run is about 1.1 MB, of which a megabyte is the editor's logs, so
 * five is some 5.5 MB and the bound is on COUNT.
 *
 * **When that stops holding, and how it is noticed.** A bound on count is a
 * bound on bytes only while a trace stays small. It stops holding the day one
 * grows -- a bigger log, a scrollback kept in the store, a fifth thing added to
 * `whatIsCopied` -- and nothing about the count would say so. So the keeping
 * measures itself: `keptBytes` comes back from every keep, the runner prints it,
 * and above `LOUD_ABOVE_BYTES` it prints a line that says the ceiling has been
 * passed and names this constant. It is printed at the end of a RED run, which
 * is the one moment a person is certainly reading.
 */
export const KEPT_TRACES = 5;

/**
 * The total above which the keeping says out loud that a count of five has
 * stopped being a bound on bytes.
 *
 * Sixty-four megabytes: a dozen times the 5.5 MB five traces measured at, so
 * that it is not tripped by an editor writing a chattier log, and small beside
 * the neighbours it shares `.vscode-test` with -- four downloaded copies of VS
 * Code, hundreds of megabytes each. Between the two it means one thing: a trace
 * has grown by an order of magnitude and nobody decided that it should.
 *
 * The line it prints is not the only notice. `keptBytes` is printed on EVERY
 * keep, with the count beside it, so the growth is legible before it is loud.
 */
export const LOUD_ABOVE_BYTES = 64 * 1024 * 1024;

/** What is written into every trace, so that a directory found in three weeks says what it is. */
const MANIFEST = 'kept.json';

/**
 * A path this is allowed to touch, or a refusal.
 *
 * `startsWith` against the base plus a separator, and not against the base
 * alone: a directory BESIDE `.vscode-test` whose name merely begins with it
 * passes the bare form. The base must itself be a `.vscode-test`, so that a
 * caller cannot widen the whole rule by handing in a shorter path.
 */
function under(base: string, path: string): string {
  const root = resolve(base);
  if (basename(root) !== '.vscode-test') {
    throw new Error(
      `the trace of a run may only be kept under a .vscode-test, and ${root} is not one. ` +
        'Every path this deletes and copies is checked against that tree, and a wider one would widen all of them.'
    );
  }
  const wanted = resolve(path);
  if (wanted !== root && !wanted.startsWith(`${root}${sep}`)) {
    throw new Error(`${wanted} is not under ${root}, and the trace of a run is kept in our own tree or nowhere`);
  }
  return wanted;
}

/**
 * What a run empties before it starts -- and therefore exactly what the next run
 * takes away from this one.
 *
 * Named here rather than spelled inside `prepare()`, because two things have to
 * agree about the list: the run that deletes it and the check that a kept trace
 * survives it. A test that deleted its own imitation of this list would prove
 * something about the imitation.
 */
export function runDirectories(places: RunPlaces): readonly string[] {
  return [places.userData, places.store, places.output].map((one) => under(places.base, one));
}

/**
 * What is copied out of a run into its trace.
 *
 * Four things, and the list is an allow-list rather than a sweep, because the
 * user data directory is forty megabytes of caches around one megabyte of logs:
 *
 *   * `output` -- the recording and the verdict. The run, as it judged itself.
 *   * `store` -- the records the PRODUCT wrote, its own `logs` among them.
 *   * `editor-logs` -- the editor's `logs` tree, `exthost.log` included: what
 *     the extension host said while it was failing.
 *   * `settings.json` -- what the window was actually told. The runner's own
 *     error message names "the setting never reached the window" as one of two
 *     explanations for an empty store, and this is the file that decides which.
 *
 * **What is deliberately left behind.** `Cache`, `CachedData`, `GPUCache`,
 * `Crashpad` and the rest of the editor's caches: forty megabytes that say
 * nothing about a window's layout. `User/workspaceStorage`: the editor's memory
 * of the window IS the subject of the stand, but it is a SQLite file the size of
 * everything else here put together, and no reader of a trace has yet had a
 * question that only it answers. The project folder: it is made once and never
 * remade, so it is the same folder the next run has.
 */
export function whatIsCopied(places: RunPlaces): readonly Copy[] {
  return [
    { from: under(places.base, places.output), as: 'output' },
    { from: under(places.base, places.store), as: 'store' },
    { from: under(places.base, join(places.userData, 'logs')), as: 'editor-logs' },
    { from: under(places.base, join(places.userData, 'User', 'settings.json')), as: 'settings.json' },
  ];
}

/** Everything under a path, in bytes, whether it is one file or a tree. */
function bytesUnder(path: string): number {
  if (!existsSync(path)) {
    return 0;
  }
  const about = statSync(path);
  if (!about.isDirectory()) {
    return about.size;
  }
  return readdirSync(path).reduce((sum, entry) => sum + bytesUnder(join(path, entry)), 0);
}

/**
 * The name of one run's trace: when it started, and what became of it.
 *
 * The moment and not "last", because "last" is a name that two runs share and a
 * reader cannot tell apart. Colons come out of it -- a file system that has
 * directories has no colons in their names -- and what is left is fixed width,
 * so that sorting the names sorts the runs, which is what the pruning below
 * depends on.
 */
function nameOf(startedAt: Date, outcome: Outcome): string {
  return `${startedAt.toISOString().replace(/:/gu, '-')}-${outcome}`;
}

/** The traces kept right now, oldest first. */
function traceNames(keepsakes: string): readonly string[] {
  if (!existsSync(keepsakes)) {
    return [];
  }
  return readdirSync(keepsakes)
    .filter((entry) => statSync(join(keepsakes, entry)).isDirectory())
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Keep what is left of a run, if it was worth keeping.
 *
 * Green comes back as `null` and touches nothing -- not even the pruning: a
 * green run has no evidence of its own, and letting it take away the evidence of
 * a red one would put the deletion back exactly where this was written to remove
 * it from.
 */
export function keepRun(places: RunPlaces, outcome: Outcome, startedAt: Date): KeptTrace | null {
  // Both refusals are asked BEFORE the colour is looked at, so that a runner
  // pointed at the wrong tree is refused on its first green run rather than on
  // the first red one -- which is the run nobody wants to spend twice.
  const keepsakes = under(places.base, places.keepsakes);
  const copies = whatIsCopied(places);
  if (outcome === 'green') {
    return null;
  }

  const at = under(places.base, join(keepsakes, nameOf(startedAt, outcome)));
  mkdirSync(at, { recursive: true });

  const copied: string[] = [];
  const missing: string[] = [];
  for (const one of copies) {
    if (existsSync(one.from)) {
      cpSync(one.from, join(at, one.as), { recursive: true });
      copied.push(one.as);
    } else {
      missing.push(one.as);
    }
  }

  writeFileSync(
    join(at, MANIFEST),
    `${JSON.stringify(
      {
        what: 'one run of the two-sitting stand, kept because it was not green',
        outcome,
        startedAt: startedAt.toISOString(),
        keptAt: new Date().toISOString(),
        // Relative to `.vscode-test`, never absolute: a trace is a thing people
        // paste into reports, and the tree above it names whoever owns the
        // machine it was measured on.
        copied: copies
          .filter((one) => copied.includes(one.as))
          .map((one) => `${one.as} <- ${relative(resolve(places.base), one.from)}`),
        missing,
        notCopied: [
          'the editor caches beside its logs: some forty megabytes that say nothing about the layout of a window',
          'User/workspaceStorage: the editor memory of this window, a database as big as everything here put together',
          'the project folder: made once and never remade, so the next run has the same one',
        ],
      },
      null,
      2
    )}\n`,
    'utf8'
  );

  const removed: string[] = [];
  const held = traceNames(keepsakes);
  for (const old of held.slice(0, Math.max(0, held.length - KEPT_TRACES))) {
    rmSync(under(places.base, join(keepsakes, old)), { recursive: true, force: true });
    removed.push(old);
  }

  return {
    at,
    copied,
    missing,
    bytes: bytesUnder(at),
    traces: traceNames(keepsakes).length,
    keptBytes: bytesUnder(keepsakes),
    removed,
  };
}
