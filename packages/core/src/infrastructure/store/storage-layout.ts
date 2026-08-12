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
const EVENTS_DIRECTORY = 'events';
const JOURNAL_SUFFIX = '.ndjson';

/**
 * Where M1 put the journal: one flat file per terminal, no rotation.
 *
 * Kept as a path rather than deleted, because there are such files on disk with
 * real history in them and the journal is the one thing no later version can go
 * back for (§10.1а). Nothing writes it any more; the reader takes it as the
 * oldest day.
 */
const LEGACY_JOURNAL_FILE = 'events.ndjson';

/*
 * `trash/` is named in the layout of §4.8 and is deliberately absent here:
 * M2.15 has not chosen how a discarded record is stamped, and a getter for a
 * path nothing writes is a promise made before the decision it describes.
 * `events/` was in that sentence until M2.4a decided its shape.
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

  public eventsDir(terminalId: TerminalId): string {
    return join(this.terminalDir(terminalId), EVENTS_DIRECTORY);
  }

  /**
   * The journal file a moment belongs to.
   *
   * Takes the moment rather than a formatted name on purpose: the name is
   * derived here and nowhere else, so there is no path in this class that a
   * caller could hand a string that is not a day.
   */
  public journalFile(terminalId: TerminalId, at: Date): string {
    return join(this.eventsDir(terminalId), `${journalDay(at)}${JOURNAL_SUFFIX}`);
  }

  /** M1's single journal file. Read, never written -- see `LEGACY_JOURNAL_FILE`. */
  public legacyJournalFile(terminalId: TerminalId): string {
    return join(this.terminalDir(terminalId), LEGACY_JOURNAL_FILE);
  }
}

/** Whether a name in `events/` is one of ours, and not, say, an editor's backup. */
export function isJournalFileName(name: string): boolean {
  return JOURNAL_FILE_NAME.test(name);
}

const JOURNAL_FILE_NAME = /^\d{4}-\d{2}-\d{2}\.ndjson$/;

/**
 * Whether a path the directory watcher reported is journal traffic.
 *
 * The path is relative to `terminals/`, so ours look like
 * `<terminalId>\events\2026-08-12.ndjson` -- measured on this machine on
 * 2026-08-12, backslash included, which is why both separators are accepted here
 * instead of `path.sep` being assumed.
 *
 * The journal is written on every hook event and read by no window, so it is the
 * one high-frequency source in the store; it is dropped BEFORE the debounce,
 * because otherwise one window's terminal warms every other window's battery
 * (§4.8).
 *
 * What the measurement also showed, and what the obvious sentence "the journal is
 * filtered out" would hide: ten appends produce twelve callbacks, of which this
 * drops eleven. The twelfth is a `change` on the terminal DIRECTORY -- writing
 * inside `events/` stirs its parent -- and it is indistinguishable from a record
 * being written, so it stays and the debounce absorbs it. The filter removes the
 * per-line traffic, not all of it.
 */
export function isJournalPath(relative: string): boolean {
  return relative.split(PATH_SEPARATOR)[JOURNAL_SEGMENT] === EVENTS_DIRECTORY;
}

const PATH_SEPARATOR = /[\\/]/;

/** `<terminalId>/events/...`: the directory is always the second segment. */
const JOURNAL_SEGMENT = 1;

const MONTH_OFFSET = 1;
const DATE_FIELD_WIDTH = 2;
const YEAR_WIDTH = 4;

/**
 * The day a journal file is named for, in LOCAL time.
 *
 * Local rather than UTC because the name is written for a person, and a person
 * asking what happened yesterday means their own yesterday: a session at 23:00
 * in Moscow belongs to that evening, not to the next morning in London. The
 * price is named rather than discovered -- a machine that changes time zone can
 * come back to a day it has already written, which is exactly why the writer
 * establishes the last `seq` from the FILE and not from a counter it kept.
 *
 * Zero-padded and fixed-width, which makes lexicographic order chronological
 * order. Retention compares these strings and never parses a date back out of a
 * file name.
 */
export function journalDay(at: Date): string {
  const year = String(at.getFullYear()).padStart(YEAR_WIDTH, '0');
  const month = String(at.getMonth() + MONTH_OFFSET).padStart(DATE_FIELD_WIDTH, '0');
  const day = String(at.getDate()).padStart(DATE_FIELD_WIDTH, '0');
  return `${year}-${month}-${day}`;
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
