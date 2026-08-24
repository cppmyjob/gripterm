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
  if (isError(value)) {
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

/**
 * The four an `Error` answers for itself, so that a property of the same name
 * carried on the object cannot overwrite one of them.
 */
const OWN_TO_ERROR: ReadonlySet<string> = new Set(['name', 'message', 'stack', 'cause']);

function describeError(error: Error, seen: WeakSet<object>): Readonly<Record<string, unknown>> {
  if (seen.has(error)) {
    return { repeated: REPEATED };
  }
  seen.add(error);
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    // What a person cannot see and a program acts on: `code`, `errno`, `syscall`
    // and `path` on a file system failure, and whatever else the thrower
    // attached. `message` and `stack` are non-enumerable on an `Error`, so this
    // picks up the added fields and nothing that is already spelled out above.
    //
    // It is the reason `String(cause)` was wrong at the forty-nine call sites
    // that LOG a cause -- of sixty-five in all; the other sixteen feed a
    // `reason: string` somebody reads. The string renders the SENTENCE and
    // throws away the code, and `code` is what every branch in this build that
    // reacts to a failure reads, so a log written from the string cannot be
    // compared with the decision the code took.
    ...ownProperties(error, seen),
    // The chain, when there is one. `cause` is `unknown` by type and an error
    // by convention, so it goes back through the same door rather than being
    // trusted to be one.
    cause: error.cause === undefined ? undefined : render(error.cause, seen),
  };
}

/**
 * Whether a value is an error, INCLUDING one made somewhere else.
 *
 * `instanceof` is not enough and this was measured rather than reasoned about
 * (2026-08-24): under jest's `node` environment an `fs.watch` ENOENT fails
 * `instanceof Error`, because the suite runs in a vm context whose `Error` is a
 * different function from the one Node's internals built the error with. The
 * same split exists wherever a value crosses a realm.
 *
 * What it costs is precisely the sentence. `name`, `message` and `stack` are
 * non-enumerable on an error, so one that misses this branch is serialised down
 * to whatever was added to it -- `code`, `errno` -- and the line explaining the
 * failure disappears on the one path nobody is watching, which is the defect
 * this whole file exists against.
 *
 * `Object.prototype.toString` reads the internal tag, which crosses a realm.
 */
function isError(value: unknown): value is Error {
  return value instanceof Error || Object.prototype.toString.call(value) === '[object Error]';
}

function ownProperties(error: Error, seen: WeakSet<object>): Readonly<Record<string, unknown>> {
  const extra: Record<string, unknown> = {};
  for (const key of Object.keys(error)) {
    if (!OWN_TO_ERROR.has(key)) {
      extra[key] = render((error as unknown as Record<string, unknown>)[key], seen);
    }
  }
  return extra;
}
