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
