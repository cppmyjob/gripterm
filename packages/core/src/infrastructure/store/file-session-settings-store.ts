import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { STORAGE_DIRECTORY_MODE } from './storage-layout';
import { StorageError } from '../../domain/errors/gripterm-error';
import type { SessionSettingsDocument } from '../../domain/agents/claude-code/session-settings-builder';
import type { StorageLayout } from './storage-layout';
import type { TerminalId } from '../../domain/entities/terminal-id';

/** Two spaces, because the single argument for a file over inline JSON is that a person can open it (§4.4). */
const JSON_INDENT = 2;

/**
 * Writes the `--settings` file of one session.
 *
 * The layout is passed in rather than built here: `~/.gripterm` is a user
 * setting (`gripterm.storage.path`), resolving `~` is the composition root's
 * business, and every path in the store is formed in one place so that two
 * spellings of the same file cannot drift apart. It also lets the tests address
 * a real directory of their own, which is the only way the three things this
 * class actually does -- create, replace, fail -- can be observed rather than
 * imagined.
 */
export class FileSessionSettingsStore {
  constructor(private readonly _layout: StorageLayout) {}

  /**
   * Replaces the file for `terminalId` and returns its absolute path, which is
   * what `--settings` is given.
   *
   * Content goes to a neighbour first and arrives by `rename`, so a reader
   * never sees a half-written file. The reader worth protecting is not the
   * launch we perform ourselves -- that one is sequenced after this call -- but
   * the CLI's own settings watcher, which fires `ConfigChange` and therefore
   * reads these files at moments we do not choose.
   *
   * Stated plainly, because it was measured rather than assumed: the SUITE DOES
   * NOT PROVE this. A truncation window is visible only to a concurrent reader,
   * and a single-process test has none; a mutation replacing the staged write
   * with a direct one survives the whole suite (probe of 2026-08-10, §8.2). The
   * staging is kept because it costs nothing and the hazard is real -- not
   * because anything here demonstrates it.
   */
  public async write(terminalId: TerminalId, document: SessionSettingsDocument): Promise<string> {
    const directory = this._layout.terminalDir(terminalId);
    const file = this._layout.settingsFile(terminalId);
    // The pid keeps two processes writing the same terminal off each other's
    // scratch file. They should not both be doing this -- one live owner per
    // record (§4.8) -- but a temporary is cheap insurance against a rule that
    // holds by design rather than by mechanism.
    const scratch = `${file}.${process.pid}.tmp`;

    try {
      await mkdir(directory, { recursive: true, mode: STORAGE_DIRECTORY_MODE });
      await writeFile(scratch, `${JSON.stringify(document, null, JSON_INDENT)}\n`, 'utf8');
      await rename(scratch, file);
      return file;
    } catch (cause: unknown) {
      await discard(scratch);
      throw new StorageError('could not write the session settings file', {
        cause,
        details: { path: file },
      });
    }
  }
}

async function discard(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch {
    // Deliberately swallowed. The write failure on its way out is the one worth
    // reporting; replacing it with the failure of its own cleanup would hand the
    // user the symptom of the symptom.
  }
}
