import { join } from 'node:path';
import { DEFAULT_STORAGE_DIRECTORY, chooseStorageDir } from '../../packages/core/src/index';

const HOME = join('C:', 'Users', 'somebody');
const DEFAULT = join(HOME, DEFAULT_STORAGE_DIRECTORY);

describe('where the store lives', () => {
  it('is under the home directory when nothing is configured', () => {
    for (const configured of [undefined, null, '']) {
      expect(chooseStorageDir({ configured, home: HOME })).toStrictEqual({
        path: DEFAULT,
        refused: null,
      });
    }
  });

  it('is what the person configured, when that is an absolute path', () => {
    const elsewhere = join('D:', 'work', 'gripterm-store');

    expect(chooseStorageDir({ configured: elsewhere, home: HOME })).toStrictEqual({
      path: elsewhere,
      refused: null,
    });
  });

  it('expands a leading tilde, in either spelling', () => {
    expect(chooseStorageDir({ configured: '~/store', home: HOME }).path).toBe(join(HOME, 'store'));
    expect(chooseStorageDir({ configured: '~\\store', home: HOME }).path).toBe(join(HOME, 'store'));
  });

  /*
   * The rule that matters. A relative path would not fail: it would make a
   * `.gripterm` next to whatever directory the extension host happened to start
   * in, and the person would find an empty list here and a full disk somewhere
   * they never look.
   */
  it('refuses a relative path and says so, rather than resolving it against nowhere', () => {
    const choice = chooseStorageDir({ configured: 'store', home: HOME });

    expect(choice.path).toBe(DEFAULT);
    expect(choice.refused).toContain('not absolute');
  });

  it('refuses a value that is not a string at all', () => {
    // `settings.json` can hold anything, and a number here would otherwise be
    // stringified into a directory name.
    const choice = chooseStorageDir({ configured: 42, home: HOME });

    expect(choice.path).toBe(DEFAULT);
    expect(choice.refused).toContain('not a string');
  });

  it('ignores the whitespace a person leaves around a pasted path', () => {
    const elsewhere = join('D:', 'work', 'store');

    expect(chooseStorageDir({ configured: `  ${elsewhere}  `, home: HOME }).path).toBe(elsewhere);
  });
});
