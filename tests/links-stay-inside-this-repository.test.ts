import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * A link written in this repository points at something this repository has.
 *
 * **The defect this exists for, found 2026-08-27.** `spikes/panel-keys/README.md`
 * opened with `[14-m3-plan.md](../../../docs/14-m3-plan.md)`. On the machine it
 * was written on that path resolves, because the two repositories sit side by
 * side under one directory. On GitHub it resolves nowhere: `source` is PUBLIC
 * and the document is in a PRIVATE repository, so the link is dead for every
 * reader who is not the owner.
 *
 * **Why the obvious repair is the wrong one.** The register of open questions
 * had this down as a typo -- `../../../doc/docs/...` rather than
 * `../../../docs/...` -- and that repair makes the link work on the owner's
 * disk and nowhere else, while ALSO publishing the private repository's
 * directory layout to everybody who reads the public one. A dead link that
 * leaks is worse than a dead link.
 *
 * So the answer is to name the document and not link to it, which is what the
 * rest of this repository already does: nine places name a file under
 * `docs/experiments/` in prose and none of them links to one.
 *
 * **What this therefore checks, and what it deliberately does not.** It checks
 * LINKS -- a markdown target that leaves the repository root, or an absolute
 * path on somebody's disk. It does NOT check prose: naming a document a reader
 * cannot open is how this repository refers to its own design notes, on purpose,
 * and a rule against the words would forbid the practice along with the defect.
 *
 * The rule is about the repository ROOT and not about the file it is written in:
 * a relative link may climb as far as it likes as long as it lands inside.
 */

const REPO = resolve(__dirname, '..');

/** Where a link can be written. Only the files a reader of this repository is offered. */
const SCANNED = '.md';

/**
 * An inline markdown link's target, and only the target.
 *
 * Reference definitions (`[label]: path`) are matched by the second pattern
 * rather than folded into this one: one expression that tried to be both would
 * be the kind of regexp nobody can read, and the two shapes are genuinely
 * different syntax.
 */
const INLINE = /\[[^\]]*\]\(([^)\s]+)/gu;
const REFERENCE = /^\s{0,3}\[[^\]]+\]:\s*(\S+)/gmu;

/** A path that is nobody's but the machine it was written on. */
const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\/|\\\\)/u;

/**
 * Every file this repository keeps, as paths relative to its root.
 *
 * `--cached --others --exclude-standard` is "tracked, plus untracked, minus
 * ignored" -- the set a `git add -A` would end up with, which is the set a
 * reader of this repository can reach. The same question
 * `named-tests-exist.test.ts` asks git, and asked of git for the same reason: a
 * second list of directories to skip would drift from `.gitignore`.
 */
function filesOfTheRepository(): readonly string[] {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter((line) => line.length > 0 && line.endsWith(SCANNED));
}

/** Every link target written in one file, both syntaxes. */
function targetsIn(text: string): readonly string[] {
  const found: string[] = [];
  for (const pattern of [INLINE, REFERENCE]) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match !== null) {
      const target = match[1];
      if (target !== undefined) {
        found.push(target);
      }
      match = pattern.exec(text);
    }
  }
  return found;
}

/**
 * Whether a target is one this repository can answer for.
 *
 * A URL, an anchor and a mail address are somebody else's business and are left
 * alone: this rule is about paths, and about one property of them.
 */
function leavesTheRepository(from: string, target: string): boolean {
  if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/iu.test(target)) {
    return ABSOLUTE.test(target);
  }
  if (ABSOLUTE.test(target)) {
    return true;
  }
  const landed = resolve(dirname(join(REPO, from)), target.split('#')[0] ?? target);
  return !landed.startsWith(REPO);
}

/** Every link that lands outside, said with the file it was written in. */
function linksThatEscape(files: readonly string[]): readonly string[] {
  const found: string[] = [];
  for (const path of files) {
    const text = readFileSync(join(REPO, path), 'utf8');
    for (const target of targetsIn(text)) {
      if (leavesTheRepository(path, target)) {
        found.push(`${path}: ${target}`);
      }
    }
  }
  return found;
}

describe('a link written in this public repository', () => {
  it('lands inside it, because a reader of it has nothing else', () => {
    expect(linksThatEscape(filesOfTheRepository())).toStrictEqual([]);
  });

  it('is looked for over a listing that really found the documents', () => {
    // Both the rule above and this one are `[] === []` when the listing breaks,
    // and a broken listing is silent -- the failure `named-tests-exist.test.ts`
    // was bitten by and guards against in the same words.
    const files = filesOfTheRepository();
    expect(files.length).toBeGreaterThan(1);
    expect(files).toContain('README.md');
  });

  it('is told apart from a link that merely climbs, so the rule is about the root and not the file', () => {
    // `spikes/panel-keys/README.md` may climb two levels and point at the root
    // README; the same file may not climb three. Held here rather than trusted,
    // because the whole rule is one `startsWith`.
    expect(leavesTheRepository('spikes/panel-keys/README.md', '../../README.md')).toBe(false);
    expect(leavesTheRepository('spikes/panel-keys/README.md', '../../../docs/14-m3-plan.md')).toBe(true);
    expect(leavesTheRepository('README.md', 'https://example.invalid/x')).toBe(false);
    expect(leavesTheRepository('README.md', 'D:/Projects/Gripterm/doc/x.md')).toBe(true);
  });

  it('points at a file that is really there, when it points at a file at all', () => {
    // The other half of a dead link, and the cheaper half: a target inside the
    // repository can simply be looked for. Anchors are cut off first -- a
    // heading this cannot check is not the same defect.
    const missing: string[] = [];
    for (const path of filesOfTheRepository()) {
      const text = readFileSync(join(REPO, path), 'utf8');
      for (const target of targetsIn(text)) {
        if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/iu.test(target) || leavesTheRepository(path, target)) {
          continue;
        }
        const landed = resolve(dirname(join(REPO, path)), target.split('#')[0] ?? target);
        if (!existsSync(landed)) {
          missing.push(`${path}: ${target}`);
        }
      }
    }
    expect(missing).toStrictEqual([]);
  });
});
