import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STORAGE_SCHEMA_VERSION, StorageLayout, StorageMigrator } from '../../packages/core/src/index';
import { TERMINAL_UUID } from '../helpers/domain-fixtures';

/**
 * Against a real directory, for the reason every other store test is: creating
 * a directory, an exclusive create losing its race and the shape of an OS
 * refusal are exactly what a fake is free to get wrong.
 */

let base = '';

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'gripterm-migrate-'));
  // `mkdtemp` has already made it, and an empty existing directory is the
  // "fresh" case: the marker, not the directory, is what says a store is ours.
});

afterEach(async () => {
  await chmod(base, 0o700).catch(() => undefined);
  await rm(base, { recursive: true, force: true });
});

function migrator(at = base): StorageMigrator {
  return new StorageMigrator(new StorageLayout(at));
}

describe('preparing the storage directory', () => {
  it('creates the skeleton and the marker when there is nothing there', async () => {
    const prepared = await migrator().prepare();

    expect(prepared).toStrictEqual({
      kind: 'ready',
      version: STORAGE_SCHEMA_VERSION,
      origin: 'created',
    });
    expect((await readdir(base)).sort()).toStrictEqual(['owners', 'terminals', 'version']);
    expect(await readFile(join(base, 'version'), 'utf8')).toBe('1\n');
  });

  it('creates the base directory itself when even that is missing', async () => {
    const nested = join(base, 'a', 'b', '.gripterm');

    const prepared = await migrator(nested).prepare();

    expect(prepared.kind).toBe('ready');
    expect((await readdir(nested)).sort()).toStrictEqual(['owners', 'terminals', 'version']);
  });

  /*
   * The case M2.1 exists for. M1 shipped, wrote `terminals/<id>/settings.json`
   * and never heard of a version marker; refusing that directory would strand
   * every terminal the person already has.
   */
  it('completes a directory left by M1 instead of refusing it', async () => {
    const terminal = join(base, 'terminals', TERMINAL_UUID);
    await mkdir(terminal, { recursive: true });
    await writeFile(join(terminal, 'settings.json'), '{"hooks":{}}', 'utf8');

    const prepared = await migrator().prepare();

    expect(prepared).toStrictEqual({
      kind: 'ready',
      version: STORAGE_SCHEMA_VERSION,
      origin: 'adopted',
    });
    // Adopting must not disturb what was there.
    expect(await readFile(join(terminal, 'settings.json'), 'utf8')).toBe('{"hooks":{}}');
  });

  it('is idempotent: the second activation finds the marker rather than making one', async () => {
    await migrator().prepare();

    const again = await migrator().prepare();

    expect(again).toStrictEqual({
      kind: 'ready',
      version: STORAGE_SCHEMA_VERSION,
      origin: 'existing',
    });
  });

  it('tolerates a marker written with no trailing newline', async () => {
    await mkdir(base, { recursive: true });
    await writeFile(join(base, 'version'), '1', 'utf8');

    expect(await migrator().prepare()).toStrictEqual({
      kind: 'ready',
      version: 1,
      origin: 'existing',
    });
  });

  /*
   * The refusal is the reversible half of the bargain: a session lost against a
   * record lost. It has to name the number, because "storage unusable" sends
   * somebody to delete the directory, which is the one thing that would cost
   * them their terminals.
   */
  it('refuses a store from a newer build, and says which version', async () => {
    await writeFile(join(base, 'version'), '2\n', 'utf8');

    const prepared = await migrator().prepare();

    expect(prepared.kind).toBe('refused');
    expect(prepared.kind === 'refused' ? prepared.reason : '').toContain('version 2');
  });

  it('refuses a marker that is not a version number at all', async () => {
    await writeFile(join(base, 'version'), 'one\n', 'utf8');

    const prepared = await migrator().prepare();

    expect(prepared.kind).toBe('refused');
    expect(prepared.kind === 'refused' ? prepared.reason : '').toContain('not a version number');
  });

  it('refuses an empty marker rather than reading it as version zero', async () => {
    await writeFile(join(base, 'version'), '', 'utf8');

    expect((await migrator().prepare()).kind).toBe('refused');
  });

  it('refuses version zero, because versions start at one', async () => {
    await writeFile(join(base, 'version'), '0\n', 'utf8');

    const prepared = await migrator().prepare();

    expect(prepared.kind).toBe('refused');
    expect(prepared.kind === 'refused' ? prepared.reason : '').toContain('versions start at one');
  });

  it('refuses rather than throws when the directory cannot be made', async () => {
    // A file where the directory should be: the same refusal an unwritable
    // profile produces, reachable on every platform including Windows.
    const blocked = join(base, 'occupied');
    await writeFile(blocked, 'not a directory', 'utf8');

    const prepared = await migrator(blocked).prepare();

    expect(prepared.kind).toBe('refused');
    expect(prepared.kind === 'refused' ? prepared.reason : '').toContain('could not be prepared');
  });

  it('refuses rather than throws when the marker cannot be read', async () => {
    // A directory named `version` is unreadable AS A FILE -- `EISDIR` on POSIX,
    // `EISDIR`/`EPERM` on Windows -- and that is not `ENOENT`, so it must not be
    // mistaken for "no marker yet" and quietly overwritten.
    await mkdir(join(base, 'version'), { recursive: true });

    const prepared = await migrator().prepare();

    expect(prepared.kind).toBe('refused');
    expect(prepared.kind === 'refused' ? prepared.reason : '').toContain('could not be prepared');
  });

  /*
   * Two windows activating together. The exclusive create means exactly one of
   * them writes the marker; the loser must read what the winner wrote rather
   * than report a failure, and neither may end up believing the store is
   * broken.
   */
  it('survives two windows preparing the same directory at once', async () => {
    const outcomes = await Promise.all([
      migrator().prepare(),
      migrator().prepare(),
      migrator().prepare(),
    ]);

    expect(outcomes.every((outcome) => outcome.kind === 'ready')).toBe(true);
    expect(await readFile(join(base, 'version'), 'utf8')).toBe('1\n');
  });
});
