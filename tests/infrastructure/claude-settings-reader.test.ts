import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaudeSettings } from '../../packages/core/src/infrastructure/store/claude-settings-reader';

describe('reading the settings files that may explain a silence', () => {
  let base = '';

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'gripterm-settings-'));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('reads a file that is there', async () => {
    const file = join(base, 'settings.json');
    await writeFile(file, JSON.stringify({ disableAllHooks: true }), 'utf8');

    const read = await readClaudeSettings({ files: [file], directories: [] });

    expect(read.sources).toEqual([{ path: file, settings: { disableAllHooks: true } }]);
    expect(read.unreadable).toEqual([]);
  });

  it('says nothing about a file that is not there, because four of the five never are', async () => {
    const read = await readClaudeSettings({ files: [join(base, 'absent.json')], directories: [] });

    expect(read.sources).toEqual([]);
    expect(read.unreadable).toEqual([]);
  });

  it('reports a file it could not parse rather than treating it as empty', async () => {
    // An empty file and a broken one mean opposite things. The CLI cannot read
    // this one either, so whatever the person believes they configured is not
    // in force -- which is exactly the kind of thing this report exists to say.
    const file = join(base, 'broken.json');
    await writeFile(file, '{ "disableAllHooks": tru', 'utf8');

    const read = await readClaudeSettings({ files: [file], directories: [] });

    expect(read.sources).toEqual([]);
    expect(read.unreadable).toEqual([file]);
  });

  it('reads the json files of a drop-in directory, in name order', async () => {
    const directory = join(base, 'managed-settings.d');
    await mkdir(directory);
    await writeFile(join(directory, '20-second.json'), '{"disableAllHooks":true}', 'utf8');
    await writeFile(join(directory, '10-first.json'), '{"allowManagedHooksOnly":true}', 'utf8');
    // Not settings, and the CLI is not asked whether it reads it: a file that is
    // not `.json` is not a settings file by its own name.
    await writeFile(join(directory, 'notes.txt'), 'ignore me', 'utf8');

    const read = await readClaudeSettings({ files: [], directories: [directory] });

    expect(read.sources.map((source) => source.path)).toEqual([
      join(directory, '10-first.json'),
      join(directory, '20-second.json'),
    ]);
    // And the text file is not reported as broken settings either. A README
    // left in this directory must not produce a warning about a policy.
    expect(read.unreadable).toEqual([]);
  });

  it('says nothing about a drop-in directory that does not exist', async () => {
    const read = await readClaudeSettings({ files: [], directories: [join(base, 'absent.d')] });

    expect(read.sources).toEqual([]);
    expect(read.unreadable).toEqual([]);
  });

  it('reads a directory that is empty without complaining', async () => {
    const directory = join(base, 'empty.d');
    await mkdir(directory);

    const read = await readClaudeSettings({ files: [], directories: [directory] });

    expect(read.sources).toEqual([]);
  });

  it('keeps the order it was given, because the caller ordered it by authority', async () => {
    const managed = join(base, 'managed-settings.json');
    const user = join(base, 'user.json');
    await writeFile(managed, '{}', 'utf8');
    await writeFile(user, '{}', 'utf8');

    const read = await readClaudeSettings({ files: [managed, user], directories: [] });

    expect(read.sources.map((source) => source.path)).toEqual([managed, user]);
  });

  it('treats a directory named as a file as absent rather than as a failure', async () => {
    // `~/.claude/settings.json` being a directory is somebody else's mistake,
    // and there is nothing here to report about it that a person could act on.
    const directory = join(base, 'settings.json');
    await mkdir(directory);

    const read = await readClaudeSettings({ files: [directory], directories: [] });

    expect(read.sources).toEqual([]);
    expect(read.unreadable).toEqual([]);
  });
});
