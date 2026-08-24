import { join } from 'node:path';
import {
  DEFAULT_STORAGE_DIRECTORY,
  STORAGE_PATH_SETTING,
  chooseStorageDir,
  refuseSplitStore,
} from '../../packages/core/src/index';

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

/**
 * The refusal that stands between a remote window and a second `--resume`.
 *
 * The store comes from a HOME directory, and a window connected to a remote has
 * a different one from the local window open on the same folder. Two stores,
 * neither able to read the other's `owners/`, so both sides find every
 * conversation unowned -- which is the state every guard in this build reads as
 * permission to start. Nothing fails and nothing is logged; the symptom is two
 * agents on one transcript.
 *
 * What these rows hold is the SHAPE of the exit as much as the refusal itself. A
 * guard that refused a configured path too would be a guard nobody can get past,
 * on a machine where the two homes really are one directory under two names.
 */
describe('a store only one side of the project can see', () => {
  const REMOTE_DEFAULT = join('/home', 'somebody', DEFAULT_STORAGE_DIRECTORY);

  it('refuses a remote host whose store came from a home directory', () => {
    const refusal = refuseSplitStore({
      remoteName: 'wsl',
      choice: { path: REMOTE_DEFAULT, refused: null, configured: false },
    });

    expect(refusal).not.toBeNull();
  });

  /*
   * A refusal that names neither what went wrong nor what to do about it is an
   * extension that stopped working for no reason a person can act on -- and this
   * one stops activation, so it is the only sentence they get.
   */
  it('names the hazard, the host, the store and the setting that undoes it', () => {
    const refusal =
      refuseSplitStore({
        remoteName: 'wsl',
        choice: { path: REMOTE_DEFAULT, refused: null, configured: false },
      }) ?? '';

    expect(refusal).toContain('wsl');
    expect(refusal).toContain(REMOTE_DEFAULT);
    expect(refusal).toContain('claude --resume');
    expect(refusal).toContain(STORAGE_PATH_SETTING);
  });

  /*
   * The exit, and the whole of it. Pointing both sides at one real directory --
   * `C:\Users\x\.gripterm` and `/mnt/c/Users/x/.gripterm` are the same folder --
   * is a thing only the person can know, and setting the path is them saying so.
   */
  it('lets a remote host through when the person configured the path', () => {
    expect(
      refuseSplitStore({
        remoteName: 'wsl',
        choice: { path: '/mnt/c/Users/x/.gripterm', refused: null, configured: true },
      })
    ).toBeNull();
  });

  it('says nothing to a local host, configured or not', () => {
    expect(
      refuseSplitStore({
        remoteName: undefined,
        choice: { path: DEFAULT, refused: null, configured: false },
      })
    ).toBeNull();
    expect(
      refuseSplitStore({
        remoteName: undefined,
        choice: { path: join('D:', 'store'), refused: null, configured: true },
      })
    ).toBeNull();
  });

  /*
   * The case a person is most likely to be in and least likely to notice: they
   * DID set the path, it was unusable, and `chooseStorageDir` fell back to the
   * home default with a warning in an Output panel nobody has open. The setting
   * being present is not the deliberate act; the setting being HONOURED is.
   */
  it('refuses a remote host whose configured path was itself refused', () => {
    const choice = chooseStorageDir({ configured: 'store', home: '/home/somebody' });

    expect(choice.configured).toBe(false);
    expect(refuseSplitStore({ remoteName: 'ssh-remote', choice })).not.toBeNull();
  });

  /* Any remote, not a list of the ones we happen to have heard of. */
  it('refuses every kind of remote and not a list of names', () => {
    for (const remoteName of ['wsl', 'ssh-remote', 'dev-container', 'attached-container', 'codespaces']) {
      expect(
        refuseSplitStore({
          remoteName,
          choice: { path: REMOTE_DEFAULT, refused: null, configured: false },
        })
      ).not.toBeNull();
    }
  });
});
