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
/**
 * The file a terminal's record lives in, wherever its folder happens to be.
 *
 * Exported, unlike its neighbours, because `TrashStore` reads it out of a COPY
 * in the trash -- a directory whose name may not decode to an id at all, so
 * there is no `TerminalId` to form the path from and no member of this class
 * that could. One name for it rather than a second literal in another file.
 */
export const RECORD_FILE_NAME = 'record.json';

const RECORD_FILE = RECORD_FILE_NAME;
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

/**
 * Where a record goes when a person throws it away (M2.7).
 *
 * This directory was named in §4.8 and deliberately absent from this class until
 * something wrote it, on the rule that a getter for a path nothing writes is a
 * promise made before the decision it describes. M2.7 is the milestone that
 * writes it; M2.15 sweeps it, and inherits the shape rather than choosing it.
 */
const TRASH_DIRECTORY = 'trash';

/**
 * Where this build keeps its own log (Ш3).
 *
 * In the store and not beside the editor's other logs, so that the whole of
 * what a person is ever asked for is one folder. Nothing sweeps it: the cleaner
 * looks in `terminals/` and `trash/`, and the watcher watches `terminals/` and
 * `owners/`, so a directory here is invisible to both -- which is deliberate,
 * because a log that a pass could carry off is a log that is missing exactly
 * when it is wanted.
 */
const LOGS_DIRECTORY = 'logs';

/**
 * What the last pass over the trash leaves behind: the moment it ran (M2.15).
 *
 * In the base rather than in `trash/`, because the pass has to be able to
 * measure the clock in a store where nothing has ever been thrown away -- and
 * creating `trash/` in order to record that it is not there would put a folder
 * called trash into the store of a person who has never deleted anything.
 *
 * The schema version does not move for it. An older build has no name for this
 * file and ignores it, and the worst that follows is a pass made by the old
 * rule -- which is what that build would have done anyway.
 */
const TRASH_SWEEP_FILE = 'trash-sweep.json';

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
 * construction, so nothing about them can escape the base. The members that can
 * REFUSE are the three formed from a string somebody else chose: `ownerFile`
 * from an id its host offered, and the two that take a name off the medium --
 * `discardedOwnerFile` and `discardedStrayDir`, whose whole job is to address
 * things nothing could be decoded from.
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

  public get trashDir(): string {
    return join(this._baseDir, TRASH_DIRECTORY);
  }

  /** Holds when the trash was last swept, and nothing else. See `TRASH_SWEEP_FILE`. */
  public get trashSweepFile(): string {
    return join(this._baseDir, TRASH_SWEEP_FILE);
  }

  public get logsDir(): string {
    return join(this._baseDir, LOGS_DIRECTORY);
  }

  /** Throws `ValidationError` on an id that would not be safe as a file name. */
  public ownerFile(ownerId: OwnerId): string {
    return join(this.ownersDir, `${requireSafeOwnerId(ownerId.value)}.json`);
  }

  /**
   * A presence file by the NAME it was found under, rather than by an id.
   *
   * The way back for `discardedOwnerFile`, and it takes the same kind of string
   * for the same reason: the files worth collecting are the ones nothing could
   * be read from, so a return has only the name the trash kept. Checked here,
   * because this one is a destination for a WRITE.
   */
  public ownerFileNamed(fileName: string): string {
    return join(this.ownersDir, requireSafeFileName(fileName));
  }

  /**
   * A terminal's directory by the NAME it was found under, rather than by an id.
   *
   * The way back for `discardedStrayDir`: what the cleanup swept includes
   * directories no record could be read from, so a return has only a name.
   */
  public terminalDirNamed(name: string): string {
    return join(this.terminalsDir, requireSafeFileName(name));
  }

  /**
   * One window's log, named after the window.
   *
   * Refused for the same reasons the presence file is, and by the same check:
   * this is a path formed from an id that some window CHOSE, and the file it
   * names is opened for writing. An id that could climb out of `logs/` would be
   * this build appending text to a path somebody else picked.
   */
  public logFile(ownerId: OwnerId): string {
    return join(this.logsDir, `${requireSafeOwnerId(ownerId.value)}.log`);
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

  /**
   * A discarded record's new home, `trash/<stamp>/<terminalId>/`.
   *
   * Takes the MOMENT and not a formatted stamp, for the reason stated at the top
   * of this class: every path here is formed from a `TerminalId`, which is a
   * validated uuid, so nothing about it can leave the base. A stamp passed in as
   * a string would be the second member that can, and this one would be reached
   * from a delete rather than from a heartbeat.
   *
   * Two records thrown away in the same second share the stamp and not the
   * directory, which is what makes the name safe to reuse: the same record twice
   * in one second is not reachable, because the first delete takes it out of
   * every list it could be deleted from again.
   */
  public discardedTerminalDir(at: Date, terminalId: TerminalId): string {
    return join(this.trashDir, trashStamp(at), terminalId.value);
  }

  /**
   * The two files keep their names on the way to the trash, and that is the
   * rollback: moving them back into `terminals/<terminalId>/` restores the
   * record exactly, with no tool and no format to understand (§I.3). Back into
   * the directory rather than over it -- the journal and the settings file never
   * left, so the terminal's own directory is still there with them in it.
   */
  public discardedRecordFile(at: Date, terminalId: TerminalId): string {
    return join(this.discardedTerminalDir(at, terminalId), RECORD_FILE);
  }

  public discardedObservedFile(at: Date, terminalId: TerminalId): string {
    return join(this.discardedTerminalDir(at, terminalId), OBSERVED_FILE);
  }

  /**
   * Where a presence file goes when the reconciler collects it (M2.12).
   *
   * The trash rather than deletion, for the same reason a record gets it: an
   * irreversible act needs the way back made first (§I.3). The file is usually
   * worthless -- a window that is gone -- but the case that decides the rule is
   * the other one: a file that would not DECODE may be failing because of a
   * defect in the decoder, and deleting every instance of the evidence is how
   * such a defect outlives its own report.
   *
   * Takes a FILE NAME and not an `OwnerId`, and it is the only path in this
   * class that takes an untrusted string. That is forced by what is being
   * collected: the files worth collecting are the ones nothing could be read
   * from, so there is no id to form them from -- only the name `readdir`
   * returned. Which is exactly why this one checks.
   */
  public discardedOwnerFile(at: Date, fileName: string): string {
    return join(
      this.trashDir,
      trashStamp(at),
      OWNERS_DIRECTORY,
      requireSafeFileName(fileName)
    );
  }

  /**
   * Everything one run of the cleanup takes away, under one stamp (M2.15).
   *
   * One batch per run rather than one per record, and that is the rollback
   * rather than tidiness: a person undoing a cleanup has one directory to look
   * in and one decision to reverse, instead of a hunt through the trash for the
   * pieces of a single click.
   */
  public trashBatchDir(at: Date): string {
    return join(this.trashDir, trashStamp(at));
  }

  /**
   * One batch by the NAME it was found under, for the pass that reads the trash
   * rather than the one that writes it.
   *
   * The moment is gone by then: what a person is offered comes off `readdir`,
   * and re-deriving a `Date` from a stamp in order to hand it back to
   * `trashBatchDir` would be parsing our own file names -- which is exactly what
   * the retention refuses to do.
   */
  public trashBatchNamed(batch: string): string {
    return join(this.trashDir, requireSafeFileName(batch));
  }

  /** Where in one batch the collected presence files are. */
  public discardedOwnersDir(batch: string): string {
    return join(this.trashBatchNamed(batch), OWNERS_DIRECTORY);
  }

  /**
   * Where a whole terminal directory goes when the cleanup sweeps it.
   *
   * Takes the NAME it was found under rather than a `TerminalId`, and that is
   * forced by what is being swept: the directories worth sweeping include the
   * ones no record could be read from, and a directory whose name is not an id
   * is exactly the kind the repository can never list. So this is the second
   * member here formed from an untrusted string, and like the first one it
   * checks -- `..` would move the store rather than a leftover.
   */
  public discardedStrayDir(at: Date, name: string): string {
    return join(this.trashBatchDir(at), requireSafeFileName(name));
  }
}

/**
 * A name that can only be a file IN a directory, never a way out of one.
 *
 * Weaker than `requireSafeOwnerId` on purpose: this is applied to names that
 * came off the medium rather than to ids we minted, and a presence file left by
 * a future version -- or by a person's stray copy -- must still be collectable.
 * What it refuses is only what would leave the directory it was found in.
 */
function requireSafeFileName(name: string): string {
  if (name === '' || name === '.' || name === '..' || /[\\/]/u.test(name)) {
    throw new ValidationError('a collected file name must be a single path component', {
      details: { fileName: name },
    });
  }
  return name;
}

/** Whether a name in `events/` is one of ours, and not, say, an editor's backup. */
export function isJournalFileName(name: string): boolean {
  return JOURNAL_FILE_NAME.test(name);
}

const JOURNAL_FILE_NAME = /^\d{4}-\d{2}-\d{2}\.ndjson$/;

/**
 * Whether a name in `trash/` is a batch this build made (M2.15).
 *
 * The sweep removes whole directories by a rule -- old enough, or holding
 * nothing -- and a rule like that is only defensible over names we minted
 * ourselves. Anything else in there is a person's own: a copy they made before
 * trying something, which is precisely the use a directory called `trash` with
 * their records in it invites.
 */
export function isTrashBatchName(name: string): boolean {
  return TRASH_BATCH_NAME.test(name);
}

const TRASH_BATCH_NAME = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/;

/**
 * Whether an entry in a batch holds presence files rather than a terminal.
 *
 * A directory under `terminals/` could in principle be called `owners` and land
 * here beside the real one -- `discardedStrayDir` takes the name it was found
 * under and only refuses what would LEAVE the batch. Nothing mints such a name
 * (a terminal directory is a uuid), so this is a reading rule and not a guard:
 * what is in `owners/` is read as presence files, and a person who put a folder
 * of that name under `terminals/` is told so by the list rather than surprised
 * by it.
 */
export function isDiscardedOwnersArea(name: string): boolean {
  return name === OWNERS_DIRECTORY;
}

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

/**
 * When a record was discarded, as a directory name.
 *
 * Local time and second granularity, and the same bargain as `journalDay`: the
 * name is written for a person going to look for something they deleted this
 * afternoon, so it is their afternoon. Fixed-width, so lexicographic order is
 * chronological order and the sweep of M2.15 can compare strings rather than
 * parse dates back out of directory names.
 *
 * No colons. They are legal in a path on POSIX and are an alternate data stream
 * on NTFS, where `trash/12:04:33` is not a directory but a silent nothing.
 */
export function trashStamp(at: Date): string {
  const hours = String(at.getHours()).padStart(DATE_FIELD_WIDTH, '0');
  const minutes = String(at.getMinutes()).padStart(DATE_FIELD_WIDTH, '0');
  const seconds = String(at.getSeconds()).padStart(DATE_FIELD_WIDTH, '0');
  return `${journalDay(at)}_${hours}-${minutes}-${seconds}`;
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
