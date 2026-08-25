import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Has the full gate ever run over this commit, and over nothing since?
 *
 * `node tools/gate-receipt.mjs <commit>` -- exit 0 when a receipt covers it,
 * exit 1 with a sentence when none does. Called by `tools/pre-push.sh`, once per
 * ref being pushed.
 *
 * **What "covers" means, exactly.** A receipt from a FULL run, that PASSED, on a
 * CLEAN tree, whose head is THE COMMIT ITSELF. An ancestor will not do, and that
 * is the whole point: a receipt for a commit two back says nothing about the two
 * after it. A dirty tree will not do either, because "what was checked" cannot
 * then be named by a revision at all.
 *
 * A consequence worth saying out loud, because it decides the order of a day's
 * work: a receipt names a commit, so it can only be earned AFTER the commit
 * exists. Commit, then `pnpm run gate`, then push.
 *
 * **What this is not.** It is not evidence anybody else can use. The receipts
 * live in `.gate/`, which is untracked and per-machine, and they are written by
 * the run they vouch for. They answer "did the person about to push run the
 * gate", which is the question a hook can ask, and they cannot answer "was this
 * revision ever checked" for anyone else. Nothing here sees `--no-verify`.
 */

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const HISTORY = join(REPO, '.gate', 'receipts.ndjson');

function receipts() {
  if (!existsSync(HISTORY)) {
    return [];
  }
  return readFileSync(HISTORY, 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        // A half-written line is one interrupted run, not a reason to let a push
        // through and not a reason to stop reading the rest.
        return null;
      }
    })
    .filter((one) => one !== null);
}

/** The commit as git resolves it, so that a tag or `HEAD` answers the same as a sha. */
function resolve(named) {
  return execFileSync('git', ['rev-parse', named], { cwd: REPO, encoding: 'utf8' }).trim();
}

function main() {
  const named = process.argv[2];
  if (named === undefined) {
    console.error('usage: node tools/gate-receipt.mjs <commit>');
    process.exitCode = 2;
    return;
  }

  const commit = resolve(named);
  const covering = receipts().filter(
    (one) => one.level === 'full' && one.ok === true && one.revision?.head === commit && one.revision.dirty === false
  );

  if (covering.length === 0) {
    const full = receipts().filter((one) => one.level === 'full' && one.ok === true);
    const last = full.at(-1);
    console.error(
      `no full gate has passed over ${commit.slice(0, 12)} on a clean tree. ` +
        (last === undefined
          ? 'There is no passing full-gate receipt on this machine at all.'
          : `The last one was ${last.revision?.head?.slice(0, 12) ?? 'an unnamed revision'} at ${last.at}.`)
    );
    process.exitCode = 1;
    return;
  }

  console.log(`${commit.slice(0, 12)}: full gate passed at ${covering.at(-1).at}`);
}

main();
