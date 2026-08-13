import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionId, readClaudeSessionName } from '../../packages/core/src/index';
import { SESSION_UUID, NEXT_SESSION_UUID } from '../helpers/domain-fixtures';

const CONVERSATION = SessionId.fromString(SESSION_UUID);
const PID = 17_100;

let directory = '';

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'gripterm-sessions-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function writeSession(pid: number, body: Record<string, unknown>): Promise<void> {
  await writeFile(join(directory, `${pid}.json`), JSON.stringify(body), 'utf8');
}

describe('reading the name out of Claude Code`s own session file', () => {
  it('finds the file by the pid of the process holding the conversation', async () => {
    await writeSession(PID, { sessionId: SESSION_UUID, name: 'Test 1' });

    expect(await readClaudeSessionName(directory, PID, CONVERSATION)).toBe('Test 1');
  });

  it('says nothing when that process has no file', async () => {
    expect(await readClaudeSessionName(directory, PID, CONVERSATION)).toBeNull();
  });

  it('says nothing when the directory is not there at all', async () => {
    // The ordinary case on a machine where nobody has run the CLI yet, and it
    // must cost a `null` rather than a thrown activation.
    expect(await readClaudeSessionName(join(directory, 'nope'), PID, CONVERSATION)).toBeNull();
  });

  it('says nothing when the file left by that pid is about another conversation', async () => {
    await writeSession(PID, { sessionId: NEXT_SESSION_UUID, name: 'somebody else' });

    expect(await readClaudeSessionName(directory, PID, CONVERSATION)).toBeNull();
  });
});
