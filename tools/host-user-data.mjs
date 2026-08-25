import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Where a run keeps its records, by label.
 *
 * Named here and not spelled twice, because two things now have to agree about
 * it: the settings a window is handed, and the seed laid in that store before
 * the window opens (`tools/seed-restorable-record.mjs`). A seed in one directory
 * and a window pointed at another is a run that silently proves nothing.
 *
 * @param {string} label distinguishes one run's directories from another's
 * @returns {string} the directory `gripterm.storage.path` will name
 */
export function runStore(label) {
  return join(ROOT, '.vscode-test', `store-${label}`);
}

/**
 * A user data directory of the run's own, with a store of the run's own in it.
 *
 * Every window we start ourselves gets one. Without it the extension host reads
 * the settings of whoever is sitting at this machine and, finding no
 * `gripterm.storage.path`, opens `~/.gripterm` -- the store their real
 * terminals, their real conversations and their real trash live in. A suite
 * that runs there does not merely read: it announces a window, seeds records,
 * starts `claude`, and sweeps. None of that can be taken back by a later
 * assertion, which is why the store is moved rather than the behaviour
 * suppressed, and why the extension now refuses a store it was not pointed at.
 *
 * The store is created here and NOT emptied here, which is a smaller claim than
 * the one this comment used to make. It said the store was "never emptied",
 * because a recursive delete would then have stood in front of the very files
 * this exists to keep away from a person's directories; and `tests/stand/run.mjs`
 * has emptied it on every run since, with `rmSync(STORE, { recursive: true })`.
 * The danger was answered another way, and this comment went on asserting a
 * decision nobody was keeping. The other way is a REFUSAL in front of the
 * delete: `prepare()` there, and `under()` in `tests/stand/keepsake.ts`, both
 * stop a run whose store is not beneath `.vscode-test`, so the recursion cannot
 * reach a directory of anybody's. Dirt is separately tolerable -- until the day
 * the store moved here, the suites ran against one with months of the owner's
 * own batches in it -- but it is not what keeps the delete safe.
 *
 * @param {string} label distinguishes one run's directories from another's
 * @param {Record<string, unknown>} [settings] anything else the window must read
 * @returns {string} the path to pass as `--user-data-dir`
 */
export function hostUserData(label, settings = {}) {
  const directory = join(ROOT, '.vscode-test', `user-data-${label}`);
  const store = runStore(label);
  mkdirSync(join(directory, 'User'), { recursive: true });
  mkdirSync(store, { recursive: true });
  writeFileSync(
    join(directory, 'User', 'settings.json'),
    `${JSON.stringify({ 'gripterm.storage.path': store, ...settings }, null, 2)}\n`,
    'utf8'
  );
  return directory;
}
