import { SessionId, claudeRenameCommand, readSessionName } from '../../../packages/core/src/index';
import { SESSION_UUID, NEXT_SESSION_UUID } from '../../helpers/domain-fixtures';

const CONVERSATION = SessionId.fromString(SESSION_UUID);

/**
 * A session file as `claude` 2.1.228 wrote it, measured on 2026-08-13.
 *
 * KEPT, and not replaced by the newer shape below. This build runs against
 * whatever CLI the machine has, and on that one the name a person typed carried
 * no `nameSource` at all -- the key was REMOVED by `/rename`.
 */
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

/**
 * A session file as `claude` 2.1.260 writes it.
 *
 * The KEY NAMES are the ones measured on the owner's machine on 2026-09-08,
 * across four live sessions, and so are the two values `nameSource` was seen to
 * carry: `"derived"` in two of the four and `"user"` in the other two. It was
 * present in ALL FOUR -- there is no file of that build without it.
 *
 * The other VALUES here are invented, because the measurement recorded the names
 * and not the contents, and nothing under test reads them. `name` and
 * `nameSource` are the defect the owner hit by hand: `/rename fdfd`, the CLI
 * answered `Session renamed to: fdfd`, and the row kept its old name.
 */
function today(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    pid: 17100,
    sessionId: SESSION_UUID,
    cwd: 'D:\\Projects\\foo',
    startedAt: 1786624502528,
    procStart: '134310981001182007',
    version: '2.1.260',
    peerProtocol: 1,
    peerFeatures: [],
    kind: 'interactive',
    entrypoint: 'cli',
    pidDomain: 'local',
    messagingSocketPath: null,
    name: 'fdfd',
    nameSource: 'user',
    nameSince: 1786624506000,
    status: 'idle',
    updatedAt: 1786624506087,
    statusUpdatedAt: 1786624506087,
    bridgeSessionId: null,
    ...overrides,
  });
}

describe('the name Claude Code has for a conversation', () => {
  it('is read when the CLI says a person chose it', () => {
    // The defect, found by hand on 2026-09-08 against 2.1.260: `nameSource` is
    // now always present and carries the answer, so a rule that refused the file
    // whenever the key existed refused every name the CLI writes.
    expect(readSessionName(today(), CONVERSATION)).toBe('fdfd');
  });

  it('is read when the file names no source at all, the way older builds wrote it', () => {
    // 2.1.228, measured 2026-08-13: `/rename` REMOVED the key, so absence was
    // the whole of the evidence that a person had typed the name. Every CLI old
    // enough writes such a file, and they are still read.
    expect(readSessionName(file(), CONVERSATION)).toBe('the name a person typed');
  });

  it('is refused when the CLI derived it from the folder', () => {
    // The point of the function, and unchanged by either measurement: putting
    // `trudocker-50` on the row would replace a name chosen for the person --
    // and chosen to be unique in the window -- with one that is neither.
    expect(readSessionName(file({ nameSource: 'derived' }), CONVERSATION)).toBeNull();
    expect(
      readSessionName(today({ nameSource: 'derived', name: 'trudocker-50' }), CONVERSATION)
    ).toBeNull();
  });

  it('is refused when the source is one this build has never met', () => {
    // Only `user` is evidence of a person. A source we cannot read falls the way
    // every unknown in this project falls: towards leaving the name alone.
    expect(readSessionName(file({ nameSource: 'imported' }), CONVERSATION)).toBeNull();
    expect(readSessionName(today({ nameSource: 'imported' }), CONVERSATION)).toBeNull();
  });

  it('is refused when the source is present but says nothing', () => {
    // `null` is a value the CLI could start writing tomorrow, and an empty string
    // says as little about a person as an unknown word does.
    expect(readSessionName(today({ nameSource: null }), CONVERSATION)).toBeNull();
    expect(readSessionName(today({ nameSource: '' }), CONVERSATION)).toBeNull();
  });

  it('is refused when the file is about another conversation, whoever chose the name', () => {
    // The file is found by pid, and a pid is reused. The conversation id is what
    // makes a stale file harmless, and the new marker does not weaken it.
    expect(readSessionName(file({ sessionId: NEXT_SESSION_UUID }), CONVERSATION)).toBeNull();
    expect(readSessionName(today({ sessionId: NEXT_SESSION_UUID }), CONVERSATION)).toBeNull();
  });

  it('is refused when the file names no conversation at all', () => {
    expect(readSessionName(file({ sessionId: undefined }), CONVERSATION)).toBeNull();
    expect(readSessionName(today({ sessionId: undefined }), CONVERSATION)).toBeNull();
  });

  it('is refused when there is no name in it, whoever chose it', () => {
    expect(readSessionName(file({ name: undefined }), CONVERSATION)).toBeNull();
    expect(readSessionName(file({ name: '   ' }), CONVERSATION)).toBeNull();
    expect(readSessionName(file({ name: 42 }), CONVERSATION)).toBeNull();
    expect(readSessionName(today({ name: undefined }), CONVERSATION)).toBeNull();
    expect(readSessionName(today({ name: '   ' }), CONVERSATION)).toBeNull();
    expect(readSessionName(today({ name: 42 }), CONVERSATION)).toBeNull();
  });

  it('is trimmed, because it becomes a row a person reads', () => {
    expect(readSessionName(file({ name: '  spaced  ' }), CONVERSATION)).toBe('spaced');
    expect(readSessionName(today({ name: '  spaced  ' }), CONVERSATION)).toBe('spaced');
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

/**
 * The other direction (M2.19): what has to be TYPED into a conversation to give
 * it the name its row now has. There is no other channel -- the CLI takes a
 * name at startup and from `/rename`, and nothing else.
 */
describe('the line that renames a conversation from the outside', () => {
  it('is the command a person would type', () => {
    expect(claudeRenameCommand('auth work')).toBe('/rename auth work');
  });

  it('never contains a newline, whatever the name holds', () => {
    // This line is typed into a terminal and a newline SENDS it. A name with one
    // in it would send `/rename` with half the name and then submit the rest as
    // a message -- a turn spent, and a line nobody wrote in the transcript.
    expect(claudeRenameCommand('two\nlines')).toBe('/rename two lines');
    expect(claudeRenameCommand('tab\there')).toBe('/rename tab here');
  });

  it('is trimmed, because the name came from a box a person typed in', () => {
    expect(claudeRenameCommand('  spaced  ')).toBe('/rename spaced');
  });
});
