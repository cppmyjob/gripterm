/**
 * Total readers over `unknown`, for every place where JSON arrives from outside
 * this process: a settings file somebody edited, a record written by a build
 * that is not this one, a half-migrated store.
 *
 * One module rather than a private copy per caller, because these encode the
 * project's answer to "what counts as a string", and two copies drift: an
 * earlier pair disagreed about whether an array is an object to look keys up in,
 * which is exactly the kind of difference nobody notices until a record is
 * silently read as empty.
 *
 * Every function is total -- it answers for any input, including `undefined`,
 * `NaN` and a `Proxy` -- and says no by returning `null` rather than by
 * throwing. Callers that need a reason build it; callers that only need a value
 * use `??`.
 */

/**
 * An object to look keys up in. An array is NOT one.
 *
 * The distinction was measured to be dead in the hook-policy review (a JSON
 * array cannot carry a named key, so every lookup finds `undefined` either way)
 * and is alive here: a `record.json` containing `[]` has to be reported as
 * malformed, not read as a record with every field missing, because the two
 * produce different sentences for the person who has to fix it.
 */
export function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/**
 * A number that can be stored and compared. `NaN` and the infinities are not.
 *
 * `JSON.parse` never produces them, but `JSON.stringify` turns all three into
 * `null`, so a value that became one on the way IN is already lost -- and a
 * reader that accepted them would carry the loss further as a timestamp that
 * compares false against itself.
 */
export function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function asArray(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? (value as readonly unknown[]) : null;
}

export function asStringArray(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
}

/**
 * An object whose every value is a string -- an environment block, say.
 *
 * Rejects the whole map on the first value that is not, rather than dropping
 * that entry: a launch recipe missing one variable starts a terminal that
 * behaves almost right, which is harder to diagnose than one that refuses.
 */
export function asStringMap(value: unknown): Readonly<Record<string, string>> | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  return Object.values(record).every((item) => typeof item === 'string')
    ? (record as Readonly<Record<string, string>>)
    : null;
}
