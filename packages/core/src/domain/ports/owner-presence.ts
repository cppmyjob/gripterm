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
 * How often a window rewrites its presence file. [П]
 *
 * Part of the contract rather than of one implementation: it is half of a pair
 * with the freshness window below, and the pair is what other windows reason
 * with. Changing one without the other changes what `unknown` means for
 * everybody on the machine.
 */
export const HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * How long a heartbeat stays fresh. Six beats. [П]
 *
 * Wide on purpose: a window that missed one beat because the machine was busy
 * is not a window that is gone, and the cost of the two mistakes is not
 * symmetric -- an early `dead` authorises a second `claude --resume` on one
 * conversation, while a late one costs a person a confirmation click.
 */
export const FRESH_HEARTBEAT_MS = 60_000;

/**
 * One entry of `owners/`, as its collector meets it rather than as a reader of
 * one window does.
 *
 * `name` first, and `identity` nullable, because those two together are the
 * whole reason this shape exists. The reconciler (M2.12) has to see the files
 * that could NOT be decoded: liveness answers `unknown` about them forever --
 * nothing can be established from a file nobody can read -- so they are the one
 * kind of rubbish that no other rule would ever take away. Addressing them by
 * the name they turned up under is the only address they have.
 */
export interface OwnerSurvey {
  /**
   * The window this file is named FOR -- which is not the same as what it says
   * about itself, and the difference is the point: a file that does not decode
   * still has a name, and that name is the only thing a record's `ownerId` can
   * be compared against.
   */
  readonly name: string;
  /**
   * How the medium spells it. The handle `collect` takes, kept apart from
   * `name` rather than derived from it, so that nothing has to know how a
   * window's name becomes a file's -- least of all the domain.
   */
  readonly fileName: string;
  /** `null` when the file did not decode. */
  readonly identity: OwnerIdentity | null;
  /** The same verdict `livenessOf` gives, and `unknown` for a file that did not decode. */
  readonly liveness: OwnerLiveness;
}

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
  /**
   * Every file in the directory, live or not, readable or not.
   *
   * Deliberately unfiltered in both directions. A dead window's presence file
   * outlives every terminal it owned, so a list of the LIVING could never lead
   * anything to the files that have to be collected; and a list of the
   * DECODABLE would hide precisely the ones that nothing else can.
   */
  survey: () => Promise<readonly OwnerSurvey[]>;
  /**
   * Takes one presence file out of the directory, by the name it was found
   * under.
   *
   * Refuses this window's own file, in both implementations. A window that
   * removes its own presence goes on beating into nothing and looks dead to
   * everybody else -- which is the one mistake in this class that hands its own
   * conversations away.
   *
   * Absent is not an error: two windows may sweep at once, and a collector that
   * threw on the second would report a fault where there is only agreement.
   */
  collect: (fileName: string) => Promise<void>;
  retire: () => Promise<void>;
}
