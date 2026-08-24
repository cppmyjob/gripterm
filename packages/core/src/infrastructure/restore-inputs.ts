import { pidsEstablishedGone, sendSignalZero } from './process-liveness';
import type { AgentListing } from '../domain/entities/agent-record';
import type { Logger } from '../domain/ports/logger';
import type { OwnerId } from '../domain/entities/owner-id';
import type { OwnerLiveness, OwnerPresence } from '../domain/ports/owner-presence';
import type { RestoreInputs } from '../domain/services/restore-planner';
import type { SignalProbe } from './process-liveness';
import type { TerminalRepository } from '../domain/repositories/terminal-repository';
import type { TranscriptIndex } from '../domain/entities/transcript-index';

export interface RestoreInputSources {
  /** The whole machine's records, not just this window's. */
  readonly repository: TerminalRepository;
  readonly presence: OwnerPresence;
  /** The folders THIS window has open, as the editor reports them. */
  readonly windowFolders: readonly string[];
  /** Read as a call rather than passed as a value: its failure is handled here. */
  readonly readTranscripts: () => Promise<TranscriptIndex>;
  readonly readAgents: () => Promise<AgentListing>;
  /** Sampled by the caller, so that both terms of the boot rule come from one instant. */
  readonly nowMs: number;
  readonly uptimeSeconds: number;
  readonly logger: Logger;
  /** Defaults to a real signal 0. A seam for the same reason `SignalProbe` is one. */
  readonly probe?: SignalProbe;
}

/**
 * Everything the restore planner needs, gathered from the world.
 *
 * It is the other half of `planRestore` being pure: that function decides
 * whether a second `claude --resume` lands on a live conversation, and it can
 * only be trusted to if the answers it is handed are the true ones. So the four
 * questions are asked here, in one place with one rule over all of them:
 *
 * **EVERY FAILURE ANSWERS IN THE DIRECTION OF REFUSAL.** A presence file that
 * cannot be read leaves its window `unknown`, not `dead`. A reader that throws
 * produces `unavailable`, not "nothing is running". A pid that could not be
 * settled stays out of `deadPids`, which is the set membership of which PERMITS
 * a restore. Each of those costs a person one click on the explicit adoption of
 * M2.14; the opposite mistake costs two processes writing one transcript, which
 * no undo of ours reaches.
 *
 * The two readers are functions rather than values because their failure is this
 * function's business. A caller who read them itself would have to remember to
 * turn a throw into `unavailable` -- and `catch { return [] }` is the natural
 * shape of that mistake, which is exactly the defect the type was invented to
 * prevent (M2.9).
 */
export async function gatherRestoreInputs(sources: RestoreInputSources): Promise<RestoreInputs> {
  const entries = await sources.repository.readAll();

  const ownerLiveness = new Map<string, OwnerLiveness>();
  for (const entry of entries) {
    const { ownerId } = entry.owner;
    if (!ownerLiveness.has(ownerId.value)) {
      ownerLiveness.set(ownerId.value, await livenessOf(sources, ownerId));
    }
  }

  const pids = new Set<number>();
  for (const entry of entries) {
    if (entry.observed.pid !== null) {
      pids.add(entry.observed.pid);
    }
  }

  return {
    entries,
    windowFolders: sources.windowFolders,
    ownerLiveness,
    deadPids: pidsEstablishedGone(pids, sources.probe ?? sendSignalZero),
    transcripts: await asked(sources.readTranscripts, 'which conversations have a transcript', sources.logger),
    agents: await asked(sources.readAgents, 'what the CLI is running', sources.logger),
    nowMs: sources.nowMs,
    uptimeSeconds: sources.uptimeSeconds,
  };
}

/**
 * One window's liveness, asked once however many of its terminals are in the
 * base.
 *
 * A presence store that throws is a store we could not ask, and the answer to a
 * question we could not ask is `unknown` -- which the planner reads as "not
 * ours to touch". The implementation shipped here already answers that way for
 * an unreadable file; this covers the other shape, where the read itself fails.
 */
async function livenessOf(sources: RestoreInputSources, ownerId: OwnerId): Promise<OwnerLiveness> {
  try {
    return await sources.presence.livenessOf(ownerId);
  } catch (cause: unknown) {
    sources.logger.warn('a window could not be asked whether it is still there, so its terminals stay its own', {
      ownerId: ownerId.value,
      cause,
    });
    return 'unknown';
  }
}

/**
 * A question that could not be asked, in the shape both readers already use for
 * one.
 *
 * The type is written out here rather than imported from either of them: it is
 * the member `TranscriptIndex` and `AgentListing` have in common, and saying so
 * once is what lets the helper below serve both without either union learning
 * about the other.
 */
interface Unaskable {
  readonly kind: 'unavailable';
  readonly reason: string;
}

/**
 * Whatever the reader answered, or the fact that it could not be asked.
 *
 * A reader that throws is not an empty answer. `readTranscriptIndex` and
 * `readAgentListing` both know that and both fold their own failures into
 * `unavailable` -- this covers what is left: a reader that could not even be
 * called, which is what a missing executable or a path this window may not
 * resolve looks like from here.
 */
async function asked<T>(
  reader: () => Promise<T>,
  what: string,
  logger: Logger
): Promise<T | Unaskable> {
  try {
    return await reader();
  } catch (cause: unknown) {
    logger.warn('a restore could not establish what it needs, so it will start nothing', {
      what,
      cause,
    });
    return { kind: 'unavailable', reason: String(cause) };
  }
}
