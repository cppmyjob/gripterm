import { SessionId } from '../../entities/session-id';
import {
  asArray,
  asFiniteNumber,
  asRecord,
  asString,
  asStringArray,
} from '../../json/json-readers';
import type { AgentBuild, AgentBuildReport } from '../../ports/agent-build';
import type { AgentListing, AgentRecord } from '../../entities/agent-record';
import type { AgentRoster } from '../../ports/agent-roster';
import type { ConversationTranscripts } from '../../ports/conversation-transcripts';
import type { ObservedAgent } from '../../ports/observed-agent';
import type { TranscriptIndex } from '../../entities/transcript-index';

/**
 * The SECOND implementation of the three observation ports, and the only reason
 * they can be called ports at all.
 *
 * **It is not a fake `claude`, and the difference is the whole of this step.** A
 * fake CLI would be a second program printing Claude Code's JSON -- one more
 * place holding that shape, and the shape driven deeper. This holds no flags, no
 * argument vector, no standard output and no process: it answers the three
 * neutral questions out of a recording of a machine on which they were once
 * asked for real. A third agent is then another of these, not a rewrite.
 *
 * **What it is FOR, beyond proving the ports.** Two things, both measured:
 *
 *   * `claude agents --json` costs 702-5353 ms on an unchanged tree (34
 *     activations recorded in the run stores under `.vscode-test`), so any repair cheaper
 *     than a second is invisible under its own noise. Answering from a recording
 *     removes the noise along with the spawn.
 *   * The one conversation a stand can legitimately hold a transcript for is
 *     nobody's. Every start it has ever recorded is a `launch` -- 64 of 64 --
 *     because a terminal nothing was typed into leaves no transcript, so the
 *     planner answers `no-transcript` and mints a new conversation. A recorded
 *     transcript index is the only named way to exercise the `--resume` half at
 *     all without spending somebody's turn.
 *
 * **The rule it obeys and must go on obeying: repeat what was measured, not what
 * would be nicer.** See `dropTheDead` below.
 */

/** Whether a process is there. The seam the liveness filter is built on. */
export type ProcessIsThere = (pid: number) => boolean;

/**
 * One state of one machine, written down so that it can be met again.
 *
 * `build` is not decoration and not documentation: a recording replayed against
 * a different build of the agent is a comparison of two different things, and
 * the check that catches it (`tests/integration/agent-listing.test.ts`) needs a
 * number to compare against. A recording without one is refused outright.
 */
export interface AgentRecording {
  /** Which agent this was taken from. Shown to a person; never parsed. */
  readonly agent: string;
  /** The build it was taken from. A recording of an unnamed build is refused. */
  readonly build: string;
  /** When it was taken, verbatim as written. Shown to a person; never parsed. */
  readonly capturedAt: string;
  readonly running: AgentListing;
  readonly transcripts: TranscriptIndex;
}

/**
 * A recording, or nothing.
 *
 * **Stricter than `parseAgentListing`, deliberately and in the other
 * direction.** That reader skips an entry it cannot name and counts it, because
 * what it is reading is another program's output and a missing key there is an
 * ordinary sight (A24). This reads a file WE wrote, where a missing key is a
 * mistake of ours -- so it refuses the whole recording rather than quietly
 * replaying a smaller machine than the one that was recorded. `skipped` is
 * written down explicitly when a recording means to hold entries that were
 * skipped.
 */
export function readAgentRecording(value: unknown): AgentRecording | null {
  const fields = asRecord(value);
  if (fields === null) {
    return null;
  }
  const agent = asString(fields.agent);
  const build = asString(fields.build);
  const capturedAt = asString(fields.capturedAt);
  const running = readListing(fields.running);
  const transcripts = readIndex(fields.transcripts);
  if (agent === null || build === null || capturedAt === null || running === null || transcripts === null) {
    return null;
  }
  return { agent, build, capturedAt, running, transcripts };
}

/**
 * The three implementations, assembled.
 *
 * `isThere` is handed in rather than reached for, because what it means differs
 * by where this is replayed: a suite says "everything in this recording is
 * alive" and gets the machine as it was recorded, while a window replaying one
 * hands over a real signal 0 and gets the same filter the real CLI applies.
 */
export function recordedAgent(
  recording: AgentRecording,
  isThere: ProcessIsThere
): ObservedAgent {
  return {
    name: recording.agent,
    roster: new RecordedRoster(recording, isThere),
    transcripts: new RecordedTranscripts(recording),
    build: new RecordedBuild(recording),
  };
}

class RecordedRoster implements AgentRoster {
  private readonly _recording: AgentRecording;
  private readonly _isThere: ProcessIsThere;

  constructor(recording: AgentRecording, isThere: ProcessIsThere) {
    this._recording = recording;
    this._isThere = isThere;
  }

  public async list(): Promise<AgentListing> {
    return await Promise.resolve(dropTheDead(this._recording.running, this._isThere));
  }
}

class RecordedTranscripts implements ConversationTranscripts {
  private readonly _recording: AgentRecording;

  constructor(recording: AgentRecording) {
    this._recording = recording;
  }

  public async index(): Promise<TranscriptIndex> {
    return await Promise.resolve(this._recording.transcripts);
  }
}

class RecordedBuild implements AgentBuild {
  private readonly _recording: AgentRecording;

  constructor(recording: AgentRecording) {
    this._recording = recording;
  }

  public async describe(): Promise<AgentBuildReport> {
    const { build, capturedAt } = this._recording;
    return await Promise.resolve({
      version: build,
      // `info`: the recording IS the build it says it is, so there is no
      // mismatch to report. That a window is running on a recording at all is a
      // different sentence, said unconditionally by whoever chose to replay one.
      level: 'info',
      message: `${build}, from a recording taken ${capturedAt} and replayed instead of asking the agent`,
    });
  }
}

/**
 * The one behaviour copied rather than improved on.
 *
 * `claude agents --json` does not print a session whose pid nothing is running
 * as. Measured 2026-08-12 (A24) and again 2026-08-27 against `claude 2.1.245`,
 * one variable at a time: the same planted session came back listed on a live
 * pid and came back as `[]` on pid 999999.
 *
 * It is copied because `livenessRule` reads a pid on the roster as evidence
 * about NOW, ahead of every other rule -- and that ordering is sound only while
 * the roster has already dropped the dead. A second implementation that answered
 * with everything it was handed would hold each of those conversations
 * un-restorable for as long as the recording lives, and the refusal would be
 * reported in the words of a measurement nobody made.
 *
 * **A record with no pid is KEPT, and the direction of that is the point.** It
 * cannot be shown alive, so the invariant cannot be satisfied for it -- but
 * dropping it would take the conversation off the roster, and a conversation off
 * the roster is one a restore may start. Keeping it costs a refusal
 * (`session-listed`); dropping it costs a second `--resume` on a live
 * transcript, and nothing takes that back.
 */
function dropTheDead(listing: AgentListing, isThere: ProcessIsThere): AgentListing {
  if (listing.kind !== 'listed') {
    return listing;
  }
  const agents = listing.agents.filter((agent) => agent.pid === null || isThere(agent.pid));
  return {
    kind: 'listed',
    agents,
    skipped: listing.skipped + (listing.agents.length - agents.length),
  };
}

function readListing(value: unknown): AgentListing | null {
  const fields = asRecord(value);
  if (fields === null) {
    return null;
  }
  if (fields.kind === 'unavailable') {
    const reason = asString(fields.reason);
    return reason === null ? null : { kind: 'unavailable', reason };
  }
  if (fields.kind !== 'listed') {
    return null;
  }
  const entries = asArray(fields.agents);
  const skipped = asFiniteNumber(fields.skipped);
  if (entries === null || skipped === null) {
    return null;
  }
  const agents: AgentRecord[] = [];
  for (const entry of entries) {
    const record = readRecord(entry);
    if (record === null) {
      return null;
    }
    agents.push(record);
  }
  return { kind: 'listed', agents, skipped };
}

function readRecord(value: unknown): AgentRecord | null {
  const fields = asRecord(value);
  if (fields === null) {
    return null;
  }
  const raw = asString(fields.sessionId);
  const sessionId = raw === null ? null : SessionId.tryFromString(raw);
  if (sessionId === null) {
    return null;
  }
  return {
    sessionId,
    pid: asFiniteNumber(fields.pid),
    cwd: asString(fields.cwd),
    kind: asString(fields.kind),
    startedAt: asFiniteNumber(fields.startedAt),
    name: asString(fields.name),
    status: asString(fields.status),
  };
}

function readIndex(value: unknown): TranscriptIndex | null {
  const fields = asRecord(value);
  if (fields === null) {
    return null;
  }
  if (fields.kind === 'unavailable') {
    const reason = asString(fields.reason);
    return reason === null ? null : { kind: 'unavailable', reason };
  }
  if (fields.kind !== 'indexed') {
    return null;
  }
  const sessionIds = asStringArray(fields.sessionIds);
  const skipped = asFiniteNumber(fields.skipped);
  if (sessionIds === null || skipped === null) {
    return null;
  }
  return { kind: 'indexed', sessionIds: new Set(sessionIds), skipped };
}
