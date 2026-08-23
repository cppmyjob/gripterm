import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileLaunchTrace, StorageLayout, TerminalId } from '../../packages/core/src/index';
import { TERMINAL_UUID } from '../helpers/domain-fixtures';
import { FixedClock, RecordingLogger } from '../helpers/port-fakes';

/**
 * The file that answers a question after the window that could have answered it
 * is gone (owner, 2026-08-23 -- see `LaunchTrace`).
 *
 * Against a real file system, for the same reason the settings store is: the
 * two things that must hold here -- a directory that is not there yet, and
 * appends that keep their order -- are exactly what a fake would be free to get
 * right by accident.
 */

const TERMINAL = TerminalId.fromString(TERMINAL_UUID);
const AT = new Date('2026-08-23T18:29:36.000Z');

/** The trace is fire-and-forget: a test has to let its chain of appends land. */
async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

describe('FileLaunchTrace', () => {
  let base = '';

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'gripterm-trace-'));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  function trace(logger = new RecordingLogger()): { readonly trace: FileLaunchTrace, readonly logger: RecordingLogger } {
    const layout = new StorageLayout(base);
    return {
      trace: new FileLaunchTrace({ layout, clock: new FixedClock(AT), logger }),
      logger,
    };
  }

  async function lines(): Promise<Record<string, unknown>[]> {
    const file = join(new StorageLayout(base).terminalDir(TERMINAL), 'starts.jsonl');
    const text = await readFile(file, 'utf8');
    return text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it('writes a line beside the record, making the directory if a start got there first', async () => {
    const { trace: writer } = trace();

    writer.note(TERMINAL, {
      what: 'start',
      intent: 'resume',
      engine: 'editor',
      executable: 'C:/Users/x/.local/bin/claude.exe',
      flags: ['--resume', '--settings'],
      args: 4,
      session: 'a1beff0c-b5a2-4b68-96da-257ad65e1857',
      cwd: 'D:/Projects/m314-check',
    });
    await settled();

    const [line] = await lines();
    expect(line).toMatchObject({
      v: 1,
      at: AT.toISOString(),
      what: 'start',
      intent: 'resume',
      flags: ['--resume', '--settings'],
      session: 'a1beff0c-b5a2-4b68-96da-257ad65e1857',
    });
  });

  it('keeps the order of one start, because out of order they are not evidence', async () => {
    const { trace: writer } = trace();

    writer.note(TERMINAL, {
      what: 'start',
      intent: 'launch',
      engine: 'editor',
      executable: 'claude.exe',
      flags: [],
      args: 0,
      session: 'a1beff0c-b5a2-4b68-96da-257ad65e1857',
      cwd: 'D:/Projects/m314-check',
    });
    writer.note(TERMINAL, { what: 'no-pid' });
    writer.note(TERMINAL, { what: 'failed', reason: 'the editor refused' });
    await settled();

    expect((await lines()).map((line) => line.what)).toEqual(['start', 'no-pid', 'failed']);
  });

  it('swallows a disk that will not take it, because no terminal fails over a diagnostic', async () => {
    const logger = new RecordingLogger();
    // A base that cannot hold a directory: a FILE where the store should be.
    const layout = new StorageLayout(join(base, 'not-a-directory'));
    await writeFile(join(base, 'not-a-directory'), 'in the way', 'utf8');
    const writer = new FileLaunchTrace({ layout, clock: new FixedClock(AT), logger });

    expect(() => {
      writer.note(TERMINAL, { what: 'pid', pid: 4242 });
    }).not.toThrow();
    await settled();

    expect(
      logger.warnings.some((line) => line.message.includes('could not be written down'))
    ).toBe(true);
  });
});
