import { SessionId, readSessionName } from '../../../packages/core/src/index';
import { SESSION_UUID, NEXT_SESSION_UUID } from '../../helpers/domain-fixtures';

const CONVERSATION = SessionId.fromString(SESSION_UUID);

/** A session file as the CLI writes it, measured on 2026-08-13 against 2.1.228. */
function file(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    pid: 17100,
    sessionId: SESSION_UUID,
    cwd: 'D:\\Projects\\foo',
    startedAt: 1786624502528,
    procStart: '134310981001182007',
    version: '2.1.228',
    peerProtocol: 1,
    kind: 'interactive',
    entrypoint: 'cli',
    name: 'the name a person typed',
    status: 'idle',
    updatedAt: 1786624506087,
    ...overrides,
  });
}

describe('the name Claude Code has for a conversation', () => {
  it('is read when a person gave it', () => {
    expect(readSessionName(file(), CONVERSATION)).toBe('the name a person typed');
  });

  it('is refused when the CLI derived it from the folder', () => {
    // Measured: a fresh session carries `nameSource: "derived"`, and `/rename`
    // REMOVES the key. Taking a derived name would replace the row's own name
    // with `trudocker-50` -- worse than what it had, and unasked for.
    expect(readSessionName(file({ nameSource: 'derived' }), CONVERSATION)).toBeNull();
  });

  it('is refused when the source is one this build has never met', () => {
    // Absence is the whole of the evidence, so anything present is not it. A
    // source we cannot read falls the same way every unknown in this project
    // falls: towards leaving the person's name alone.
    expect(readSessionName(file({ nameSource: 'imported' }), CONVERSATION)).toBeNull();
  });

  it('is refused when the file is about another conversation', () => {
    // The file is found by pid, and a pid is reused. The conversation id is what
    // makes a stale file harmless.
    expect(readSessionName(file({ sessionId: NEXT_SESSION_UUID }), CONVERSATION)).toBeNull();
  });

  it('is refused when the file names no conversation at all', () => {
    expect(readSessionName(file({ sessionId: undefined }), CONVERSATION)).toBeNull();
  });

  it('is refused when there is no name in it', () => {
    expect(readSessionName(file({ name: undefined }), CONVERSATION)).toBeNull();
    expect(readSessionName(file({ name: '   ' }), CONVERSATION)).toBeNull();
    expect(readSessionName(file({ name: 42 }), CONVERSATION)).toBeNull();
  });

  it('is trimmed, because it becomes a row a person reads', () => {
    expect(readSessionName(file({ name: '  spaced  ' }), CONVERSATION)).toBe('spaced');
  });

  it('is refused when the file is not JSON at all', () => {
    expect(readSessionName('', CONVERSATION)).toBeNull();
    expect(readSessionName('{ half', CONVERSATION)).toBeNull();
  });

  it('is refused when the JSON is not an object', () => {
    expect(readSessionName('[]', CONVERSATION)).toBeNull();
    expect(readSessionName('7', CONVERSATION)).toBeNull();
    expect(readSessionName('null', CONVERSATION)).toBeNull();
  });
});
