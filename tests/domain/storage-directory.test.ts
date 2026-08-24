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
        configured: false,
      });
    }
  });

  it('is what the person configured, when that is an absolute path', () => {
    const elsewhere = join('D:', 'work', 'gripterm-store');

    expect(chooseStorageDir({ configured: elsewhere, home: HOME })).toStrictEqual({
      path: elsewhere,
      refused: null,
      configured: true,
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
    expect(choice.configured).toBe(false);
  });

  it('refuses a value that is not a string at all', () => {
    // `settings.json` can hold anything, and a number here would otherwise be
    // stringified into a directory name.
    const choice = chooseStorageDir({ configured: 42, home: HOME });

    expect(choice.path).toBe(DEFAULT);
    expect(choice.refused).toContain('not a string');
    expect(choice.configured).toBe(false);
  });

  it('ignores the whitespace a person leaves around a pasted path', () => {
    const elsewhere = join('D:', 'work', 'store');

    expect(chooseStorageDir({ configured: `  ${elsewhere}  `, home: HOME }).path).toBe(elsewhere);
  });

  /*
   * The distinction the refusal in `readStorageDir` rests on. `refused: null`
   * covers two opposite answers -- "we used what you asked for" and "you asked
   * for nothing" -- and a test host must be able to tell them apart, because
   * the second one silently hands it the store of whoever owns the machine.
   * Without this flag the guard would have to compare paths against the default
   * and would then also refuse a person who deliberately configured that very
   * directory, which is a different question.
   */
  it('says whether the path came from the person or from the default', () => {
    expect(chooseStorageDir({ configured: undefined, home: HOME }).configured).toBe(false);
    expect(chooseStorageDir({ configured: DEFAULT, home: HOME })).toStrictEqual({
      path: DEFAULT,
      refused: null,
      configured: true,
    });
  });
});
