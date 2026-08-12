import { readFile } from 'node:fs/promises';
import { writeAtomic } from './atomic-file';

/** Two spaces, because the single argument for a file over a database is that a person can open it. */
const JSON_INDENT = 2;

/**
 * What was at a path.
 *
 * Three answers rather than a value and an exception, because the caller treats
 * them differently and must not be able to forget one: an absent record is a
 * terminal that was never written, an unreadable one is a terminal to report
 * and step over, and neither is an error worth unwinding a whole read for.
 */
export type JsonRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'value', readonly value: unknown }
  | { readonly kind: 'unreadable', readonly reason: string };

/**
 * Reads one JSON file, and never throws.
 *
 * A file the file system refuses and a file whose contents are not JSON are
 * both `unreadable`: from the caller's position they are the same event -- this
 * record cannot be used, say so and carry on -- and distinguishing them would
 * buy a branch nobody acts on differently.
 */
export async function readJsonFile(path: string): Promise<JsonRead> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause: unknown) {
    return (cause as { readonly code?: unknown }).code === 'ENOENT'
      ? { kind: 'absent' }
      : { kind: 'unreadable', reason: String(cause) };
  }

  try {
    return { kind: 'value', value: JSON.parse(text) };
  } catch (cause: unknown) {
    return { kind: 'unreadable', reason: String(cause) };
  }
}

/**
 * Replaces one JSON file, whole or not at all.
 *
 * The trailing newline is not decoration: a file without one appends badly in
 * every terminal a person might `cat` it in, and this store's whole reason for
 * being files is that a person can open them.
 */
export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeAtomic(path, `${JSON.stringify(value, null, JSON_INDENT)}\n`);
}
