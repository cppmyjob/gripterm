import { join } from 'node:path';
import { ValidationError } from '../../domain/errors/gripterm-error';
import type { OwnerId } from '../../domain/entities/owner-id';
import type { TerminalId } from '../../domain/entities/terminal-id';

/**
 * The version of the DIRECTORY, not of the extension.
 *
 * It moves when the shape on disk changes in a way an older build would
 * misread. A build refuses a directory numbered above its own, which is the
 * reversible half of the bargain: refusing costs a person one session, while
 * reading a newer record with older rules costs them the record.
 */
export const STORAGE_SCHEMA_VERSION = 1;

/**
 * Owner-only, matching what the CLI does with its own lock files. A no-op on
 * Windows, which is the platform this is developed on -- so it is set and never
 * asserted: a test claiming the permission holds would be describing POSIX
 * while running on NTFS.
 */
export const STORAGE_DIRECTORY_MODE = 0o700;

const VERSION_FILE = 'version';
const OWNERS_DIRECTORY = 'owners';
const TERMINALS_DIRECTORY = 'terminals';
const RECORD_FILE = 'record.json';
const OBSERVED_FILE = 'observed.json';
const SETTINGS_FILE = 'settings.json';

/*
 * `events/` and `trash/` are named in the layout of §4.8 and are deliberately
 * absent here. Their shape is not settled -- one journal file per terminal
 * against one per day is M2.4a's question, and M2.15 has not chosen how a
 * discarded record is stamped -- and a getter for a path nothing writes is a
 * promise made before the decision it describes.
 */

/**
 * What an owner id may look like once it is a file name.
 *
 * Lowercase only, and that is the point rather than an oversight: Windows and
 * macOS compare file names without regard to case, so two ids differing only in
 * case would SHARE a presence file. Sharing one is not a cosmetic fault -- a
 * window whose heartbeat lands in somebody else's file looks dead, its
 * terminals become adoptable, and adoption starts a second `claude --resume` on
 * a conversation that already has one. Refusing loudly at the first write is
 * the cheap end of that; the producer mints lowercase UUIDs, so nothing legal
 * is being turned away.
 */
const SAFE_OWNER_ID = /^[a-z0-9][a-z0-9._-]*$/;

/** Long enough for a UUID and every id we mint; short enough for `MAX_PATH`. */
const MAX_OWNER_ID_LENGTH = 128;

/**
 * Names Windows resolves to a device however they are spelled, and whatever
 * extension follows -- `con.json` is the console, not a file.
 *
 * Reachable through `SAFE_OWNER_ID`, so it is checked rather than argued about.
 * A write to a device succeeds and reads back nothing, which is the worst
 * possible failure for a presence file: it does not throw, it just makes a live
 * window look dead.
 */
const DEVICE_NAMES: ReadonlySet<string> = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

/**
 * Every path in the store, formed in one place.
 *
 * The base directory is passed in rather than resolved here: it is a user
 * setting (`gripterm.storage.path`), resolving `~` is the composition root's
 * business, and a test needs a directory of its own.
 *
 * A terminal's paths take a `TerminalId`, which is a validated UUID by
 * construction, so nothing about them can escape the base. An owner id is any
 * non-blank string its host offered, so `ownerFile` is the one member here that
 * can refuse.
 */
export class StorageLayout {
  constructor(private readonly _baseDir: string) {}

  public get baseDir(): string {
    return this._baseDir;
  }

  /** Holds the schema version, as decimal digits and nothing else. */
  public get versionFile(): string {
    return join(this._baseDir, VERSION_FILE);
  }

  public get ownersDir(): string {
    return join(this._baseDir, OWNERS_DIRECTORY);
  }

  public get terminalsDir(): string {
    return join(this._baseDir, TERMINALS_DIRECTORY);
  }

  /** Throws `ValidationError` on an id that would not be safe as a file name. */
  public ownerFile(ownerId: OwnerId): string {
    return join(this.ownersDir, `${requireSafeOwnerId(ownerId.value)}.json`);
  }

  public terminalDir(terminalId: TerminalId): string {
    return join(this.terminalsDir, terminalId.value);
  }

  public recordFile(terminalId: TerminalId): string {
    return join(this.terminalDir(terminalId), RECORD_FILE);
  }

  public observedFile(terminalId: TerminalId): string {
    return join(this.terminalDir(terminalId), OBSERVED_FILE);
  }

  public settingsFile(terminalId: TerminalId): string {
    return join(this.terminalDir(terminalId), SETTINGS_FILE);
  }
}

function requireSafeOwnerId(value: string): string {
  if (value.length > MAX_OWNER_ID_LENGTH || !SAFE_OWNER_ID.test(value)) {
    throw new ValidationError(
      'an owner id must be lowercase letters, digits, dot, dash or underscore to be a file name',
      { details: { ownerId: value } }
    );
  }
  // `split('.', 1).join('')` rather than an index: it yields a string for every
  // input, so there is no "and what if there were no parts" branch to leave
  // untested.
  if (DEVICE_NAMES.has(value.split('.', 1).join(''))) {
    throw new ValidationError('an owner id must not be a reserved device name', {
      details: { ownerId: value },
    });
  }
  return value;
}
