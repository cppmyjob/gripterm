import type { TerminalEntry } from '../entities/terminal-entry';
import type { OwnerId } from '../entities/owner-id';
import type { TerminalId } from '../entities/terminal-id';
import type { Disposable } from '../ports/disposable';

export interface AdoptOptions {
  /**
   * Adopt an owner whose liveness is `unknown` as well as one judged `dead`.
   *
   * Off by default, and it must stay that way: `unknown` is a live window with
   * a stale heartbeat, and adopting one starts a second `claude --resume` on a
   * conversation that already has one. The flag exists for the person who has
   * looked and knows the window is gone.
   */
  readonly force?: boolean;
}

/**
 * The base changed. Deliberately carries no delta.
 *
 * The file watcher behind this in M2 can lose a whole batch of events -- the
 * platform says so by handing over a `null` filename -- and a listener that
 * trusted a delta would silently miss everything in the lost batch. The only
 * safe reaction is to read again, so that is the only thing this signal says.
 */
export type RepositoryListener = () => void;

/**
 * The seam the whole layering exists for.
 *
 * In M1 an in-memory implementation stands behind it, in M2 a directory of
 * files, and if a database is ever wanted, one implementation changes and the
 * domain does not. Two parts of the shape carry rules rather than convenience:
 *
 *   * `readOwn` and `write` are separate from `readAll`, which puts the
 *     single-writer rule into the type instead of into a comment -- a caller
 *     that reads everything cannot fall into writing everything.
 *   * `adopt` is its own operation rather than a side effect of `write`,
 *     because changing owner is an operation WITH A PRECONDITION: the previous
 *     owner must be gone, and the revision must not have moved meanwhile.
 */
export interface TerminalRepository {
  readOwn: (ownerId: OwnerId) => Promise<readonly TerminalEntry[]>;
  readAll: () => Promise<readonly TerminalEntry[]>;
  /** Only for entries this window owns; anything else is refused, not merged. */
  write: (entry: TerminalEntry) => Promise<void>;
  /** Compare-and-swap on `revision`: `ConflictError` when it moved meanwhile. */
  adopt: (id: TerminalId, expected: number, options?: AdoptOptions) => Promise<TerminalEntry>;
  /**
   * Takes a record out of the base, because a person threw it away.
   *
   * What "out" means is the implementation's, and the file store's answer is
   * `trash/` rather than deletion: the record holds the task and the notes, and
   * §I.3 forbids an irreversible act without a way back that was made first. The
   * port does not promise which, because a base that is a database would answer
   * differently and both answers are honest.
   */
  remove: (id: TerminalId) => Promise<void>;
  /** Push, not polling. */
  watch: (listener: RepositoryListener) => Disposable;
}
