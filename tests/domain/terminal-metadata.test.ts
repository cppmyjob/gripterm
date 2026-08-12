import {
  HookEventParser,
  SessionRegistry,
  TERMINAL_COLORS,
  TerminalMetadataService,
  TerminalId,
  TerminalStateMachine,
  formatTags,
  isBlank,
  parseTags,
} from '../../packages/core/src/index';
import { FixedClock, RecordingLogger } from '../helpers/port-fakes';
import { OBSERVED_AT, TERMINAL_UUID, makeEntry } from '../helpers/domain-fixtures';
import type { RegistryChange, TerminalEntry } from '../../packages/core/src/index';

const NOTE_AT = new Date('2026-08-12T11:22:33.000Z');
const ABSENT = '11111111-2222-4333-8444-555555555555';

interface Stand {
  readonly registry: SessionRegistry;
  readonly logger: RecordingLogger;
  readonly metadata: TerminalMetadataService;
  readonly changes: RegistryChange[];
  readonly held: () => TerminalEntry;
}

function stand(entry = makeEntry()): Stand {
  const logger = new RecordingLogger();
  const registry = new SessionRegistry({
    stateMachine: new TerminalStateMachine(),
    reader: new HookEventParser(),
    clock: new FixedClock(OBSERVED_AT),
    logger,
  });
  registry.register(entry);

  const changes: RegistryChange[] = [];
  registry.subscribe((change) => changes.push(change));

  return {
    registry,
    logger,
    changes,
    metadata: new TerminalMetadataService({ registry, clock: new FixedClock(NOTE_AT), logger }),
    held: (): TerminalEntry => {
      const current = registry.get(entry.terminalId);
      if (current === undefined) {
        throw new Error('the registry lost the entry the test registered');
      }
      return current;
    },
  };
}

function absentId(registry: SessionRegistry): TerminalId {
  const other = TerminalId.fromString(ABSENT);
  expect(registry.knows(other)).toBe(false);
  return other;
}

describe('reading a line of tags', () => {
  it('splits on commas and trims what is left', () => {
    expect(parseTags(' backend , auth ')).toStrictEqual(['backend', 'auth']);
  });

  it('keeps the spaces inside a tag, because a tag can be two words', () => {
    expect(parseTags('code review')).toStrictEqual(['code review']);
  });

  it('drops what is blank and what is repeated', () => {
    expect(parseTags('a, , b,a,')).toStrictEqual(['a', 'b']);
  });

  it('makes nothing out of nothing', () => {
    expect(parseTags('   ')).toStrictEqual([]);
  });

  it('writes back what it would read, so the box shows what a person will get', () => {
    const typed = 'a,  a ,b';
    expect(parseTags(formatTags(parseTags(typed)))).toStrictEqual(parseTags(typed));
    expect(formatTags(['a', 'b'])).toBe('a, b');
  });
});

describe('the colours a row may be painted', () => {
  it('offers no two the same, and none of the state colours', () => {
    const ids = TERMINAL_COLORS.map((color) => color.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith('terminal.ansi'))).toBe(true);
    expect(ids.some((id) => id.startsWith('charts.'))).toBe(false);
  });

  it('names every one of them for a person', () => {
    expect(TERMINAL_COLORS.every((color) => color.label.trim().length > 0)).toBe(true);
  });
});

describe('blank text', () => {
  it('is whitespace as well as emptiness', () => {
    expect(isBlank('')).toBe(true);
    expect(isBlank(' \t\n')).toBe(true);
    expect(isBlank(' x ')).toBe(false);
  });
});

describe('what a person changes about their own record', () => {
  it('renames it', () => {
    const { metadata, held } = stand();

    metadata.rename(held().terminalId, '  auth spike  ');

    expect(held().metadata.displayName).toBe('auth spike');
  });

  it('sets a task and clears it with an empty line', () => {
    const { metadata, held } = stand();

    metadata.setTask(held().terminalId, 'Split the token service');
    expect(held().metadata.task).toBe('Split the token service');

    metadata.setTask(held().terminalId, '   ');
    expect(held().metadata.task).toBeNull();
  });

  it('appends a note, stamped by the clock and not by the caller', () => {
    const { metadata, held } = stand();
    const before = held().metadata.notes.length;

    metadata.addNote(held().terminalId, '  ask about the migration  ');

    const added = held().metadata.notes.at(-1);
    expect(held().metadata.notes).toHaveLength(before + 1);
    expect(added?.text).toBe('ask about the migration');
    expect(added?.at).toStrictEqual(NOTE_AT);
  });

  it('replaces the tags wholesale, including with none', () => {
    const { metadata, held } = stand();

    metadata.setTags(held().terminalId, ['api', 'api', 'db']);
    expect(held().metadata.tags).toStrictEqual(['api', 'db']);

    metadata.setTags(held().terminalId, []);
    expect(held().metadata.tags).toStrictEqual([]);
  });

  it('sets a colour and clears it', () => {
    const { metadata, held } = stand();

    metadata.setColor(held().terminalId, 'terminal.ansiMagenta');
    expect(held().metadata.color).toBe('terminal.ansiMagenta');

    metadata.setColor(held().terminalId, null);
    expect(held().metadata.color).toBeNull();
  });

  it('tells the list, as an amendment and not as an event', () => {
    const { metadata, changes, held } = stand();

    metadata.rename(held().terminalId, 'renamed');

    expect(changes).toHaveLength(1);
    expect(changes[0]).toStrictEqual({
      kind: 'entry',
      entry: held(),
      transition: null,
    });
  });
});

describe('what a person changes about a record that is not theirs to change', () => {
  it('does nothing to a terminal this window does not hold, and does not shout', () => {
    const { metadata, registry, changes, logger } = stand();

    metadata.rename(absentId(registry), 'whatever');

    expect(changes).toStrictEqual([]);
    expect(logger.warnings).toStrictEqual([]);
    expect(logger.infos.at(-1)?.message).toContain('does not hold');
  });

  it('refuses a blank name rather than throwing out of a command handler', () => {
    const { metadata, held, logger, changes } = stand();
    const before = held().metadata.displayName;

    expect(() => { metadata.rename(held().terminalId, '  '); }).not.toThrow();

    expect(held().metadata.displayName).toBe(before);
    expect(changes).toStrictEqual([]);
    expect(logger.warnings.at(-1)?.details?.what).toBe('a rename');
  });

  it('refuses a blank note the same way', () => {
    const { metadata, held, logger, changes } = stand();
    const before = held().metadata.notes.length;

    expect(() => { metadata.addNote(held().terminalId, '\t'); }).not.toThrow();

    expect(held().metadata.notes).toHaveLength(before);
    expect(changes).toStrictEqual([]);
    expect(logger.warnings.at(-1)?.details?.what).toBe('a note');
  });
});

describe('an edit that edits nothing', () => {
  /*
   * The three of these are one rule seen from three sides: opening a box to
   * read what is in it must not redraw the list, must not queue a write and
   * must not touch `record.json`. The registry is the thing that would carry
   * all three, so silence there is the assertion.
   */

  it('does not notify when the name is the one already there', () => {
    const { metadata, changes, held } = stand();

    metadata.rename(held().terminalId, held().metadata.displayName);

    expect(changes).toStrictEqual([]);
  });

  it('does not notify when the task is retyped exactly', () => {
    const { metadata, changes, held } = stand();

    metadata.setTask(held().terminalId, held().metadata.task);

    expect(changes).toStrictEqual([]);
  });

  it('does not notify when the tags come back in the same order', () => {
    const { metadata, changes, held } = stand();

    metadata.setTags(held().terminalId, [...held().metadata.tags]);

    expect(changes).toStrictEqual([]);
  });

  it('does notify when the same tags come back in another order', () => {
    const { metadata, changes, held } = stand();
    metadata.setTags(held().terminalId, ['a', 'b']);
    changes.length = 0;

    metadata.setTags(held().terminalId, ['b', 'a']);

    expect(changes).toHaveLength(1);
  });

  it('always notifies for a note, because two notes are never the same note', () => {
    const { metadata, changes, held } = stand();
    const text = 'the same words twice';

    metadata.addNote(held().terminalId, text);
    metadata.addNote(held().terminalId, text);

    // Same text, same millisecond on a fixed clock -- and still two notes: they
    // are a log of what was thought, not a set of what is true.
    expect(changes).toHaveLength(2);
    expect(held().metadata.notes.filter((note) => note.text === text)).toHaveLength(2);
  });
});

describe('the entry the edits produce', () => {
  it('is a new instance, so the list can tell it apart by identity', () => {
    const { metadata, held } = stand();
    const before = held();

    metadata.rename(before.terminalId, 'moved');

    expect(held()).not.toBe(before);
    expect(before.metadata.displayName).not.toBe('moved');
  });

  it('leaves everything that is not metadata alone', () => {
    const { metadata, held } = stand();
    const before = held();

    metadata.setColor(before.terminalId, 'terminal.ansiRed');

    const after = held();
    expect(after.terminalId.value).toBe(TERMINAL_UUID);
    expect(after.sessionId).toBe(before.sessionId);
    expect(after.observed).toBe(before.observed);
    expect(after.launch).toBe(before.launch);
    expect(after.revision).toBe(before.revision);
  });
});
