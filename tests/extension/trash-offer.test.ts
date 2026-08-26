import { labelOf, offerOf, restoredSentence } from '../../packages/extension/src/commands/trash-offer';
import type { TrashItem } from '../../packages/core/src/index';

/**
 * What a person READS when they open the trash, held as a promise rather than
 * left to a screenshot.
 *
 * Here rather than in the integration suite, and the reason is the same one
 * `disposalOf` is tested in `tests/domain`: this is a rule, not plumbing. The
 * integration suite can show that a list was drawn and that a row chosen out of
 * it brought a record back -- what it cannot cheaply show is that every one of
 * the three forms says what putting THAT one back would do, and those three
 * sentences are the whole of what a person has to decide on.
 *
 * The module under test imports `vscode` for a TYPE only, so plain jest can load
 * it; nothing here needs an editor, because nothing here is about one.
 */

const BATCH = '2026-08-01_12-00-00';
const TERMINAL = '5c4b3a29-1d0e-4f6a-9b8c-7d6e5f4a3b2c';
const STORE = 'D:/store';

function itemFor(overrides: Partial<TrashItem>): TrashItem {
  return {
    batch: BATCH,
    name: TERMINAL,
    form: 'whole-folder',
    from: `${STORE}/trash/${BATCH}/${TERMINAL}`,
    to: `${STORE}/terminals/${TERMINAL}`,
    files: ['events/2026-08-01.ndjson', 'observed.json', 'record.json', 'settings.json'],
    displayName: 'auth-refactor',
    ...overrides,
  };
}

describe('what the trash offers a person', () => {
  it('names a whole folder by the name they gave the terminal, and says it has no home now', () => {
    expect(offerOf(itemFor({}))).toStrictEqual({
      label: 'auth-refactor',
      description: `in trash/${BATCH}`,
      detail: `4 files back into terminals/${TERMINAL}/, which is not in the store now.`,
      item: itemFor({}),
    });
  });

  it('says of the two cards that the folder they go into never left', () => {
    // The difference that matters: this one is put INTO a directory that is
    // still there, so its journal and its settings are not what is coming back.
    const item = itemFor({ form: 'record-only', files: ['observed.json', 'record.json'] });

    expect(offerOf(item).detail).toBe(
      `2 files back into terminals/${TERMINAL}/, which is still in the store — its journal ` +
        'and its settings never left.'
    );
  });

  it('warns that a presence file is not a terminal at all', () => {
    const item = itemFor({
      form: 'owner-file',
      name: 'window-that-closed.json',
      files: ['window-that-closed.json'],
      displayName: null,
      to: `${STORE}/owners/window-that-closed.json`,
    });

    expect(offerOf(item)).toStrictEqual({
      label: 'window-that-closed.json',
      description: `in trash/${BATCH}`,
      detail:
        '1 file back into owners/. This is not a terminal: it is another window\'s presence ' +
        'file, and putting it back makes that window look like one that was there.',
      item,
    });
  });

  it('falls back to the directory name, which is the row a cleanup could reach and nothing could name', () => {
    // Not a fallback but the point: what `strays` sweeps INCLUDES directories no
    // record could be read from, and a list that drew only the ones it could
    // name would hide exactly those.
    expect(labelOf(itemFor({ displayName: null }))).toBe(TERMINAL);
  });
});

describe('what a person is told once it is back', () => {
  it('says where it went and how much of it went there', () => {
    expect(restoredSentence(itemFor({}), 4, true)).toBe(
      `Gripterm: "auth-refactor" is back in the store — 4 files out of trash/${BATCH} ` +
        `into ${STORE}/terminals/${TERMINAL}.`
    );
  });

  it('adds the copy that could not be taken out of the trash, rather than leaving it to be discovered', () => {
    // Not a failure of the return -- the record is back -- but a person who then
    // goes and looks finds two of everything, and being told beats finding out.
    expect(restoredSentence(itemFor({}), 4, false)).toBe(
      `Gripterm: "auth-refactor" is back in the store — 4 files out of trash/${BATCH} ` +
        `into ${STORE}/terminals/${TERMINAL}. Its copy is still in the trash, which the ` +
        'retention will take away; see the log.'
    );
  });

  it('counts one file as one file', () => {
    expect(restoredSentence(itemFor({ files: ['record.json'] }), 1, true)).toContain('1 file out of');
  });
});
