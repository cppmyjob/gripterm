import { join } from 'node:path';
import {
  OwnerId,
  STORAGE_SCHEMA_VERSION,
  StorageLayout,
  TerminalId,
  ValidationError,
  isJournalFileName,
  journalDay,
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
