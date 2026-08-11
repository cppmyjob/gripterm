import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { findExecutable, type ExecutableSearch } from '../../packages/core/src/index';

/**
 * Against a real directory tree, for the reason `FileSessionSettingsStore` is:
 * what an executable IS differs by platform, and a fake filesystem is free to
 * agree with whatever we assumed.
 *
 * `platform` is faked in both directions and the SEPARATOR is not, which is the
 * shape of the module: the separator is `node:path`'s, so a Windows path keeps
 * the colon inside it, and what the platform decides here is only whether a
 * bare name may need an extension.
 */

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gripterm-lookup-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(directory: string, file: string): Promise<string> {
  const full = join(root, directory);
  await mkdir(full, { recursive: true });
  const target = join(full, file);
  await writeFile(target, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(target, 0o755);
  return target;
}

function search(
  directories: readonly string[],
  platform = 'linux',
  pathExt?: string
): ExecutableSearch {
  return { path: directories.join(delimiter), pathExt, platform };
}

describe('findExecutable answers with an absolute path or with nothing', () => {
  it('finds a bare name', async () => {
    const target = await put('bin', 'claude');

    expect(await findExecutable('claude', search([join(root, 'bin')]))).toBe(target);
  });

  it('finds a windows name through PATHEXT', async () => {
    // The extension is what makes a file executable there, and the caller does
    // not know which of the four it will be.
    const target = await put('bin', 'claude.EXE');

    const found = await findExecutable(
      'claude',
      search([join(root, 'bin')], 'win32', '.COM;.EXE;.BAT')
    );

    expect(found).toBe(target);
  });

  it('falls back to the default PATHEXT when the variable is not set', async () => {
    const target = await put('bin', 'claude.CMD');

    expect(await findExecutable('claude', search([join(root, 'bin')], 'win32'))).toBe(target);
  });

  it('ignores the blank entries a PATHEXT collects', async () => {
    const target = await put('bin', 'claude.EXE');

    const found = await findExecutable('claude', search([join(root, 'bin')], 'win32', '.EXE;; '));

    expect(found).toBe(target);
  });

  it('does not offer an extensionless file on windows', async () => {
    // There the extension IS the executable bit, and this file cannot be run at
    // all -- while `stat` calls it a file and `access(X_OK)` says yes to
    // everything. An answer here would be an absolute path to something that
    // fails on execution, written into a settings file for another process.
    await put('bin', 'claude');

    expect(await findExecutable('claude', search([join(root, 'bin')], 'win32'))).toBeNull();
  });

  it('does not let a blank PATHEXT entry become the bare name', async () => {
    // An empty extension appended to `claude` is `claude`, which is the case
    // above arriving by a different door.
    await put('bin', 'claude');

    const found = await findExecutable('claude', search([join(root, 'bin')], 'win32', '.EXE;;'));

    expect(found).toBeNull();
  });

  it('does not append a windows extension off windows', async () => {
    // The same tree, the same name, and the answer differs by platform. This is
    // the one thing `platform` decides.
    await put('bin', 'claude.EXE');
    const where = [join(root, 'bin')];

    expect(await findExecutable('claude', search(where, 'win32'))).not.toBeNull();
    expect(await findExecutable('claude', search(where, 'linux'))).toBeNull();
  });

  it('takes the caller at their word when the name already has an extension', async () => {
    // Appending `.COM` to `claude.exe` would be the lookup arguing with the
    // caller about what they asked for.
    const target = await put('bin', 'claude.exe');

    expect(await findExecutable('claude.exe', search([join(root, 'bin')], 'win32'))).toBe(target);
  });

  it('reads the entries in the order PATH gives them', async () => {
    const first = await put('one', 'claude');
    await put('two', 'claude');

    const found = await findExecutable('claude', search([join(root, 'one'), join(root, 'two')]));

    expect(found).toBe(first);
  });

  it('walks past a directory that does not have it', async () => {
    const target = await put('two', 'claude');

    const found = await findExecutable(
      'claude',
      search([join(root, 'missing'), join(root, 'two')])
    );

    expect(found).toBe(target);
  });

  it('says nothing rather than guessing when it is not there', async () => {
    // An ordinary answer, not an error: what to do without `claude` and what to
    // do without `node` are different decisions, and both are the caller's.
    await put('bin', 'something-else');

    expect(await findExecutable('claude', search([join(root, 'bin')]))).toBeNull();
  });

  it('does not offer a directory as something to run', async () => {
    // On POSIX a directory carries the execute bit, so asking `access` alone
    // would hand one back as something to run.
    await mkdir(join(root, 'bin', 'claude'), { recursive: true });

    expect(await findExecutable('claude', search([join(root, 'bin')]))).toBeNull();
  });

  it('skips a relative PATH entry even when it would have matched', async () => {
    // The working directory is moved onto the tree on purpose, so that `./bin`
    // WOULD resolve. Resolving it would resolve against THIS process's
    // directory, which is not the one the entry was written for -- and the
    // answer would then be a relative path, in a settings file, read by
    // somebody else's process.
    await put('bin', 'claude');
    const before = process.cwd();
    process.chdir(root);
    try {
      expect(await findExecutable('claude', search(['./bin']))).toBeNull();
    } finally {
      process.chdir(before);
    }
  });

  it('survives a PATH that is empty or absent', async () => {
    expect(await findExecutable('claude', search([]))).toBeNull();
    expect(
      await findExecutable('claude', { path: undefined, pathExt: undefined, platform: 'linux' })
    ).toBeNull();
  });

  it('ignores the blank entries a PATH collects', async () => {
    const target = await put('bin', 'claude');

    const found = await findExecutable('claude', {
      path: `${delimiter}${delimiter}${join(root, 'bin')}${delimiter}`,
      pathExt: undefined,
      platform: 'linux',
    });

    expect(found).toBe(target);
  });
});
