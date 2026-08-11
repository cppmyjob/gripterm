import {
  ClaudeCliError,
  ConflictError,
  GriptermError,
  LaunchError,
  ListenError,
  MigrationError,
  NotFoundError,
  ResumeFailedError,
  StorageError,
  ValidationError,
  isErrorOfCode,
  isGriptermError,
  type ErrorCode,
} from '../../packages/core/src/index';

type ErrorFactory = (message: string) => GriptermError;

const HIERARCHY: readonly (readonly [string, ErrorCode, ErrorFactory])[] = [
  ['ValidationError', 'VALIDATION_ERROR', (m): GriptermError => new ValidationError(m)],
  ['NotFoundError', 'NOT_FOUND', (m): GriptermError => new NotFoundError(m)],
  ['ConflictError', 'CONFLICT', (m): GriptermError => new ConflictError(m)],
  ['StorageError', 'STORAGE_ERROR', (m): GriptermError => new StorageError(m)],
  ['MigrationError', 'MIGRATION_ERROR', (m): GriptermError => new MigrationError(m)],
  ['LaunchError', 'LAUNCH_ERROR', (m): GriptermError => new LaunchError(m)],
  ['ResumeFailedError', 'RESUME_FAILED', (m): GriptermError => new ResumeFailedError(m)],
  ['ClaudeCliError', 'CLAUDE_CLI_ERROR', (m): GriptermError => new ClaudeCliError(m)],
  ['ListenError', 'LISTEN_ERROR', (m): GriptermError => new ListenError(m)],
];

/**
 * Exhaustiveness, checked by the COMPILER rather than by a count.
 *
 * The suite used to assert only that the table had no duplicates, which is true
 * of a table missing an entry as well. A code added to the union without a class
 * would have passed silently -- and a code with no class is an error nobody can
 * throw, discovered by whoever needed it.
 */
const EVERY_CODE: Readonly<Record<ErrorCode, true>> = {
  VALIDATION_ERROR: true,
  NOT_FOUND: true,
  CONFLICT: true,
  STORAGE_ERROR: true,
  MIGRATION_ERROR: true,
  LAUNCH_ERROR: true,
  RESUME_FAILED: true,
  CLAUDE_CLI_ERROR: true,
  LISTEN_ERROR: true,
};

describe('the error hierarchy', () => {
  it.each(HIERARCHY)('%s carries the code %s and its own name', (name, code, make) => {
    const error = make('something went wrong');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(GriptermError);
    expect(error.name).toBe(name);
    expect(error.code).toBe(code);
    expect(error.message).toBe('something went wrong');
  });

  it.each(HIERARCHY)('%s keeps a working prototype chain, so catch can tell it apart', (_n, _c, make) => {
    const error = make('boom');

    // The reason `Object.setPrototypeOf` is in the base constructor: without it
    // this is `GriptermError.prototype` and every subclass looks alike.
    expect(Object.getPrototypeOf(error)).not.toBe(GriptermError.prototype);
    expect(isGriptermError(error)).toBe(true);
  });

  it('covers every declared code exactly once', () => {
    const codes = HIERARCHY.map(([, code]) => code);
    expect(new Set(codes).size).toBe(codes.length);
    // `EVERY_CODE` fails to COMPILE when a member of the union has no entry;
    // this line closes the other direction -- a class in the table whose code
    // is no longer part of the union.
    expect([...codes].sort()).toStrictEqual(Object.keys(EVERY_CODE).sort());
  });
});

describe('details', () => {
  it('defaults to an empty object rather than undefined', () => {
    expect(new ValidationError('x').details).toStrictEqual({});
  });

  it('is frozen, and a copy of what was passed in', () => {
    const details = { field: 'cwd' };
    const error = new ValidationError('x', { details });

    details.field = 'mutated afterwards';

    expect(error.details.field).toBe('cwd');
    expect(() => {
      (error.details as Record<string, unknown>).field = 'mutated through the error';
    }).toThrow(TypeError);
  });
});

describe('cause', () => {
  it('is kept without the message being wrapped', () => {
    const origin = new Error('ENOENT: no such file');
    const error = new StorageError('cannot read the record', { cause: origin });

    // The planner lesson, made checkable: no "error: error" messages.
    expect(error.message).toBe('cannot read the record');
    expect(error.cause).toBe(origin);
  });

  it('is absent when none was given', () => {
    expect(new StorageError('x').cause).toBeUndefined();
  });
});

describe('toJSON', () => {
  it('serializes the four fields a log line needs', () => {
    const error = new ConflictError('revision moved', { details: { expected: 3 } });

    expect(error.toJSON()).toStrictEqual({
      name: 'ConflictError',
      code: 'CONFLICT',
      message: 'revision moved',
      details: { expected: 3 },
    });
  });

  it('survives JSON.stringify, which is how it reaches a log', () => {
    const round = JSON.stringify(new NotFoundError('no such terminal'));
    expect(JSON.parse(round)).toMatchObject({ code: 'NOT_FOUND', name: 'NotFoundError' });
  });
});

describe('isErrorOfCode', () => {
  it('narrows by code rather than by class', () => {
    const error: unknown = new ConflictError('revision moved');

    expect(isErrorOfCode(error, 'CONFLICT')).toBe(true);
    expect(isErrorOfCode(error, 'NOT_FOUND')).toBe(false);
  });

  it('rejects anything that is not one of ours', () => {
    expect(isGriptermError(new Error('plain'))).toBe(false);
    expect(isGriptermError('CONFLICT')).toBe(false);
    expect(isGriptermError(null)).toBe(false);
    expect(isErrorOfCode({ code: 'CONFLICT' }, 'CONFLICT')).toBe(false);
  });
});
