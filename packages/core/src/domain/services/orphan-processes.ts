import { precedesBoot } from './boot-window';
import type { AgentListing } from '../entities/agent-record';
import type { OwnerLiveness } from '../ports/owner-presence';
import type { TerminalEntry } from '../entities/terminal-entry';

/**
 * Whose process a window may END, and on what evidence (M3.5, O4).
 *
 * This is the only rule in the project that authorises something no undo of ours
 * reaches. Everything else that can go wrong here costs a row, a click or a
 * conversation that has to be resumed by hand; this one costs somebody's running
 * work, and there is no `trash/` to move it to afterwards (§I.3). So the rule is
 * written as a series of refusals, and the burden is on the evidence.
 *
 * **The two halves are split by the COST of the evidence, not by tidiness.**
 * `orphanCandidates` reads what this machine has already said -- the records, the
 * owner liveness map, the boot -- and is free. `confirmOrphans` needs `claude
 * agents --json`, which is a process spawn measured at 0.56-0.70 s (A24) on the
 * activation path, where a person is waiting for their window. So the free half
 * runs first and the expensive question is asked only if the answer could change
 * anything -- and on the ordinary machine, where no window has died, it is never
 * asked at all.
 *
 * **Why our own evidence is not enough, and what closes the gap.** `precedesBoot`
 * removes the whole cross-boot class of pid reuse, which on Windows is most of it
 * -- but not the intra-boot class: our `claude` died at ten, the pid was handed
 * out again at five past, and the record still names it. Nothing this window
 * knows can tell that apart. What can is the machine's OWN answer: the CLI names
 * the conversations it is running, with the pid of each. When that listing names
 * a conversation this record claims AND names it at the pid this record stored,
 * two independent witnesses agree, and the conversation ids are uuids we issued
 * -- so a stranger's process cannot borrow one.
 *
 * Measured 2026-08-17 (A43), because the whole guard rests on it: for a `claude`
 * started by our own engine, `claude agents --json` reports exactly the pid
 * node-pty reports; a session with nothing said in it is listed within three
 * seconds, so an idle orphan -- the ordinary kind -- is not invisible to this;
 * and once the process is gone the listing drops it.
 */

/** A record whose process this window may end, with the number it would signal. */
export interface OrphanCandidate {
  readonly entry: TerminalEntry;
  /** `ObservedState` guarantees this is a positive integer, never 0 (see its constructor). */
  readonly pid: number;
}

export interface OrphanEvidence {
  /** Every record on the machine, read from the medium rather than from a projection. */
  readonly entries: readonly TerminalEntry[];
  /** As the reconciler keeps it: surveyed windows, plus this one as `live`. */
  readonly ownerLiveness: ReadonlyMap<string, OwnerLiveness>;
  /** Both terms of the boot rule from one instant (`precedesBoot`). */
  readonly nowMs: number;
  readonly uptimeSeconds: number;
}

/**
 * The records this window's own evidence allows it to end a process for.
 *
 * Five refusals, each of them a cost rather than a shape:
 *
 *   * **the editor's engine.** Under `editor` a `claude` outlives the extension
 *     host on purpose (O5, measured in M2.16), so a window that closed leaves a
 *     conversation that is still working. Ending it would be this build
 *     destroying the thing it exists to keep -- and the record cannot lie about
 *     which engine made it, because the gateway that made the terminal stamps
 *     the field (M3.4).
 *   * **an owner that is not a window.** The liveness this stands on is a
 *     window's heartbeat (M2.4). Nothing here answers for a service, so nothing
 *     here may act on one.
 *   * **an owner not established dead.** `unknown` is a window that is there and
 *     not talking -- asleep, hung, on a machine that stalled -- and `live` is one
 *     that may be using that very conversation as this is read. Only `dead` has
 *     been established, and this window is `live` in its own map, which is what
 *     keeps its own records out.
 *   * **no pid.** We were never told which process it is, and a rule cannot end
 *     a process it cannot name.
 *   * **a record last heard from before the boot.** Its pid is a number from a
 *     previous life of this machine; whoever answers to it now is a stranger.
 *
 * A record whose terminal the person CLOSED is deliberately not refused. The
 * close says the person is finished with the terminal, and a process still
 * running for it is exactly what O4 says must not remain.
 */
export function orphanCandidates(evidence: OrphanEvidence): readonly OrphanCandidate[] {
  const candidates: OrphanCandidate[] = [];
  for (const entry of evidence.entries) {
    const { pid } = entry.observed;
    if (
      entry.engine !== 'own' ||
      entry.owner.kind !== 'window' ||
      evidence.ownerLiveness.get(entry.owner.ownerId.value) !== 'dead' ||
      pid === null ||
      precedesBoot(entry.observed.lastEventAt.getTime(), evidence.nowMs, evidence.uptimeSeconds)
    ) {
      continue;
    }
    candidates.push({ entry, pid });
  }
  return candidates;
}

/**
 * What the machine's own listing says about each candidate.
 *
 * Both halves are returned because both are worth saying out loud. The confirmed
 * ones are about to be ended, which is the loudest thing this build does; the
 * unconfirmed ones are records that name a process of ours that we could not
 * establish anything about -- rare, and the shape a person needs when they ask
 * why something is still running.
 */
export interface OrphanConfirmation {
  readonly confirmed: readonly OrphanCandidate[];
  readonly unconfirmed: readonly OrphanCandidate[];
}

/**
 * The second witness: the CLI names this conversation, and names it at this pid.
 *
 * A listing that could not be had confirms NOTHING, rather than confirming an
 * empty machine -- the same rule `AgentListing` exists to carry, applied where
 * getting it wrong ends a process instead of starting a second one.
 *
 * Both halves of the match are load-bearing, and each covers what the other
 * cannot. The pid alone would be a stranger's `claude` on a reused number. The
 * conversation alone would be a conversation somebody else has already brought
 * back -- running now as a different process, while our number points at
 * whatever inherited it.
 */
export function confirmOrphans(
  candidates: readonly OrphanCandidate[],
  agents: AgentListing
): OrphanConfirmation {
  const confirmed: OrphanCandidate[] = [];
  const unconfirmed: OrphanCandidate[] = [];
  for (const candidate of candidates) {
    if (namedByTheMachine(candidate, agents)) {
      confirmed.push(candidate);
    } else {
      unconfirmed.push(candidate);
    }
  }
  return { confirmed, unconfirmed };
}

function namedByTheMachine(candidate: OrphanCandidate, agents: AgentListing): boolean {
  if (agents.kind === 'unavailable') {
    return false;
  }
  return agents.agents.some(
    (agent) => agent.pid === candidate.pid && candidate.entry.matchesSession(agent.sessionId)
  );
}
