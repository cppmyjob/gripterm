import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

/**
 * That nothing under `tests/stand/` names the machine it was measured on, or
 * the person who owns that machine.
 *
 * This suite exists because of what a fixture IS. Everything else here is
 * written by a person and read by a reviewer; a recording is written by a
 * PROGRAM, on somebody's own desktop, out of the paths and the names that
 * desktop happens to have -- and it is then committed verbatim, because the
 * whole of its worth is that it was not invented.
 * `staircase-2026-08-23.ndjson` named its editor by the full path the .exe was
 * installed under -- a path that ran through the home directory of the person
 * who measured it -- and it did that in a repository that may be published.
 * Publishing is in the class of acts that no later commit takes back.
 *
 * So this is not a sweep of the three files that exist today. The stand is an
 * instrument somebody will run again, and the run after this one writes a NEW
 * recording out of the same paths. A sweep protects the files it was pointed
 * at; this protects the next one too.
 *
 * **A recording is a measurement, and a measurement is its numbers.** Nothing
 * below asks a fixture to say less about the window it saw. It asks the editor
 * to be named by its basename rather than by where it is installed, and a
 * folder by its place in the tree rather than by whose home the tree sits in.
 * Neither of those is a fact about the layout of a window.
 *
 * **What this cannot do.** It knows the SHAPES a machine's own names come in,
 * plus whatever the machine running it calls itself. A recording holding a name
 * that is neither -- a person in a tab label, a project named after its owner
 * -- goes through. The reviewer is still the last check; this is the floor
 * under them.
 */

const STAND = __dirname;

/**
 * The one file left out, and it is this one: a suite that refuses a pattern has
 * to be able to write the pattern down.
 */
const ITSELF = basename(__filename);

/** What a machine's own names look like, wherever they were written. */
interface Shape {
  readonly named: string;
  readonly looks: RegExp;
}

const SHAPES: readonly Shape[] = [
  {
    named: 'a drive-letter path',
    // A LONE letter before the colon, so that `file:` and `https:` are not read
    // as drives -- and `Canceled: Canceled`, which the editor really does say
    // into a recording, has no separator after its colon and is not one either.
    looks: /(?:^|[^A-Za-z])[A-Za-z]:[\\/]/u,
  },
  { named: 'a home directory', looks: /[\\/](?:Users|home)[\\/]/iu },
  {
    named: 'an AppData directory',
    // Between separators on purpose. `process.env.LOCALAPPDATA` is how `run.mjs`
    // finds an editor without writing anybody's path down, and a rule that read
    // the env var's NAME as a leak would be a rule people turn off.
    looks: /[\\/]AppData[\\/]/iu,
  },
  { named: 'a percent-encoded drive letter', looks: /(?:^|[^A-Za-z])[A-Za-z]%3[Aa]/u },
  { named: 'the assistant\'s own directory', looks: /\.claude[\\/]/iu },
  { named: 'a session directory named after a machine\'s path', looks: /claude[\\/][A-Z]--/iu },
  {
    named: 'the owner\'s real store',
    // `~/.gripterm` and no other spelling of it: the product's own identity ends
    // in `.gripterm` too, and the stand's observer holds that identity as a
    // string it matches the product by.
    looks: /[~\\/]\.gripterm\b/u,
  },
];

interface StandFile {
  readonly path: string;
  readonly text: string;
}

/** Every file of the stand, this one excepted, with what it holds. */
function stand(): readonly StandFile[] {
  const found: StandFile[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        if (entry !== 'node_modules') {
          walk(path);
        }
      } else if (entry !== ITSELF) {
        found.push({ path, text: readFileSync(path, 'utf8') });
      }
    }
  };
  walk(STAND);
  return found;
}

/** Where a pattern is, said the way a person fixes it: the file, the line, the line. */
function hits(files: readonly StandFile[], guilty: (line: string) => boolean): readonly string[] {
  return files.flatMap((one) =>
    one.text
      .split(/\r?\n/u)
      .map((body, at) => ({ line: at + 1, body }))
      .filter((where) => guilty(where.body))
      .map(
        (where) =>
          `${relative(STAND, one.path)}:${String(where.line)}: ${where.body.trim().slice(0, 200)}`
      )
  );
}

describe('nothing under tests/stand names the machine it was measured on', () => {
  const files = stand();

  test('there are files to check at all', () => {
    // A walk that finds nothing passes every assertion below it, and reports
    // green about a directory it never opened.
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((one) => one.path.endsWith('.ndjson')).length).toBeGreaterThan(0);
  });

  test.each(SHAPES)('no file holds $named', ({ looks }) => {
    expect(hits(files, (line) => looks.test(line))).toEqual([]);
  });

  /*
   * The one check that is about THIS machine rather than about the shape of
   * machines in general, and the only one that can catch a bare name -- a
   * computer's, a person's -- standing in a recording with no path around it.
   *
   * It is honest wherever it runs: a recording is taken on somebody's desktop,
   * and this asks whether the desktop reading it back left its name inside.
   * Four characters is the floor, so that a login called `pt` cannot make every
   * file in the directory guilty of holding two letters.
   */
  test('no file holds a name the machine running this calls itself by', () => {
    const own = [process.env.USERNAME, process.env.COMPUTERNAME, basename(process.env.USERPROFILE ?? '')]
      .filter((one): one is string => one !== undefined && one.length >= 4)
      // Plus the short form Windows makes of a long login -- `alexander`
      // becomes `ALEXAN~1` -- which is the same name and shares nothing with
      // the long one past its sixth letter. The example is invented, and that
      // is deliberate: this file is the one the walk above skips, so a real
      // login written here is the one leak nothing in the repository catches.
      .flatMap((one) => (one.length > 8 ? [one, `${one.slice(0, 6)}~1`] : [one]))
      .map((one) => one.toLowerCase());
    const named = [...new Set(own)];
    // Plain containment and not a pattern: a login may hold any of the
    // characters a regular expression reads as syntax, and an escape missed
    // here is a check that passes because it never ran.
    expect(hits(files, (line) => named.some((one) => line.toLowerCase().includes(one)))).toEqual([]);
  });
});
