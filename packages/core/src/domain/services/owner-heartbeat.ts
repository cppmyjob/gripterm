import { HEARTBEAT_INTERVAL_MS } from '../ports/owner-presence';
import type { Disposable } from '../ports/disposable';
import type { Logger } from '../ports/logger';
import type { OwnerIdentity, OwnerPresence } from '../ports/owner-presence';
import type { Scheduler } from '../ports/scheduler';

export interface OwnerHeartbeatOptions {
  readonly presence: OwnerPresence;
  readonly scheduler: Scheduler;
  readonly logger: Logger;
  /** Defaults to `HEARTBEAT_INTERVAL_MS`, which is half of the contract. */
  readonly intervalMs?: number;
}

/**
 * This window saying it is here, for as long as it is.
 *
 * The whole of §4.8's liveness rests on this loop actually running: a window
 * whose heartbeat stops looks `unknown` after a minute and adoptable after
 * that, so every failure mode below was chosen for which way it errs.
 *
 *   * **A failed beat is reported and the loop goes on.** A transient write
 *     failure -- a scanner holding the file, a full disk for a moment -- must not
 *     end presence for the rest of the session, because the consequence of
 *     stopping is another window adopting terminals out from under this one.
 *   * **The timer is stopped BEFORE `retire()`**, which is the order the port
 *     demands: a beat that landed after the goodbye would recreate the file this
 *     window has just deleted, leaving a presence file with no window behind it
 *     and no timer to keep it honest.
 *   * **`stop()` is safe to call without `start()`, and twice.** It runs from
 *     `deactivate`, which is called on paths this class cannot see -- an
 *     activation that failed halfway, a reload during startup.
 *
 * It re-arms a one-shot rather than holding an interval, so that a slow write
 * cannot overlap the next beat, and so that the whole thing is testable through
 * the same `Scheduler` port as everything else with time in it.
 */
export class OwnerHeartbeat implements Disposable {
  private _timer: Disposable | null = null;
  private _announced = false;

  constructor(private readonly _options: OwnerHeartbeatOptions) {}

  /**
   * Announces this window and starts beating.
   *
   * Throws if the announcement fails, and deliberately: a window that could not
   * write its presence file is a window whose terminals other windows may
   * adopt, and the composition root has to decide what to do about that rather
   * than find out later from the consequences.
   */
  public async start(identity: OwnerIdentity): Promise<void> {
    await this._options.presence.announce(identity);
    this._announced = true;
    this._arm();
  }

  /** Stops beating and says goodbye. Idempotent, and safe before `start`. */
  public async stop(): Promise<void> {
    this._timer?.dispose();
    this._timer = null;
    if (!this._announced) {
      return;
    }
    this._announced = false;
    try {
      await this._options.presence.retire();
    } catch (cause: unknown) {
      // A presence file left behind is not a disaster: its heartbeat stops with
      // the window, so it goes stale in a minute and is collected by the
      // reconciler (M2.12). Worth a line, because the window it names will look
      // `unknown` for that minute rather than plainly gone.
      this._options.logger.warn('this window could not remove its presence file', {
        cause,
      });
    }
  }

  /** For `context.subscriptions`, which cannot await. The retirement still happens in `stop`. */
  public dispose(): void {
    this._timer?.dispose();
    this._timer = null;
  }

  private _arm(): void {
    this._timer = this._options.scheduler.after(
      this._options.intervalMs ?? HEARTBEAT_INTERVAL_MS,
      () => {
        void this._beat();
      }
    );
  }

  private async _beat(): Promise<void> {
    try {
      await this._options.presence.heartbeat();
    } catch (cause: unknown) {
      this._options.logger.warn('this window could not write its heartbeat', {
        cause,
      });
    }
    if (this._announced) {
      // Re-armed after the write and only while still announced: a beat that
      // was in flight when the window retired must not start the next one.
      this._arm();
    }
  }
}
