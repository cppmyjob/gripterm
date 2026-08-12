import { mkdir, readFile, readdir } from 'node:fs/promises';
import { STORAGE_DIRECTORY_MODE, STORAGE_SCHEMA_VERSION } from './storage-layout';
import { writeAtomic } from './atomic-file';
import type { StorageLayout } from './storage-layout';

/** Decimal digits and nothing else, so that a truncated write cannot read as a number. */
const VERSION_TEXT = /^\d+$/;

const FIRST_VERSION = 1;

/**
 * Where the directory came from, for the log line at activation.
 *
 * `adopted` is the interesting one: a store that already holds terminals but
 * carries no marker was left by a build from before markers existed -- M1 wrote
 * `terminals/<id>/settings.json` and nothing else -- and completing it is the
 * whole point of this class. Refusing it instead would strand every terminal
 * that build had made.
 */
export type StorageOrigin = 'created' | 'adopted' | 'existing';

export type StoragePreparation =
  | { readonly kind: 'ready', readonly version: number, readonly origin: StorageOrigin }
  | { readonly kind: 'refused', readonly reason: string };

/**
 * Makes the directory fit to read, or says why it is not.
 *
 * It refuses rather than throws for the same reason `launchReadiness` does: the
 * composition root gets one branch, and a refusal is a state the extension can
 * run in -- observing nothing, saying so out loud -- instead of an activation
 * that fails with a stack trace.
 *
 * What it deliberately does NOT do is convert records. There is one version, so
 * there is no upgrade path to write, and a framework of zero migrations would
 * be code no test could make fail. Version two brings its own step, with its
 * own test, and the refusal below is what protects the interval: a store from a
 * newer build is left alone, because reading a newer record with older rules
 * loses the record, while refusing costs one session.
 *
 * Two windows arriving together are safe by construction rather than by a lock:
 * the marker is written whole, by `rename`, so a reader has either no file or a
 * complete one, and every build writes only its OWN version -- so the loser of
 * the race reads a valid number either way. The one interval not covered is a
 * newer build writing its marker between this one's read and its rename, on a
 * store that is being created at that very moment. It is left uncovered
 * knowingly: in that window the store is empty by definition -- we only write
 * when the read found nothing -- so there is no record to be misread, and the
 * next activation reads the real number.
 */
export class StorageMigrator {
  constructor(private readonly _layout: StorageLayout) {}

  public async prepare(): Promise<StoragePreparation> {
    try {
      const inhabited = await this._hasTerminals();
      await this._makeSkeleton();

      const existing = await this._readVersion();
      if (existing !== null) {
        return verdictFor(existing, 'existing');
      }

      await writeAtomic(this._layout.versionFile, `${STORAGE_SCHEMA_VERSION}\n`);
      return {
        kind: 'ready',
        version: STORAGE_SCHEMA_VERSION,
        origin: inhabited ? 'adopted' : 'created',
      };
    } catch (cause: unknown) {
      return { kind: 'refused', reason: `the storage directory could not be prepared: ${String(cause)}` };
    }
  }

  /**
   * Asked BEFORE anything is created, which is the only moment the answer means
   * "an earlier build was here" rather than "we just made this".
   */
  private async _hasTerminals(): Promise<boolean> {
    try {
      const entries = await readdir(this._layout.terminalsDir);
      return entries.length > 0;
    } catch {
      // Absent, or unreadable. Either way there is nothing to adopt, and a real
      // permission problem surfaces at the very next line, where it can be
      // reported with the operation that actually needed the directory.
      return false;
    }
  }

  private async _makeSkeleton(): Promise<void> {
    const options = { recursive: true, mode: STORAGE_DIRECTORY_MODE } as const;
    await mkdir(this._layout.baseDir, options);
    await mkdir(this._layout.ownersDir, options);
    await mkdir(this._layout.terminalsDir, options);
  }

  /** `null` when there is no marker; throws only on a real read failure. */
  private async _readVersion(): Promise<string | null> {
    try {
      return await readFile(this._layout.versionFile, 'utf8');
    } catch (cause: unknown) {
      if (isMissing(cause)) {
        return null;
      }
      throw cause;
    }
  }

}

function verdictFor(raw: string, origin: StorageOrigin): StoragePreparation {
  const text = raw.trim();
  if (!VERSION_TEXT.test(text)) {
    return {
      kind: 'refused',
      reason: `the version marker holds ${JSON.stringify(text)}, which is not a version number`,
    };
  }

  const version = Number(text);
  if (version > STORAGE_SCHEMA_VERSION) {
    return {
      kind: 'refused',
      reason: `this store is version ${version} and this build reads ${STORAGE_SCHEMA_VERSION}; a newer Gripterm has been here`,
    };
  }
  if (version < FIRST_VERSION) {
    return { kind: 'refused', reason: 'the version marker holds zero, and versions start at one' };
  }
  return { kind: 'ready', version, origin };
}

/**
 * `ENOENT`, meaning there is no marker yet, and nothing else.
 *
 * A plain property read rather than optional chaining: `readFile` rejects with
 * an `Error`, always, so a guard against a null cause would be a branch no test
 * could reach. Were that ever to stop being true, the `TypeError` lands in
 * `prepare`'s own catch and comes back as a refusal -- the same answer by a
 * longer road, which is why the guard is not worth an untestable line.
 */
function isMissing(cause: unknown): boolean {
  return (cause as { readonly code?: unknown }).code === 'ENOENT';
}
