import { ConflictError } from '../../domain/errors/gripterm-error.js';
import type { OwnerId } from '../../domain/entities/owner-id.js';
import type {
  OwnerIdentity,
  OwnerLiveness,
  OwnerPresence,
} from '../../domain/ports/owner-presence.js';

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
    this._requireAnnounced();
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

  public async listOwners(): Promise<readonly OwnerIdentity[]> {
    const identity = this._identity;
    return identity === null || this._retired ? [] : [identity];
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
}
