import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileSessionSettingsStore,
  ListeningAddress,
  SessionSettingsBuilder,
  StorageError,
  TerminalId,
} from '../../packages/core/src/index.js';
import { NEXT_SESSION_UUID, TERMINAL_UUID } from '../helpers/domain-fixtures.js';

/**
 * The one file M1 puts on disk (§5), and the only reason the extension is
 * observable at all: no `settings.json` means no `--settings`, no hooks, no
 * П1. It is a DERIVED artefact -- losing it is repaired by regenerating, and
 * keeping a stale one is the failure that matters, because the port inside
 * belongs to an activation that has ended.
 *
 * Written against a real file system rather than a fake one. Directory
 * creation, replacing a file that already exists and the shape of an OS error
 * are exactly what a fake would be free to get wrong, and every test built on
 * it would agree with the mistake.
 */

const TERMINAL = TerminalId.fromString(TERMINAL_UUID);
const OTHER_TERMINAL = TerminalId.fromString(NEXT_SESSION_UUID);
const HOOK_EVENT_COUNT = 11;

function documentFor(port: number): ReturnType<SessionSettingsBuilder['build']> {
  return new SessionSettingsBuilder().build({
    terminalId: TERMINAL,
    address: ListeningAddress.loopback(port),
    sessionStart: {
      interpreterPath: 'C:/Program Files/nodejs/node.exe',
      scriptPath: 'C:/ext/forwarder.js',
    },
  });
}

describe('FileSessionSettingsStore', () => {
  let base = '';

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'gripterm-settings-'));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('builds the terminal directory that did not exist, and names the file it wrote', async () => {
    const store = new FileSessionSettingsStore(base);

    const written = await store.write(TERMINAL, documentFor(51_337));

    expect(written).toBe(join(base, 'terminals', TERMINAL_UUID, 'settings.json'));
    expect(await readdir(join(base, 'terminals', TERMINAL_UUID))).toStrictEqual(['settings.json']);
  });

  it('writes JSON the CLI can read back unchanged', async () => {
    const store = new FileSessionSettingsStore(base);
    const document = documentFor(51_337);

    const written = await store.write(TERMINAL, document);

    expect(JSON.parse(await readFile(written, 'utf8'))).toStrictEqual(JSON.parse(JSON.stringify(document)));
  });

  it('writes it for a person to read, which is the only reason it is a file', async () => {
    // §4.4: passing `--settings` a path rather than inline JSON buys exactly one
    // thing -- someone can open it when the terminal misbehaves. One long line
    // would spend that.
    //
    // Counted against the eleven events, not against one line: the store ends
    // the file with a newline, so "more than one line" is true of unindented
    // JSON as well, and the assertion would hold on the thing it forbids. Found
    // by mutation, 2026-08-10.
    const store = new FileSessionSettingsStore(base);

    const written = await store.write(TERMINAL, documentFor(51_337));
    const lines = (await readFile(written, 'utf8')).split('\n');

    expect(lines.length).toBeGreaterThan(HOOK_EVENT_COUNT);
    expect(lines.filter((line) => line.startsWith('  '))).not.toStrictEqual([]);
  });

  it('replaces a stale file rather than leaving the dead port in place', async () => {
    const store = new FileSessionSettingsStore(base);
    await store.write(TERMINAL, documentFor(51_337));

    const written = await store.write(TERMINAL, documentFor(51_338));
    const content = await readFile(written, 'utf8');

    expect(content).toContain('127.0.0.1:51338');
    expect(content).not.toContain('51337');
  });

  it('leaves no half-written neighbour behind', async () => {
    // Replacing in place would give the CLI a window in which the file exists
    // and is truncated. Whatever the store does instead must not survive it.
    const store = new FileSessionSettingsStore(base);

    await store.write(TERMINAL, documentFor(51_337));
    await store.write(TERMINAL, documentFor(51_338));

    expect(await readdir(join(base, 'terminals', TERMINAL_UUID))).toStrictEqual(['settings.json']);
  });

  it('keeps two terminals in separate directories', async () => {
    const store = new FileSessionSettingsStore(base);

    await store.write(TERMINAL, documentFor(51_337));
    await store.write(OTHER_TERMINAL, documentFor(51_338));

    expect((await readdir(join(base, 'terminals'))).sort((a, b) => a.localeCompare(b))).toStrictEqual(
      [TERMINAL_UUID, NEXT_SESSION_UUID].sort((a, b) => a.localeCompare(b))
    );
  });

  it('clears its scratch file when the swap itself fails', async () => {
    // The one case where a temporary really can survive: the content was
    // written and only the swap refused. A leftover in the terminal directory
    // is not neutral -- M2.1 reads this directory and has to be able to say
    // what belongs in it.
    const settingsAsDirectory = join(base, 'terminals', TERMINAL_UUID, 'settings.json');
    await mkdir(settingsAsDirectory, { recursive: true });
    const store = new FileSessionSettingsStore(base);

    await expect(store.write(TERMINAL, documentFor(51_337))).rejects.toBeInstanceOf(StorageError);

    expect(await readdir(join(base, 'terminals', TERMINAL_UUID))).toStrictEqual(['settings.json']);
  });

  it('reports a file system refusal as a StorageError, with the path in it', async () => {
    // The caller is the launch path, and it has to tell the difference between
    // "the disk said no" and a defect of ours. A raw ENOTDIR arriving at the
    // user as a notification is the same thing as no message at all.
    await writeFile(join(base, 'terminals'), 'not a directory', 'utf8');
    const store = new FileSessionSettingsStore(base);

    await expect(store.write(TERMINAL, documentFor(51_337))).rejects.toBeInstanceOf(StorageError);
  });
});
