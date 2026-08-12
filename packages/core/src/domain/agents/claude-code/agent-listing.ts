import type { AgentListing, AgentRecord } from '../../entities/agent-record';
import { SessionId } from '../../entities/session-id';

/**
 * The question, in the CLI's own words: which sessions are running right now.
 *
 * **`--all` is deliberately absent, and the plan named it.** The binary's help
 * says what the flag adds -- "also include completed background sessions" --
 * and a completed session is the one thing that cannot be a live conversation,
 * while its `sessionId` can still equal one in our store. Including them would
 * therefore only ever forbid a restore that is legal. Asking a narrower
 * question is cheaper than filtering a wider answer, and it cannot be forgotten
 * downstream (2026-08-12, A24).
 */
export const AGENT_LISTING_ARGS: readonly string[] = Object.freeze(['agents', '--json']);

/** What the CLI prints for a session whose own record carries no directory. Measured. */
const UNKNOWN_DIRECTORY = '?';

/** Enough of the output to recognise it in a log line, and not enough to fill one. */
const REASON_PREFIX_LIMIT = 120;

/**
 * Reads `claude agents --json` output into what the machine is running.
 *
 * NOTHING THROWS, for the same reason as in the hook parser: the caller is on
 * the restore path, and an exception there is a window that comes up with its
 * terminals missing. Every refusal is a value.
 *
 * **A missing field never costs a record, and a missing record never costs the
 * list.** Both halves are measured, not assumed (A24): the CLI omits `name` and
 * `status` outright, writes `"?"` for a directory it does not know and `0` for
 * a start time it does not know, does not validate `sessionId` at all, and
 * prints entries with no `sessionId` key whatsoever. An entry we cannot name is
 * therefore an ordinary sight -- so it is skipped and counted, never treated as
 * evidence that the schema moved.
 *
 * The one thing that IS treated as evidence is output that is not a JSON array,
 * because that is not a listing at all. It comes back as `unavailable`, which
 * the type keeps distinct from an empty machine.
 */
export function parseAgentListing(output: string): AgentListing {
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    return { kind: 'unavailable', reason: `the listing is not JSON: ${excerpt(output)}` };
  }

  if (!Array.isArray(payload)) {
    return { kind: 'unavailable', reason: `the listing is not a JSON array: ${excerpt(output)}` };
  }

  const agents: AgentRecord[] = [];
  let skipped = 0;
  for (const entry of payload) {
    const record = readRecord(entry);
    if (record === null) {
      skipped += 1;
      continue;
    }
    agents.push(record);
  }
  return { kind: 'listed', agents, skipped };
}

/**
 * One entry, or `null` when it names no conversation.
 *
 * The session id is the whole of the test. A record without it cannot be
 * compared with anything in our store, cannot be resumed and cannot be
 * recognised later -- while a record with nothing else still answers the only
 * question this list is asked: is this conversation running.
 */
function readRecord(entry: unknown): AgentRecord | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return null;
  }
  const fields = entry as Record<string, unknown>;
  const rawSessionId = readToken(fields.sessionId);
  const sessionId = rawSessionId === null ? null : SessionId.tryFromString(rawSessionId);
  if (sessionId === null) {
    return null;
  }
  return {
    sessionId,
    pid: readPid(fields.pid),
    cwd: readDirectory(fields.cwd),
    kind: readToken(fields.kind),
    startedAt: readInstant(fields.startedAt),
    name: readToken(fields.name),
    status: readToken(fields.status),
  };
}

/** A non-empty string with its surrounding space removed, or nothing. */
function readToken(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * The CLI's `"?"` means "the session did not say", and it must not survive as a
 * path: it would be shown to a person as a folder and compared with real ones
 * as a string. Nothing else is interpreted -- a directory is carried verbatim.
 */
function readDirectory(value: unknown): string | null {
  const token = readToken(value);
  return token === UNKNOWN_DIRECTORY ? null : token;
}

/**
 * A pid or nothing, where "nothing" includes zero and every negative number.
 *
 * The rule is M2.4's, met from the reading side: `kill(pid, 0)` with a
 * non-positive pid signals a process GROUP and never reports a dead process, so
 * a zero taken as a pid is a session that is alive forever -- and a session
 * alive forever is a record that can never be restored.
 */
function readPid(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

/** Unix milliseconds. Zero is the CLI's own "I do not know" (measured), not 1970. */
function readInstant(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

/**
 * Enough of the output to tell an update banner from a crash, on one line.
 *
 * Bounded on purpose: this reason reaches the log, and the thing it quotes is
 * the standard output of another program -- which on a bad day is a megabyte of
 * something. A log line nobody can read is the same as no log line.
 */
function excerpt(output: string): string {
  const collapsed = output.replace(/\s+/gu, ' ').trim();
  if (collapsed.length === 0) {
    return '(it printed nothing)';
  }
  return collapsed.length <= REASON_PREFIX_LIMIT
    ? `"${collapsed}"`
    : `"${collapsed.slice(0, REASON_PREFIX_LIMIT)}..."`;
}
