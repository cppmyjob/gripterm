import type { ErrorDetails } from '../errors/gripterm-error';

/** Stands in for a value that has already appeared in this line -- accurate whether or not the graph is a cycle. */
const REPEATED = '[seen above]';

const UNRENDERABLE = '[the details of this line could not be rendered]';

/**
 * Turns a log line's structured context into text, without ever throwing.
 *
 * It exists because the naive spelling loses exactly what matters. Half the
 * call sites in this codebase log a `cause`, `JSON.stringify` has no idea what
 * an `Error` is, and the result is `{"cause":{}}` -- the sentence that would
 * have explained the failure, silently replaced by an empty object on the one
 * path nobody is watching. Two more shapes make it worse: a `bigint` makes
 * `JSON.stringify` THROW, and a throw here happens while reporting a failure,
 * which is the worst possible moment to acquire a second one.
 *
 * A `GriptermError` needs no help: it carries `toJSON`, which `JSON.stringify`
 * applies before the replacer ever sees it. Its stack is deliberately absent
 * there and stays absent here -- it says where it is by its `code` and
 * `details`. An unexpected error says nothing without its stack, so that one
 * keeps it.
 */
export function describeDetails(details: ErrorDetails | undefined): string {
  if (details === undefined || Object.keys(details).length === 0) {
    return '';
  }
  const seen = new WeakSet();
  try {
    // Never `undefined`: that is what `JSON.stringify` returns when the ROOT
    // renders to nothing, and the root here is an object with keys.
    return JSON.stringify(details, (_key: string, value: unknown) => render(value, seen));
  } catch {
    // Reached only by a shape neither the replacer nor `JSON.stringify` can
    // take. Losing the context is bad; losing the message it belonged to,
    // because the logger threw, is worse.
    return UNRENDERABLE;
  }
}

function render(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Error) {
    return describeError(value, seen);
  }
  if (typeof value === 'object' && value !== null) {
    if (seen.has(value)) {
      return REPEATED;
    }
    seen.add(value);
  }
  return value;
}

function describeError(error: Error, seen: WeakSet<object>): Readonly<Record<string, unknown>> {
  if (seen.has(error)) {
    return { repeated: REPEATED };
  }
  seen.add(error);
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    // The chain, when there is one. `cause` is `unknown` by type and an error
    // by convention, so it goes back through the same door rather than being
    // trusted to be one.
    cause: error.cause === undefined ? undefined : render(error.cause, seen),
  };
}
