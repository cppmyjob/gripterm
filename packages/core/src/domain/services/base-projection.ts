import type { Disposable } from '../ports/disposable';
import type { Logger } from '../ports/logger';
import type { OwnerRef } from '../entities/owner-ref';
import type { SessionRegistry } from './session-registry';
import type { TerminalEntry } from '../entities/terminal-entry';
import type { TerminalRepository } from '../repositories/terminal-repository';

export interface BaseProjectionOptions {
  readonly repository: TerminalRepository;
  readonly registry: SessionRegistry;
  /** This activation. Records carrying it are ours, and never read back in. */
  readonly owner: OwnerRef;
  readonly logger: Logger;
}

/**
 * The missing joint: a signal that the base changed becomes a list on screen.
 *
 * `fs.watch` -> `readAll()` -> `replaceForeign` -> the tree (§4.6). Every part of
 * that chain existed before this class and none of them was connected to the
 * next, which is why П4 could not redraw for a change made in another window.
 *
 * Two rules, and both are about a read taking time:
 *
 *   * **Never two reads at once.** Not for the cost -- a read of a dozen small
 *     files is nothing -- but because two of them can finish in the wrong order,
 *     and the older result would then overwrite the newer one. The list would be
 *     stale with no event left to correct it, which is the exact failure the
 *     watcher exists to prevent.
 *   * **A read that finishes after the window is gone is dropped.** Disposal is
 *     the last thing a window does; handing a projection to a registry nobody is
 *     drawing any more is at best wasted, and at worst a listener firing during
 *     teardown.
 *
 * A failure to read is reported and survived. The alternative -- letting it
 * escape from a callback that nobody awaits -- is an unhandled rejection in the
 * extension host, which the person sees as the editor complaining about us.
 */
export class BaseProjection implements Disposable {
  private _reading = false;
  private _again = false;
  private _stopped = false;

  constructor(private readonly _options: BaseProjectionOptions) {}

  /**
   * Re-reads the base and hands it to the registry.
   *
   * Awaited by tests and by nobody else: its callers are event handlers, which
   * is why every failure inside is dealt with here rather than returned.
   */
  public async refresh(): Promise<void> {
    if (this._reading) {
      // Something changed while we were reading, so what we are about to hand
      // over is already old. Remembered as one more pass rather than as a
      // queue: the signal carries no delta, so two pending reads and ten are
      // the same instruction.
      this._again = true;
      return;
    }

    this._reading = true;
    try {
      do {
        await this._readOnce();
      } while (this._takeAgain());
    } finally {
      this._reading = false;
    }
  }

  public dispose(): void {
    this._stopped = true;
  }

  /**
   * Whether anything was asked for while the last read was running, taking the
   * request as it answers.
   *
   * A method rather than two lines in the loop above, and not for tidiness: read
   * inline, the flag has just been assigned in the same function, so the
   * compiler is entitled to believe it cannot have changed -- and the loop that
   * exists precisely because it CAN change would be flagged as a condition that
   * is always false.
   */
  private _takeAgain(): boolean {
    const again = this._again;
    this._again = false;
    return again;
  }

  /**
   * A record written by THIS activation, which is never taken back from disk.
   *
   * The registry already skips ids it holds, and until M2.7 that was enough. It
   * stopped being enough the moment a record could be deleted: between the
   * person pressing delete and the removal reaching the files, the record is in
   * neither collection and the base still has it -- so a read landing in that
   * gap would hand it back as somebody else's terminal, in the very window that
   * had just thrown it away.
   *
   * Exact rather than approximate, because `ownerId` names an ACTIVATION and not
   * a window: no record from an earlier run of this editor can carry it, and a
   * record another window has adopted carries theirs. What this filter says is
   * therefore the literal truth -- about our own records, memory is the source
   * and the disk is a copy (§4.8).
   */
  private _isOurs(entry: TerminalEntry): boolean {
    return entry.owner.ownerId.equals(this._options.owner.ownerId);
  }

  private async _readOnce(): Promise<void> {
    try {
      const all = await this._options.repository.readAll();
      if (this._stopped) {
        // The window went while this was reading. Dropping the RESULT rather
        // than refusing to start the read is the check that costs nothing to
        // get right: there is exactly one place a projection can be handed
        // over, and it is this line.
        return;
      }
      this._options.registry.replaceForeign(all.filter((entry) => !this._isOurs(entry)));
    } catch (cause: unknown) {
      this._options.logger.error(
        'the store could not be read, so the list may be missing what other windows are doing',
        { cause }
      );
    }
  }
}
