import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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
 * The store is created and never emptied. Emptying it would put a recursive
 * delete into the very files this change exists to keep away from a person's
 * directories, and dirt is something the suites already tolerate: until today
 * they ran against a store with months of the owner's own batches in it.
 *
 * @param {string} label distinguishes one run's directories from another's
 * @param {Record<string, unknown>} [settings] anything else the window must read
 * @returns {string} the path to pass as `--user-data-dir`
 */
export function hostUserData(label, settings = {}) {
  const directory = join(ROOT, '.vscode-test', `user-data-${label}`);
  const store = join(ROOT, '.vscode-test', `store-${label}`);
  mkdirSync(join(directory, 'User'), { recursive: true });
  mkdirSync(store, { recursive: true });
  writeFileSync(
    join(directory, 'User', 'settings.json'),
    `${JSON.stringify({ 'gripterm.storage.path': store, ...settings }, null, 2)}\n`,
    'utf8'
  );
  return directory;
}
