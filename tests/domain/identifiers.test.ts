import {
  OwnerId,
  SessionId,
  TerminalId,
  ValidationError,
  isErrorOfCode,
} from '../../packages/core/src/index';
import {
  SESSION_UUID,
  TERMINAL_UUID,
  captureError,
  stubIdGenerator,
} from '../helpers/domain-fixtures';

describe('TerminalId', () => {
  it('accepts a UUID', () => {
    expect(TerminalId.fromString(TERMINAL_UUID).value).toBe(TERMINAL_UUID);
  });

  it('lowercases, so that two spellings of one id are one key', () => {
    const upper = TerminalId.fromString(TERMINAL_UUID.toUpperCase());

    expect(upper.value).toBe(TERMINAL_UUID);
    expect(upper.equals(TerminalId.fromString(TERMINAL_UUID))).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['not hexadecimal', 'zzzzzzzz-e29b-41d4-a716-446655440000'],
    ['wrong grouping', '550e8400e29b41d4a716446655440000'],
    ['truncated', '550e8400-e29b-41d4-a716'],
    ['surrounded by spaces', ` ${TERMINAL_UUID} `],
  ])('rejects a value that is %s', (_label, raw) => {
    expect(() => TerminalId.fromString(raw)).toThrow(ValidationError);
    expect(isErrorOfCode(captureError(() => TerminalId.fromString(raw)), 'VALIDATION_ERROR')).toBe(
      true
    );
  });

  it('mints from a generator, and validates what the generator returned', () => {
    expect(TerminalId.create(stubIdGenerator(TERMINAL_UUID)).value).toBe(TERMINAL_UUID);
    expect(() => TerminalId.create(stubIdGenerator('not-a-uuid'))).toThrow(ValidationError);
  });

  it('compares by value, and prints as its value', () => {
    const id = TerminalId.fromString(TERMINAL_UUID);

    expect(id.equals(TerminalId.fromString(TERMINAL_UUID))).toBe(true);
    expect(id.equals(TerminalId.fromString(SESSION_UUID))).toBe(false);
    expect(id.toString()).toBe(TERMINAL_UUID);
  });

  it('is frozen', () => {
    const id = TerminalId.fromString(TERMINAL_UUID);

    expect(Object.isFrozen(id)).toBe(true);
    expect(() => {
      (id as unknown as { value: string }).value = SESSION_UUID;
    }).toThrow(TypeError);
  });
});

describe('SessionId', () => {
  it('accepts, lowercases and compares like TerminalId', () => {
    const id = SessionId.fromString(SESSION_UUID.toUpperCase());

    expect(id.value).toBe(SESSION_UUID);
    expect(id.equals(SessionId.fromString(SESSION_UUID))).toBe(true);
    expect(id.equals(SessionId.fromString(TERMINAL_UUID))).toBe(false);
    expect(id.toString()).toBe(SESSION_UUID);
    expect(Object.isFrozen(id)).toBe(true);
  });

  it('rejects a non-UUID', () => {
    expect(() => SessionId.fromString('session-1')).toThrow(ValidationError);
  });

  it('mints from a generator: we supply the id at launch with --session-id', () => {
    expect(SessionId.create(stubIdGenerator(SESSION_UUID)).value).toBe(SESSION_UUID);
  });
});

describe('the separation of the two id types', () => {
  it('is enforced by the compiler, not by review', () => {
    const terminalId = TerminalId.fromString(TERMINAL_UUID);
    const sessionId = SessionId.fromString(SESSION_UUID);

    // These two lines are the test. Each is a compile error, and a stale
    // `@ts-expect-error` is itself an error -- so if the nominal marker on
    // either class were ever removed, this file would stop compiling and the
    // suite would fail. Nothing is asserted at runtime because there is
    // nothing to assert: the mistake cannot reach runtime at all.
    // @ts-expect-error a SessionId is not a TerminalId
    terminalId.equals(sessionId);
    // @ts-expect-error a TerminalId is not a SessionId
    sessionId.equals(terminalId);

    expect(terminalId.value).not.toBe(sessionId.value);
  });
});

describe('OwnerId', () => {
  it('accepts any non-blank string: an activation id has no shape we control', () => {
    expect(OwnerId.fromString('window-activation-1').value).toBe('window-activation-1');
  });

  it('trims, and refuses a blank value', () => {
    expect(OwnerId.fromString('  spaced  ').value).toBe('spaced');
    expect(() => OwnerId.fromString('   ')).toThrow(ValidationError);
    expect(() => OwnerId.fromString('')).toThrow(ValidationError);
  });

  it('compares by value and is frozen', () => {
    const id = OwnerId.fromString('a');

    expect(id.equals(OwnerId.fromString('a'))).toBe(true);
    expect(id.equals(OwnerId.fromString('b'))).toBe(false);
    expect(id.toString()).toBe('a');
    expect(Object.isFrozen(id)).toBe(true);
  });
});
