import { runInNewContext } from 'node:vm';
import { StorageError, describeDetails } from '../../packages/core/src/index';

/**
 * The one function in the codebase that runs while something else is already
 * going wrong. Every case below is a way for a log line to arrive emptied of
 * the thing it was written to carry -- or not to arrive at all.
 */

describe('describeDetails renders what a log line carries', () => {
  it('says nothing when there is nothing to say', () => {
    expect(describeDetails(undefined)).toBe('');
    expect(describeDetails({})).toBe('');
  });

  it('keeps ordinary structured context', () => {
    expect(describeDetails({ terminalId: 'abc', attempts: 5, ok: false })).toBe(
      '{"terminalId":"abc","attempts":5,"ok":false}'
    );
  });

  it('does not lose the message of a plain Error', () => {
    // The defect this function exists for: `JSON.stringify` renders an Error as
    // `{}`, so the sentence explaining the failure disappears on exactly the
    // path nobody is watching.
    //
    // Asserted on the PARSED shape, not on the text. A mutant showed why: the
    // stack begins with "Error: the socket went away", so a `toContain` passes
    // even when the message field has been dropped entirely.
    const rendered = JSON.parse(describeDetails({ cause: new Error('the socket went away') })) as {
      readonly cause: { readonly name: string, readonly message: string };
    };

    expect(rendered.cause.message).toBe('the socket went away');
    expect(rendered.cause.name).toBe('Error');
  });

  it('keeps the stack of an unexpected error', () => {
    const rendered = describeDetails({ cause: new TypeError('x is not a function') });

    expect(rendered).toContain('TypeError');
    expect(rendered).toContain('log-details.test.ts');
  });

  /*
   * The half of an error a person cannot see and a program acts on.
   *
   * `String(cause)` -- the spelling at forty-nine of this build's logging call
   * sites, sixty-five counting the ones that feed a `reason: string` -- renders
   * "Error: ENOENT: no such file or directory, open 'C:/x'" and throws away
   * `code`, `errno`, `syscall` and `path`. `code` is the field
   * every branch in this codebase that reacts to a file system failure reads,
   * so a log written from the string cannot be compared with the decision the
   * code took: two failures that the product treats completely differently --
   * a store that is not there and a store somebody else has locked -- reach a
   * support log looking like the same kind of sentence.
   */
  it('keeps what a person cannot see: the code an errno error carries', () => {
    const failure = Object.assign(new Error('ENOENT: no such file or directory, open C:/x'), {
      code: 'ENOENT',
      errno: -4058,
      syscall: 'open',
      path: 'C:/x',
    });

    const rendered = JSON.parse(describeDetails({ cause: failure })) as {
      readonly cause: {
        readonly code: string;
        readonly errno: number;
        readonly syscall: string;
        readonly path: string;
        readonly message: string;
      };
    };

    expect(rendered.cause.code).toBe('ENOENT');
    expect(rendered.cause.errno).toBe(-4058);
    expect(rendered.cause.syscall).toBe('open');
    expect(rendered.cause.path).toBe('C:/x');
    expect(rendered.cause.message).toBe('ENOENT: no such file or directory, open C:/x');
  });

  /*
   * An error made somewhere else, which is not a curiosity but the ordinary
   * case for the failures this build logs.
   *
   * Measured 2026-08-24, and found by a test going red for the wrong reason:
   * under jest's `node` environment an `fs.watch` ENOENT is NOT `instanceof
   * Error` -- the suite runs in a vm context whose `Error` is a different
   * function from the one Node's internals built the error with. The same split
   * exists wherever a value crosses a realm, and what it costs is exactly the
   * sentence: `name`, `message` and `stack` are non-enumerable, so an error that
   * misses the branch is serialised down to its added fields and the message
   * disappears.
   *
   * `Object.prototype.toString` carries the internal tag across a realm, which
   * `instanceof` cannot.
   */
  it('recognises an error made in another realm, message and stack included', () => {
    const alien = runInNewContext(
      'Object.assign(new TypeError("the socket went away"), { code: "ECONNRESET" })'
    ) as Error;

    expect(alien instanceof Error).toBe(false);
    const rendered = JSON.parse(describeDetails({ cause: alien })) as {
      readonly cause: {
        readonly name: string;
        readonly message: string;
        readonly stack: string;
        readonly code: string;
      };
    };

    expect(rendered.cause.name).toBe('TypeError');
    expect(rendered.cause.message).toBe('the socket went away');
    expect(rendered.cause.code).toBe('ECONNRESET');
    expect(rendered.cause.stack).toContain('TypeError');
  });

  it('follows a cause chain rather than stopping at the first link', () => {
    const root = new Error('EPERM');
    const rendered = describeDetails({ cause: new Error('could not write', { cause: root }) });

    expect(rendered).toContain('could not write');
    expect(rendered).toContain('EPERM');
  });

  it('lets a domain error render itself, stack and all left out', () => {
    // `GriptermError.toJSON` is applied by `JSON.stringify` before the replacer
    // sees anything, and it deliberately omits the stack: a coded error with
    // details says where it is without one.
    const rendered = describeDetails({
      cause: new StorageError('could not append', { details: { path: 'C:/x/events.ndjson' } }),
    });

    expect(rendered).toContain('STORAGE_ERROR');
    expect(rendered).toContain('C:/x/events.ndjson');
    expect(rendered).not.toContain('at Object');
  });
});

describe('describeDetails does not throw while something else is failing', () => {
  it('survives a bigint, which JSON.stringify refuses outright', () => {
    expect(describeDetails({ size: 9_007_199_254_740_993n })).toBe('{"size":"9007199254740993"}');
  });

  it('survives a cycle', () => {
    const looped: Record<string, unknown> = { name: 'loop' };
    looped.self = looped;

    const rendered = describeDetails({ looped });

    expect(rendered).toContain('loop');
    expect(rendered).toContain('[seen above]');
  });

  it('survives an error whose cause is itself', () => {
    const error = new Error('round and round');
    (error as { cause?: unknown }).cause = error;

    expect(describeDetails({ cause: error })).toContain('round and round');
  });

  it('says so, once, when a value defeats it entirely', () => {
    // A getter that throws is not reachable from our own call sites; it is here
    // because the promise this function makes is "never throws", and a promise
    // with an untested edge is a hope.
    const hostile = {
      get boom(): string {
        throw new Error('no');
      },
    };

    expect(describeDetails({ hostile })).toBe('[the details of this line could not be rendered]');
  });

  it('renders a repeated object once and marks the second appearance', () => {
    const shared = { id: 7 };

    expect(describeDetails({ first: shared, second: shared })).toBe(
      '{"first":{"id":7},"second":"[seen above]"}'
    );
  });
});
