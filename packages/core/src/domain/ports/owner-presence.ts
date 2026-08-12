import type { EditorKind, OwnerKind } from '../entities/owner-ref';
import type { OwnerId } from '../entities/owner-id';

/**
 * Who a window is, as other windows read it.
 *
 * The richer half of `OwnerRef`: that one is stored inside a terminal's record
 * and answers "whose is this", while this one is the owner's own file and
 * answers "who is out there". M1.13 builds the producer; the fields are the
 * ones `owners/<ownerId>.json` carries, minus the two timestamps, which belong
 * to presence rather than to identity.
 */
export interface OwnerIdentity {
  readonly ownerId: OwnerId;
  readonly kind: OwnerKind;
  readonly pid: number;
  readonly editorKind: EditorKind;
  readonly editorVersion: string;
  readonly workspaceFolders: readonly string[];
}

/**
 * Three values, and the third one is load-bearing.
 *
 * `unknown` means "the process is there, but its heartbeat is stale" -- which is
 * how a window looks after the machine wakes from sleep. A two-valued liveness
 * would have to call that window dead and would let its terminals be adopted
 * out from under it, which in practice means a second `claude --resume` on a
 * conversation that already has one.
 */
export type OwnerLiveness = 'live' | 'dead' | 'unknown';

/**
 * The lifecycle is part of the contract, and both implementations enforce it:
 * `announce` comes first, `heartbeat` and `retire` refuse before it, and a
 * `heartbeat` AFTER `retire` is refused as well. The last of those is the one
 * worth stating -- a window that has said it is leaving and goes on writing is
 * exactly what liveness has to be able to trust -- so the timer is stopped
 * before the window retires, not after.
 */
export interface OwnerPresence {
  announce: (identity: OwnerIdentity) => Promise<void>;
  heartbeat: () => Promise<void>;
  livenessOf: (ownerId: OwnerId) => Promise<OwnerLiveness>;
  listOwners: () => Promise<readonly OwnerIdentity[]>;
  retire: () => Promise<void>;
}
