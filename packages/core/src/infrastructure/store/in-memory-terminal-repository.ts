import { ConflictError, NotFoundError } from '../../domain/errors/gripterm-error';
import type { Disposable } from '../../domain/ports/disposable';
import type { OwnerId } from '../../domain/entities/owner-id';
import type { OwnerRef } from '../../domain/entities/owner-ref';
import type { TerminalEntry } from '../../domain/entities/terminal-entry';
import type { TerminalId } from '../../domain/entities/terminal-id';
import type {
  RepositoryListener,
  TerminalRepository,
} from '../../domain/repositories/terminal-repository';

/**
 * The M1 base: a map that lives as long as the window does.
 *
 * Not a test double -- this is what M1 ships with, and M2 replaces it with a
 * directory of files without the domain noticing. Its one structural property
 * decides most of the behaviour below: **an in-memory base has exactly one
 * owner**, the process holding it, because nothing else can reach the map.
 *
 * That is why `write` refuses a foreign entry outright. The single-writer rule
 * allows writing someone else's record only after adopting it, and adoption
 * makes the record ours, so "foreign" and "writable" never overlap.
 */
export class InMemoryTerminalRepository implements TerminalRepository {
  private readonly _owner: OwnerRef;
  private readonly _entries = new Map<string, TerminalEntry>();
  private readonly _listeners = new Set<RepositoryListener>();

  constructor(owner: OwnerRef) {
    this._owner = owner;
  }

  public async readOwn(ownerId: OwnerId): Promise<readonly TerminalEntry[]> {
    return [...this._entries.values()].filter((entry) => entry.owner.ownerId.equals(ownerId));
  }

  public async readAll(): Promise<readonly TerminalEntry[]> {
    return [...this._entries.values()];
  }

  public async write(entry: TerminalEntry): Promise<void> {
    if (!entry.owner.ownerId.equals(this._owner.ownerId)) {
      throw new ConflictError('only the owning window may write an entry', {
        details: { terminalId: entry.terminalId.value, owner: entry.owner.ownerId.value },
      });
    }
    this._entries.set(entry.terminalId.value, entry);
    this._notify();
  }

  /**
   * Implemented to the letter and refused in practice, which is the honest
   * outcome rather than a gap.
   *
   * The precondition checks are real: an unknown id is `NotFoundError`, a moved
   * revision is `ConflictError`. Past them the aggregate has the last word, and
   * it says no -- every entry in this base belongs to this process, and an
   * entry cannot be adopted by its current owner. There is nothing here to take
   * over, so refusing loudly beats pretending. `AdoptOptions` is absent from
   * the signature for the same reason: `force` decides what to do about an
   * owner whose liveness is `unknown`, and this base has no other owners.
   */
  public async adopt(id: TerminalId, expected: number): Promise<TerminalEntry> {
    const entry = this._require(id);
    if (entry.revision !== expected) {
      throw new ConflictError('the entry moved while it was being adopted', {
        details: { terminalId: id.value, expected, actual: entry.revision },
      });
    }
    return entry.adoptedBy(this._owner);
  }

  /**
   * No trash, and none is owed. The file store keeps a discarded record because
   * it would otherwise be gone for good; this base dies with the window that
   * holds it, so everything in it is discarded a few hours later anyway.
   */
  public async remove(id: TerminalId): Promise<void> {
    this._require(id);
    this._entries.delete(id.value);
    this._notify();
  }

  public watch(listener: RepositoryListener): Disposable {
    this._listeners.add(listener);
    return {
      dispose: (): void => {
        this._listeners.delete(listener);
      },
    };
  }

  private _require(id: TerminalId): TerminalEntry {
    const entry = this._entries.get(id.value);
    if (entry === undefined) {
      throw new NotFoundError('no entry with that terminal id', {
        details: { terminalId: id.value },
      });
    }
    return entry;
  }

  /**
   * Listeners run after the map is already updated, and their errors propagate.
   *
   * Swallowing one would be a silent drop with nowhere to report it -- this
   * class has no logger and should not acquire one. Running them last means a
   * throwing listener is loud without leaving the base half-written.
   */
  private _notify(): void {
    for (const listener of this._listeners) {
      listener();
    }
  }
}
