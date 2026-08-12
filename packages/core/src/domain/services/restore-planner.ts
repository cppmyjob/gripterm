import { precedesBoot } from './boot-window';
import type { AgentListing } from '../entities/agent-record';
import type { OwnerLiveness } from '../ports/owner-presence';
import type { TerminalEntry } from '../entities/terminal-entry';
import type { TranscriptIndex } from '../entities/transcript-index';

/**
 * Why a record this window can see is not being restored by it.
 *
 * Every one of these is an ordinary state of the world rather than a fault, and
 * the reason is kept per record because a person asking "why is my terminal not
 * back" deserves the sentence rather than a shrug (M2.14 shows them; the
 * orchestrator logs them).
 */
export type RestoreRefusal =
  /** A person closed it. The one refusal that is permanent. */
  | 'closed'
  /** Its window is running. Its terminals are its business. */
  | 'owner-live'
  /** Its window is there and silent -- asleep, hung, or stalled. Not gone. */
  | 'owner-unknown'
  /** It belongs to a project this window does not have open (§6, defect G1). */
  | 'foreign-folder'
  /** Our own evidence does not establish that its `claude` has stopped. */
  | 'session-running'
  /** The CLI names its conversation among the ones it is running. */
  | 'session-listed'
  /** The CLI could not be asked what is running, so nothing may be started. */
  | 'agents-unavailable'
  /** The transcripts could not be listed, so nothing is known to be resumable. */
  | 'transcripts-unavailable'
  /** Nothing was ever said in it: `--resume` would fail (measured 2026-08-10). */
  | 'no-transcript'
  /** Two records name one conversation, and choosing between them is not ours. */
  | 'duplicate-session';

export interface RestoreStep {
  readonly entry: TerminalEntry;
  /**
   * The revision the decision was made on, and the one the adoption must be
   * compared against.
   *
   * Spelled separately from `entry.revision` although it is that number, because
   * a plan is a SNAPSHOT: between planning and execution another window may
   * adopt the same record, and an orchestrator that re-read the entry and used
   * its fresh revision would pass the compare-and-swap precisely when it should
   * have failed. Every step therefore begins with `adopt(terminalId, this)`.
   */
  readonly expectedRevision: number;
}

export interface RestoreSkip {
  readonly entry: TerminalEntry;
  readonly reason: RestoreRefusal;
}

export interface RestorePlan {
  /** In the order the records arrived, so that two runs of the planner agree. */
  readonly steps: readonly RestoreStep[];
  readonly skipped: readonly RestoreSkip[];
}

export interface RestoreInputs {
  /** Everything in the base -- the whole machine's records, not just ours. */
  readonly entries: readonly TerminalEntry[];
  /** The folders THIS window has open. Empty is a window with no folder. */
  readonly windowFolders: readonly string[];
  /** `OwnerId.value` to liveness. A missing owner is `unknown`, never `dead`. */
  readonly ownerLiveness: ReadonlyMap<string, OwnerLiveness>;
  /** Pids ESTABLISHED to be gone. Absence means "not established", not "running". */
  readonly deadPids: ReadonlySet<number>;
  readonly transcripts: TranscriptIndex;
  readonly agents: AgentListing;
  readonly nowMs: number;
  /** `os.uptime()`, for the boot rule -- see `precedesBoot`. */
  readonly uptimeSeconds: number;
}

/**
 * What this window may bring back by itself, and why it may not bring back the
 * rest.
 *
 * Pure, and that is the point: this is the function that decides whether a
 * second `claude --resume` lands on a live conversation, and a decision like
 * that has to be reproducible from data a test can write down. Every piece of
 * the world it needs -- who is alive, which processes answer, what the CLI is
 * running, which conversations were ever spoken in -- is resolved by the caller
 * and arrives as a value.
 *
 * THE COST IS ONE-SIDED, and every rule below is written to fail towards
 * refusal. Refusing a record that could have come back costs a person one click
 * (M2.14's explicit adoption). Admitting one that should not have costs two
 * `claude` processes writing one transcript -- messages interleaved in somebody's
 * conversation, which no undo of ours reaches. So: an input that is missing, a
 * question that could not be asked, an answer that did not arrive -- all of them
 * keep a record out of the plan.
 *
 * THE ORDER OF THE RULES IS THE DESIGN.
 *
 *   1. `closed` first: a record a person threw away is not a question about
 *      liveness at all.
 *   2. Then the owner. A live or silent window's terminals are not ours to take,
 *      whatever else is true of them -- this is the ownership rule, and it is
 *      also what keeps us off a conversation another window is resuming right
 *      now.
 *   3. Then the folder (§6, defect G1). Visibility is machine-global and
 *      restore is not: after a machine restart EVERY owner is dead, and without
 *      this line the first window to activate adopts and starts another
 *      project's terminals while the window that owns them opens empty.
 *   4. Then liveness of the conversation, OUR evidence first and the CLI's
 *      second -- see below.
 *   5. Then the transcript, LAST of the per-record rules, so that a running
 *      conversation is never reported as "nothing was ever said here". That
 *      reason becomes an offer to start over (M2.13), and offering to start over
 *      on a live conversation is the mistake this whole function exists to
 *      prevent.
 *   6. Then, across the survivors, the duplicate check.
 *
 * WHY OUR OWN EVIDENCE COMES FIRST (measured, A24 + A22 §1). `claude agents
 * --json` is a projection of `~/.claude/sessions/<pid>.json`, and an interactive
 * session that is up but idle was measured NOT to appear there at all for a full
 * minute. So an empty listing is not permission: it is compatible with a live
 * conversation. The first source of liveness is therefore our own `observed`
 * state -- the pid the CLI told us (A16) and the moment we last heard from it --
 * and the CLI's list is a second opinion that can only ADD prohibitions. A
 * listing that could not be read at all stops the plan entirely rather than
 * emptying it, because "we did not ask" and "nothing is running" are the same
 * value only in code that is about to be wrong.
 */
export function planRestore(inputs: RestoreInputs): RestorePlan {
  const listed = listedSessions(inputs.agents);
  const judged = inputs.entries.map((entry) => ({
    entry,
    reason: refusalFor(entry, inputs, listed),
  }));

  const claims = new Map<string, number>();
  for (const { entry, reason } of judged) {
    if (reason === null) {
      claims.set(entry.sessionId.value, (claims.get(entry.sessionId.value) ?? 0) + 1);
    }
  }

  const steps: RestoreStep[] = [];
  const skipped: RestoreSkip[] = [];
  for (const { entry, reason } of judged) {
    const contested = (claims.get(entry.sessionId.value) ?? 0) > 1;
    if (reason !== null) {
      skipped.push({ entry, reason });
    } else if (contested) {
      // Two records naming one conversation is either a copied base or a defect
      // of ours, and both readings say the same thing: resuming both is the O3
      // violation itself, and picking one is a judgement about whose notes are
      // real, which belongs to a person and not to a predicate.
      skipped.push({ entry, reason: 'duplicate-session' });
    } else {
      steps.push({ entry, expectedRevision: entry.revision });
    }
  }
  return { steps, skipped };
}

/**
 * The conversations the CLI says it is running, or `null` when it could not be
 * asked.
 *
 * The records' own `pid` field is deliberately not consulted. The CLI has
 * already filtered its list by process liveness and start time (measured, A24),
 * so re-checking here could only ever DISAGREE by permitting -- and permitting
 * is the direction a second opinion is never allowed to move.
 */
function listedSessions(agents: AgentListing): ReadonlySet<string> | null {
  if (agents.kind === 'unavailable') {
    return null;
  }
  return new Set(agents.agents.map((agent) => agent.sessionId.value));
}

function refusalFor(
  entry: TerminalEntry,
  inputs: RestoreInputs,
  listed: ReadonlySet<string> | null
): RestoreRefusal | null {
  if (!entry.isRestorable()) {
    return 'closed';
  }
  const liveness = inputs.ownerLiveness.get(entry.owner.ownerId.value) ?? 'unknown';
  if (liveness !== 'dead') {
    return liveness === 'live' ? 'owner-live' : 'owner-unknown';
  }
  if (!belongsHere(entry.owner.workspaceFolder, inputs.windowFolders)) {
    return 'foreign-folder';
  }
  if (mayBeRunning(entry, inputs)) {
    return 'session-running';
  }
  if (listed === null) {
    return 'agents-unavailable';
  }
  if (entry.claimsAnyOf(listed)) {
    return 'session-listed';
  }
  if (inputs.transcripts.kind === 'unavailable') {
    return 'transcripts-unavailable';
  }
  if (!inputs.transcripts.sessionIds.has(entry.sessionId.value)) {
    return 'no-transcript';
  }
  return null;
}

/**
 * Whether this window is the one that may restore that record.
 *
 * `workspaceFolder === null` belongs to a window with NO folders open. Anything
 * else would make such a record restorable by nobody -- `null` is in no set of
 * folders -- and it opens no theft either, because `null` matches no real folder
 * (§6).
 *
 * Membership is exact, not containment: a window with `D:\Projects` open does
 * not automatically own the terminals of `D:\Projects\thing`. Widening that is
 * the direction defect G1 came from.
 */
function belongsHere(folder: string | null, windowFolders: readonly string[]): boolean {
  if (folder === null) {
    return windowFolders.length === 0;
  }
  return windowFolders.some((open) => sameFolder(open, folder));
}

/** A drive letter or a UNC prefix -- the paths whose file systems ignore case. */
const WINDOWS_SHAPED = /^(?:[a-z]:|\\\\)/i;
const SEPARATORS = /[\\/]+/g;
const TRAILING_SEPARATOR = /\/+$/;

/**
 * The same folder, spelled by two different windows.
 *
 * Both spellings come from the same editor API on the same machine, so they
 * normally agree -- but a record outlives the window that wrote it, and a folder
 * opened as `d:\projects\x` from a shell and as `D:\Projects\X` from the
 * explorer is one folder to Windows. Refusing the second spelling would silently
 * withhold the whole feature from a person who did nothing wrong.
 *
 * Case is folded ONLY for Windows-shaped paths, decided by the string rather
 * than by a flag from the host. On a case-sensitive file system `/home/a` and
 * `/home/A` are two directories, and folding them would let one project's window
 * restore another's -- the G1 direction again. The cost is that a macOS user,
 * whose file system ignores case as well, gets a refusal where Windows gets a
 * restore; that is one click, and it is named in §8.2 rather than guessed at.
 */
function sameFolder(left: string, right: string): boolean {
  return normalizeFolder(left) === normalizeFolder(right);
}

function normalizeFolder(folder: string): string {
  const unified = folder.replace(SEPARATORS, '/').replace(TRAILING_SEPARATOR, '');
  return WINDOWS_SHAPED.test(folder) ? unified.toLowerCase() : unified;
}

/**
 * Whether our own evidence leaves the conversation possibly running.
 *
 * The boot rule outranks the pid, and it carries the common case: after a
 * machine restart every stored pid is a number from a previous life, and Windows
 * hands pids out again aggressively, so a plain probe would answer "there" for
 * whichever of them a stranger now holds -- and that window's terminals would
 * quietly never come back. An observed state older than the boot cannot be
 * describing a process alive now, whatever the pid says today.
 *
 * A record with no pid at all is treated as possibly running. It is the honest
 * reading -- we have no evidence either way -- and the cheap one: such a record
 * either never started, in which case the transcript rule would refuse it
 * anyway, or its hooks never reached us, in which case it is exactly the record
 * we know least about.
 */
function mayBeRunning(entry: TerminalEntry, inputs: RestoreInputs): boolean {
  const { observed } = entry;
  if (precedesBoot(observed.lastEventAt.getTime(), inputs.nowMs, inputs.uptimeSeconds)) {
    return false;
  }
  if (observed.pid === null) {
    return true;
  }
  return !inputs.deadPids.has(observed.pid);
}
