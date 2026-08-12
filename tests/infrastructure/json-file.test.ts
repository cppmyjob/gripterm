import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonFile, writeJsonFile } from '../../packages/core/src/index';

/**
 * The layer between the store and the disk. Its whole contract is that reading
 * NEVER throws: a caller reading a hundred records must be able to step over
 * one bad file, and an exception on the read path would make that the caller's
 * problem in a hundred places.
 */

let base = '';

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'gripterm-json-'));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('reading one JSON file', () => {
  it('reads back what was written', async () => {
    const path = join(base, 'record.json');

    await writeJsonFile(path, { a: 1, b: [true, null] });

    expect(await readJsonFile(path)).toStrictEqual({
      kind: 'value',
      value: { a: 1, b: [true, null] },
    });
  });

  it('writes it for a person to open: indented, and ending in a newline', async () => {
    const path = join(base, 'record.json');

    await writeJsonFile(path, { a: 1 });

    expect(await readFile(path, 'utf8')).toBe('{\n  "a": 1\n}\n');
  });

  it('says absent rather than failing when there is no file', async () => {
    expect(await readJsonFile(join(base, 'nothing.json'))).toStrictEqual({ kind: 'absent' });
  });

  it('says unreadable for content that is not JSON', async () => {
    const path = join(base, 'record.json');
    await writeFile(path, '{ half a rec', 'utf8');

    const read = await readJsonFile(path);

    expect(read.kind).toBe('unreadable');
    expect(read.kind === 'unreadable' ? read.reason : '').toContain('JSON');
  });

  /*
   * Absent and unreadable are different answers and must not be folded
   * together: a record that is not there was never written, while a record the
   * file system refuses is one to report and step over.
   */
  it('says unreadable, not absent, when the path is a directory', async () => {
    const path = join(base, 'record.json');
    await mkdir(path, { recursive: true });

    expect((await readJsonFile(path)).kind).toBe('unreadable');
  });
});
