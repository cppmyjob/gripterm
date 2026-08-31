import { ConflictError } from '../../domain/errors/gripterm-error';
import type { OwnerId } from '../../domain/entities/owner-id';
import type {
  OwnerIdentity,
  OwnerLiveness,
  OwnerPresence,
  OwnerSurvey,
} from '../../domain/ports/owner-presence';

/**
 * Presence for a base that no other process can reach.
 *
 * M1 has no cross-window visibility, so the only window this can know about is
 * the one running it. Two answers follow from that and neither is a shortcut:
 *
 *   * A stranger is `unknown`, never `dead`. In M2's file presence a missing
 *     file does mean the window is gone; here it means only that this object
 *     has never heard of it, and answering `dead` would authorise adopting a
 *     live window's terminals -- the exact failure `unknown` exists to prevent.
 *   * `heartbeat()` refreshes nothing. A heartbeat is a message to readers in
 *     other processes, and there are none; the object answering the question is
 *     the very process the question is about. It still refuses to run before
 *     `announce`, so a lifecycle mistake is loud rather than silently absorbed.
 */
export class InMemoryOwnerPresence implements OwnerPresence {
  private _identity: OwnerIdentity | null = null;
  private _retired = false;

  public async announce(identity: OwnerIdentity): Promise<void> {
    this._identity = identity;
    this._retired = false;
  }

  public async heartbeat(): Promise<void> {
    this._requireLiving();
  }

  public async livenessOf(ownerId: OwnerId): Promise<OwnerLiveness> {
    // Written as two checks rather than one optional chain: `identity?.…` folds
    // "nobody has announced" and "that is not us" into a nullable boolean, and
    // the two are different questions with the same answer only by luck.
    const identity = this._identity;
    if (identity === null) {
      return 'unknown';
    }
    if (!identity.ownerId.equals(ownerId)) {
      return 'unknown';
    }
    return this._retired ? 'dead' : 'live';
  }

  public async survey(): Promise<readonly OwnerSurvey[]> {
    const identity = this._identity;
    if (identity === null || this._retired) {
      return [];
    }
    // The file name is invented rather than absent: the port promises one, and
    // a base with no medium still has to answer the same shape. It is never
    // used to reach anything -- `collect` below refuses this row, and there is
    // no other.
    //
    // The beat is `null` for the reason `heartbeat()` refreshes nothing here: a
    // heartbeat is a message to readers in other processes, and this base has
    // none. `null` is what the port says a row with no readable moment carries,
    // and the one reader of the moment leaves such a row alone -- which is the
    // true answer, since the only window this base knows about is the live one
    // asking.
    return [
      {
        name: identity.ownerId.value,
        fileName: identity.ownerId.value,
        identity,
        heartbeatAt: null,
        liveness: 'live',
      },
    ];
  }

  /**
   * Nothing to collect, and that is an answer rather than a gap.
   *
   * This base holds exactly one window -- its own -- so the only file a
   * collector could name is either that one, which is refused for the reason
   * the port states, or a window this object has never heard of, which it has
   * nothing to take away. Throwing on the second would report a fault where
   * there is only agreement.
   */
  public async collect(fileName: string): Promise<void> {
    if (fileName === this._identity?.ownerId.value) {
      throw new ConflictError('a window must not collect its own presence file', {
        details: { fileName },
      });
    }
  }

  public async retire(): Promise<void> {
    this._requireAnnounced();
    this._retired = true;
  }

  private _requireAnnounced(): OwnerIdentity {
    const identity = this._identity;
    if (identity === null) {
      throw new ConflictError('this window has not announced itself yet');
    }
    return identity;
  }

  /** The port's rule, kept here too so the two implementations refuse the same calls. */
  private _requireLiving(): OwnerIdentity {
    const identity = this._requireAnnounced();
    if (this._retired) {
      throw new ConflictError('this window has retired and must not write itself back');
    }
    return identity;
  }
}
