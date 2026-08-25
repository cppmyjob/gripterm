import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

/**
 * A suite named in a comment is a suite on disk.
 *
 * The defect this exists for, found 2026-08-25 while building the gate:
 * `tests/acceptance/p2-first-window.test.ts` explained that the second sitting
 * comes in two forms and named a file for one of them, and that file had never
 * been written. Nothing said so. The comment was the only place that suite
 * existed, and a reader deciding what П2 was covered by would have counted it.
 *
 * Correcting that one comment would have closed the instance and left the class
 * open, so this asks the question instead of answering it once: every
 * `*.test.ts` and `*.test.mjs` NAMED anywhere in this repository's own code
 * must be a file that exists. It costs one `git ls-files` and no editor.
 *
 * **Which files are this repository's own.** The ones git keeps or would keep,
 * asked of git rather than spelled out here as a list of directories to skip.
 * The repository already states that rule once, in `.gitignore`, and a second
 * copy of it in this file would drift from the first. It matters:
 * `packages/extension/assets/node-pty/lib` is fourteen JavaScript files copied
 * out of `node_modules` by every build, and a suite name inside somebody else's
 * bundle is not a promise anybody here made. Untracked files ARE included --
 * a name written into a file nobody has committed yet is exactly the case this
 * was written for.
 *
 * **What it deliberately does not do.** It does not ask WHERE a suite is, only
 * that one of that name exists somewhere under `tests/`: suites move between
 * directories, and a rule about their addresses would be a second spelling of
 * the tree. It does not read only comments either -- a name in a string literal
 * that points at nothing is the same defect, and telling code from comment
 * would need a parser for four languages in order to catch less.
 */

const REPO = resolve(__dirname, '..');

/** Where a name can be written down. Data files are not read: a name in one is a path, not a claim. */
const SCANNED = /\.(?:ts|js|mjs|cjs)$/u;

/**
 * A suite name as it is written in prose or in a path.
 *
 * The leading word character is what keeps a glob out of the answer: the jest
 * config and three tsconfigs all carry patterns ending in the same eight
 * characters, and in every one of them the character before is `*`.
 */
const NAMED = /[A-Za-z0-9][\w.-]*\.test\.(?:ts|mjs)/gu;

/**
 * Every file this repository keeps, as paths relative to its root.
 *
 * `--cached --others --exclude-standard` is "tracked, plus untracked, minus
 * ignored" -- the set a `git add -A` would end up with. `-z` because a path
 * with a space or a non-ASCII character in it is quoted by the plain output and
 * would come back as a name no `readFileSync` could open.
 */
function filesOfTheRepository(): readonly string[] {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter((line) => line.length > 0);
}

/** Every suite that exists, by the name a comment would call it. */
function suitesOnDisk(files: readonly string[]): ReadonlySet<string> {
  return new Set(
    files
      .filter((path) => path.startsWith('tests/') && /\.test\.(?:ts|mjs)$/u.test(path))
      .map((path) => basename(path))
  );
}

/** Every suite anything of ours names, and where it names it. */
function suitesNamed(files: readonly string[]): ReadonlyMap<string, readonly string[]> {
  const found = new Map<string, string[]>();
  for (const path of files.filter((one) => SCANNED.test(one))) {
    for (const [name] of readFileSync(join(REPO, path), 'utf8').matchAll(NAMED)) {
      const where = found.get(name) ?? [];
      if (!where.includes(path)) {
        where.push(path);
      }
      found.set(name, where);
    }
  }
  return found;
}

describe('a suite named in this repository', () => {
  it('is a suite that exists', () => {
    const files = filesOfTheRepository();
    const onDisk = suitesOnDisk(files);
    const missing = [...suitesNamed(files)]
      .filter(([name]) => !onDisk.has(name))
      .map(([name, where]) => `${name}, named in ${where.join(', ')}`);

    expect(missing).toStrictEqual([]);
  });

  it('is looked for at all, so that a walk which found nothing cannot pass', () => {
    // The refusal above is `[] === []` when the listing is broken, and a broken
    // listing is silent. This one says the listing saw the repository.
    const files = filesOfTheRepository();

    expect(suitesOnDisk(files).size).toBeGreaterThan(100);
    expect(suitesNamed(files).size).toBeGreaterThan(0);
  });
});
