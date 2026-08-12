import { join } from 'node:path';
import {
  OwnerId,
  STORAGE_SCHEMA_VERSION,
  StorageLayout,
  TerminalId,
  ValidationError,
  isJournalFileName,
  isJournalPath,
  journalDay,
  trashStamp,
} from '../../packages/core/src/index';

const BASE = join('C:', 'gripterm-base');
const TERMINAL = TerminalId.fromString('11111111-2222-4333-8444-555555555555');

describe('the layout of the store', () => {
  const layout = new StorageLayout(BASE);

  /*
   * These assertions are the schema. They are written out by hand rather than
   * derived from the class, because a test that asks the code where it puts
   * things agrees with every change including the wrong ones -- and this is the
   * one shape a version marker exists to defend.
   */
  it('puts every path exactly where version 1 says it does', () => {
    expect(layout.baseDir).toBe(BASE);
    expect(layout.versionFile).toBe(join(BASE, 'version'));
    expect(layout.ownersDir).toBe(join(BASE, 'owners'));
    expect(layout.terminalsDir).toBe(join(BASE, 'terminals'));
    expect(layout.terminalDir(TERMINAL)).toBe(join(BASE, 'terminals', TERMINAL.value));
    expect(layout.recordFile(TERMINAL)).toBe(
      join(BASE, 'terminals', TERMINAL.value, 'record.json')
    );
    expect(layout.observedFile(TERMINAL)).toBe(
      join(BASE, 'terminals', TERMINAL.value, 'observed.json')
    );
    expect(layout.settingsFile(TERMINAL)).toBe(
      join(BASE, 'terminals', TERMINAL.value, 'settings.json')
    );
    expect(layout.eventsDir(TERMINAL)).toBe(join(BASE, 'terminals', TERMINAL.value, 'events'));
    expect(layout.legacyJournalFile(TERMINAL)).toBe(
      join(BASE, 'terminals', TERMINAL.value, 'events.ndjson')
    );
  });

  it('is version 1', () => {
    expect(STORAGE_SCHEMA_VERSION).toBe(1);
  });

  it('names an owner file after the owner', () => {
    const ownerId = OwnerId.fromString('7f1c4e2a-0b33-4a55-9c11-2d3e4f556677');
    expect(layout.ownerFile(ownerId)).toBe(join(BASE, 'owners', `${ownerId.value}.json`));
  });

  it('accepts the punctuation an id may legitimately carry', () => {
    for (const raw of ['a', '0', 'window-1.host_2', 'abcdef0123456789']) {
      expect(() => layout.ownerFile(OwnerId.fromString(raw))).not.toThrow();
    }
  });

  /*
   * The refusals below all protect the same thing. A presence file that is not
   * the file we think it is makes a LIVE window look dead, and a window that
   * looks dead has its terminals adopted -- which starts a second
   * `claude --resume` on a conversation that already has one.
   */
  it('refuses an id that would climb out of the store', () => {
    expect(() => layout.ownerFile(OwnerId.fromString('..'))).toThrow(ValidationError);
    expect(() => layout.ownerFile(OwnerId.fromString('../../secrets'))).toThrow(ValidationError);
    expect(() => layout.ownerFile(OwnerId.fromString('a/b'))).toThrow(ValidationError);
    expect(() => layout.ownerFile(OwnerId.fromString('a\\b'))).toThrow(ValidationError);
    expect(() => layout.ownerFile(OwnerId.fromString('c:name'))).toThrow(ValidationError);
  });

  it('refuses uppercase, because two ids differing only in case would share one file', () => {
    expect(() => layout.ownerFile(OwnerId.fromString('Window'))).toThrow(ValidationError);
  });

  it('refuses an id that does not start with a letter or digit', () => {
    expect(() => layout.ownerFile(OwnerId.fromString('-lead'))).toThrow(ValidationError);
    expect(() => layout.ownerFile(OwnerId.fromString('.hidden'))).toThrow(ValidationError);
  });

  it('refuses an id longer than a path can comfortably carry', () => {
    expect(() => layout.ownerFile(OwnerId.fromString('a'.repeat(129)))).toThrow(ValidationError);
    expect(() => layout.ownerFile(OwnerId.fromString('a'.repeat(128)))).not.toThrow();
  });

  it('refuses a Windows device name, with or without an extension', () => {
    // `con.json` IS the console on Windows: the write succeeds and reads back
    // nothing at all, which is the one failure mode a presence file cannot
    // survive.
    for (const raw of ['con', 'nul', 'aux', 'prn', 'com1', 'lpt9', 'con.window']) {
      expect(() => layout.ownerFile(OwnerId.fromString(raw))).toThrow(ValidationError);
    }
  });

  it('does not mistake a name that merely starts like a device for one', () => {
    for (const raw of ['console', 'com10', 'nullable']) {
      expect(() => layout.ownerFile(OwnerId.fromString(raw))).not.toThrow();
    }
  });
});

describe('the name of a journal file', () => {
  const layout = new StorageLayout(BASE);

  /*
   * The day is LOCAL, and that is a decision rather than an oversight: the name
   * is written for a person, and a person asking what happened yesterday means
   * their own yesterday. A date built from local parts is therefore the oracle
   * here -- `new Date(2027, 0, 5, ...)` IS the fifth of January wherever this
   * runs.
   */
  it('is the local day, zero-padded so that names sort chronologically', () => {
    expect(journalDay(new Date(2027, 0, 5, 12, 0, 0))).toBe('2027-01-05');
    expect(journalDay(new Date(2026, 11, 31, 23, 59, 59))).toBe('2026-12-31');
  });

  it('puts the day under events/, with one suffix and nothing else', () => {
    expect(layout.journalFile(TERMINAL, new Date(2027, 0, 5, 12, 0, 0))).toBe(
      join(BASE, 'terminals', TERMINAL.value, 'events', '2027-01-05.ndjson')
    );
  });

  it('recognises its own names and nothing else', () => {
    expect(isJournalFileName('2027-01-05.ndjson')).toBe(true);
    for (const name of [
      '2027-01-05.ndjson.bak',
      'events.ndjson',
      '2027-1-5.ndjson',
      '2027-01-05.json',
      'notes.txt',
    ]) {
      expect(isJournalFileName(name)).toBe(false);
    }
  });
});

/**
 * What the watcher drops before it debounces. The forms below are the ones the
 * platform actually produced on this machine on 2026-08-12 -- a relative path
 * from the watched root, with a backslash -- and the forward-slash spellings are
 * here because the same store is read on POSIX by the same code.
 */
describe('telling journal traffic apart from the rest', () => {
  const ID = TERMINAL.value;

  it('knows the journal by where it sits, whichever separator the platform used', () => {
    expect(isJournalPath(`${ID}\\events\\2027-01-05.ndjson`)).toBe(true);
    expect(isJournalPath(`${ID}/events/2027-01-05.ndjson`)).toBe(true);
    // The directory itself, which is what its creation is reported as.
    expect(isJournalPath(`${ID}\\events`)).toBe(true);
  });

  it('keeps everything else, including what it has never seen before', () => {
    for (const path of [
      `${ID}\\record.json`,
      `${ID}\\observed.json`,
      `${ID}\\adopting.json`,
      // Reported when a file appears inside `events/`: writing there stirs the
      // parent directory too, and that event is indistinguishable from a record
      // being written.
      ID,
      'e5f6a7b8.json',
      // A name from a build that does not exist yet. Unknown means kept: the
      // journal is the one thing we know nobody reads, and everything else is a
      // reason to look again.
      `${ID}\\workflows\\run-1\\state.json`,
      'events',
    ]) {
      expect(isJournalPath(path)).toBe(false);
    }
  });
});

describe('where a discarded record goes', () => {
  /*
   * `trash/` was named in §4.8 and deliberately absent from the layout until
   * something wrote it. M2.7 is what writes it, and M2.15 sweeps it.
   */
  const layout = new StorageLayout(BASE);
  const id = TERMINAL;
  // Local, deliberately: the stamp is read by the person who deleted something
  // this afternoon, so it is their afternoon.
  const at = new Date(2026, 7, 12, 14, 33, 7);

  it('stamps the moment without a character a file system objects to', () => {
    expect(trashStamp(at)).toBe('2026-08-12_14-33-07');
    // No colons anywhere: legal on POSIX, an alternate data stream on NTFS.
    expect(trashStamp(at)).not.toContain(':');
  });

  it('pads every field, so the names sort into the order they happened', () => {
    const early = trashStamp(new Date(2026, 0, 2, 3, 4, 5));
    const later = trashStamp(new Date(2026, 0, 2, 3, 4, 6));

    expect(early).toBe('2026-01-02_03-04-05');
    expect([later, early].sort()).toStrictEqual([early, later]);
  });

  it('gives each record a directory of its own under the stamp', () => {
    expect(layout.trashDir).toBe(join(BASE, 'trash'));
    expect(layout.discardedTerminalDir(at, id)).toBe(
      join(layout.trashDir, '2026-08-12_14-33-07', TERMINAL.value)
    );
  });

  it('keeps the two file names, which is what makes putting them back a move', () => {
    const home = layout.discardedTerminalDir(at, id);

    expect(layout.discardedRecordFile(at, id)).toBe(join(home, 'record.json'));
    expect(layout.discardedObservedFile(at, id)).toBe(join(home, 'observed.json'));
    // The same two names they had under `terminals/`, which is the whole of the
    // rollback: a person moves them back and the record is there again.
    expect(layout.recordFile(id).endsWith('record.json')).toBe(true);
    expect(layout.observedFile(id).endsWith('observed.json')).toBe(true);
  });

  it('stays inside the base, because it is formed from a validated id', () => {
    expect(layout.discardedTerminalDir(at, id).startsWith(layout.trashDir)).toBe(true);
    expect(layout.discardedTerminalDir(at, id)).not.toContain('..');
  });
});
