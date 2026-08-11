import { randomUUID } from 'node:crypto';
import type { IdGenerator } from '../domain/ports/id-generator';

/**
 * The `IdGenerator` port on the platform's own generator. What M1 runs on; the
 * stub that hands out a written-down sequence lives in `tests/helpers`.
 *
 * `node:crypto` rather than a hand-rolled uuid, because these ids are not
 * decoration: a terminal id is a directory name and an address in a URL, and a
 * session id is what `claude --session-id` is told the conversation is called.
 * A collision between two windows is a conversation adopted by the wrong record.
 *
 * The one place in the shipped code where a random id is minted, and a named
 * type makes that greppable -- the same reason `SystemClock` exists.
 */
export class SystemIdGenerator implements IdGenerator {
  public newUuid(): string {
    return randomUUID();
  }
}
