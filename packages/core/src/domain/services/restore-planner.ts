import { belongsHere } from './folder-path';
import { precedesBoot } from './boot-window';
import type { LaunchIntent } from '../entities/launch-intent';
import type { AgentListing } from '../entities/agent-record';
import type { OwnerLiveness } from '../ports/owner-presence';
import type { TerminalEntry } from '../entities/terminal-entry';
import type { TerminalId } from '../entities/terminal-id';
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

/**
 * What a person's own window may do with a record they asked to resume: refuse
 * with a reason written for them, or start -- and `intent` says which of the two
 * starts it is, in the same words `RestoreStep` uses.
 */
export type ResumeDecision =
  | { readonly kind: 'refused', readonly reason: RestoreRefusal }
  | { readonly kind: 'start', readonly intent: LaunchIntent };

export interface RestoreStep {
  readonly entry: TerminalEntry;
  /**
   * How this record comes back: continuing the conversation it names, or
   * starting a new one inside the same record.
   *
   * `launch` is the owner's decision of 2026-08-21 and it has exactly one cause:
   * a conversation nothing was ever said in leaves no transcript, and
   * `--resume` on it prints "No conversation found" and exits 1 (measured
   * 2026-08-10, and again in A45 on 2.1.233). Such a record used to be refused,
   * and the owner met what that costs -- four terminals opened, nothing typed
   * into them, the editor restarted, and their own log reading
   * `records this window did not bring back, by reason {"no-transcript":4}`.
   *
   * The record itself is kept, not archived: its id, name, task and notes are
   * the reason a person wanted it back, and the conversation id it holds points
   * at nothing, so there is nothing to lose by replacing it. The `SessionStart`
   * hook writes the new id in when the CLI reports it.
   */
  readonly intent: LaunchIntent;
  /**
   * Whether the adoption may displace an owner the store calls `unknown`.
   *
   * True only for a step a person asked for by name (M2.14): `unknown` is a
   * window that is there and silent, and `AdoptOptions.force` is the person
   * saying they have looked. Nothing automatic ever sets it.
   */
  readonly force: boolean;
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
  /**
   * One record a person has asked THIS window to take (M2.14), or nothing.
   *
   * A demand does two things and no more. It narrows the plan to that record --
   * one click must not start every terminal the predicate happens to permit --
   * and it lifts exactly two refusals: the folder, because the person is looking
   * at the row and asking for it here, and `owner-unknown`, because that is what
   * `force` means. It lifts NOTHING about the conversation: whether a `claude`
   * is running it is not something a person can see from a row, and that is the
   * mistake whose cost is an interleaved transcript.
   */
  readonly demanded?: TerminalId | null;
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
  const demanded = inputs.demanded ?? null;

  // Counted over every record that could still be resumed BY ANYBODY, not over
  // the ones this window may start today. A twin refused here for a reason its
  // own window does not have -- another project, a live owner -- is a twin that
  // will be offered a restore later, and the two would then be two
  // `claude --resume` on one transcript. Only `closed` is left out, because a
  // record a person closed will never be resumed by anybody.
  const claims = new Map<string, number>();
  for (const entry of inputs.entries) {
    if (entry.isRestorable()) {
      claims.set(entry.sessionId.value, (claims.get(entry.sessionId.value) ?? 0) + 1);
    }
  }

  // A demanded plan speaks about ONE record: one click must not start every
  // terminal the predicate happens to permit. The rest of the base is read all
  // the same, by the count above -- which is the part a demand may not escape.
  const considered =
    demanded === null
      ? inputs.entries
      : inputs.entries.filter((entry) => entry.terminalId.equals(demanded));

  const steps: RestoreStep[] = [];
  const skipped: RestoreSkip[] = [];
  for (const entry of considered) {
    const reason = refusalFor(entry, inputs, listed, demanded !== null);
    const contested = (claims.get(entry.sessionId.value) ?? 0) > 1;
    // `no-transcript` is the one refusal that became an ANSWER instead (owner's
    // decision 2026-08-21): there is nothing to resume, so the record comes back
    // with a new conversation rather than not at all. Every other refusal is
    // still a refusal, and the duplicate check below still applies -- two
    // records naming one conversation is a question about which of them is real,
    // and starting one of them fresh would answer it by accident.
    const startsFresh = reason === 'no-transcript';
    if (reason !== null && !startsFresh) {
      skipped.push({ entry, reason });
    } else if (contested) {
      // Two records naming one conversation is either a copied base or a defect
      // of ours, and both readings say the same thing: resuming both is the O3
      // violation itself, and picking one is a judgement about whose notes are
      // real, which belongs to a person and not to a predicate.
      skipped.push({ entry, reason: 'duplicate-session' });
    } else {
      steps.push({
        entry,
        expectedRevision: entry.revision,
        force: demanded !== null,
        intent: startsFresh ? 'launch' : 'resume',
      });
    }
  }
  return { steps, skipped };
}

/**
 * A refusal, in a sentence written for the person who asked.
 *
 * A total record, so a refusal added to the union arrives here with words rather
 * than reaching a person as an empty toast. Sentences and not codes, because
 * this is the answer to "why is my terminal not back" -- the reason is kept per
 * record precisely so that the question has one.
 */
const REFUSAL_WORDS: Readonly<Record<RestoreRefusal, string>> = {
  'closed': 'its terminal was closed on purpose, so there is nothing to bring back',
  'owner-live': 'the window that opened it is still running, and its terminals are its own',
  'owner-unknown': 'the window that opened it has not been heard from, so it may still be there',
  'foreign-folder': 'it belongs to a project this window does not have open',
  'session-running': 'its Claude Code process has not been established to have stopped',
  'session-listed': 'Claude Code names its conversation among the ones it is running',
  'agents-unavailable':
    'Claude Code could not be asked what it is running, and nothing starts on a guess',
  'transcripts-unavailable':
    'the Claude Code conversations could not be listed, so nothing is known to be resumable',
  'no-transcript': 'nothing was ever said in its conversation, so there is nothing to resume',
  'duplicate-session':
    'another record names the same conversation, and resuming both would mix them into one transcript',
};

export function explainRefusal(reason: RestoreRefusal): string {
  return REFUSAL_WORDS[reason];
}

/**
 * Why NOBODY could restore this record: the refusal with the question "which
 * window is asking" taken out of it (M2.15).
 *
 * The cleanup needs this and not the refusal above, because the refusal above
 * is about THIS window. A record refused here for the folder is a record
 * another window resumes, notes and task included, the moment it opens that
 * project -- and a cleanup that read the local answer would carry it off.
 *
 * It is this function and not a second predicate, and that is the same rule
 * M2.14 followed: two answers to "may this record be brought back" drift where
 * nobody looks, and the drift is measured in `claude --resume` processes on one
 * transcript. What it takes out is exactly what the `demanded` flag takes out
 * -- the folder and a silent owner -- so a change to that flag is a change
 * here, and the cleanup's own suite is what would say so.
 */
export function refusalAnywhere(
  entry: TerminalEntry,
  inputs: RestoreInputs
): RestoreRefusal | null {
  return refusalFor(entry, inputs, listedSessions(inputs.agents), true);
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
  listed: ReadonlySet<string> | null,
  demanded: boolean
): RestoreRefusal | null {
  if (!entry.isRestorable()) {
    return 'closed';
  }
  const liveness = inputs.ownerLiveness.get(entry.owner.ownerId.value) ?? 'unknown';
  if (liveness === 'live') {
    // The one refusal a demand may never lift: that window is there, it owns
    // the record and it is the writer of it (§4.8) -- and it may be resuming
    // that very conversation while this is being read.
    return 'owner-live';
  }
  if (liveness !== 'dead' && !demanded) {
    return 'owner-unknown';
  }
  if (!demanded && !belongsHere(entry.owner.workspaceFolder, inputs.windowFolders)) {
    return 'foreign-folder';
  }
  return conversationRefusal(entry, inputs, listed);
}

/**
 * What is true about the CONVERSATION, with every question about ownership taken
 * out: is a process still on it, does the CLI name it, was anything ever said in
 * it.
 *
 * Its own function because two callers need exactly this half and needing it is
 * not the same as being allowed to write it again (M2.23). The rules here are
 * the ones that keep a second `claude --resume` off a live transcript, which is
 * the failure the whole design is built against -- so there is one copy, and the
 * order of it is `planRestore`'s own.
 */
function conversationRefusal(
  entry: TerminalEntry,
  inputs: RestoreInputs,
  listed: ReadonlySet<string> | null
): RestoreRefusal | null {
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
 * Why the window that OWNS a record may not start its conversation again
 * (M2.23).
 *
 * The other question the same world answers, and the one nothing asked until a
 * person exited Claude Code with Ctrl+C and found the row could do everything
 * except the one thing they wanted. `planRestore` decides what a window may
 * bring back UNASKED, over records belonging to windows that are gone; this
 * decides what a person may ask for about a record their own window is holding.
 *
 * **Three refusals do not apply, and none of them is relaxed away.** `owner-live`
 * is the rule that keeps windows off each other's records -- asked here it
 * answers about the asker itself. `owner-unknown` is the same rule waiting. And
 * `foreign-folder` is §6's automatic narrowing, which a person standing in front
 * of the row has already answered by asking. Everything about the conversation
 * stays, exactly as `demanded` leaves it (M2.14).
 *
 * **`closed` is not answered here either, and that is the one deliberate
 * difference.** It is not a fact about the world but an intention -- this person's
 * own, from an hour ago -- and the same person may reverse it. Doing so is the
 * caller's business, in front of a dialog that says what is being reversed
 * (`TerminalEntry.reopened`).
 *
 * The duplicate check is kept, because it is about the conversation: another
 * record that could still be resumed and names the same session is the О3 hazard
 * whoever asks.
 *
 * **`no-transcript` is not a refusal but the second answer, and the customer
 * had to find that for us (2026-08-21).** The owner decided the same day that a
 * record nothing was said in comes back with a NEW conversation, and
 * `planRestore` has answered that way since -- but only when a window starts up.
 * The green button on the row went on refusing, so a terminal opened, never
 * typed in and closed came back by itself at the next start and would not come
 * back when asked for. One rule, asked twice, must not give two answers.
 */
export function resumeIntent(entry: TerminalEntry, inputs: RestoreInputs): ResumeDecision {
  const refusal = conversationRefusal(entry, inputs, listedSessions(inputs.agents));
  // The same reading `planRestore` makes of the same refusal (owner's decision
  // 2026-08-21): nothing was ever said, so there is nothing to resume -- and the
  // answer to that is a new conversation in the same record, not a closed door.
  const startsFresh = refusal === 'no-transcript';
  if (refusal !== null && !startsFresh) {
    return { kind: 'refused', reason: refusal };
  }
  const contested = inputs.entries.some(
    (other) =>
      !other.terminalId.equals(entry.terminalId) &&
      other.isRestorable() &&
      other.sessionId.equals(entry.sessionId)
  );
  if (contested) {
    return { kind: 'refused', reason: 'duplicate-session' };
  }
  return { kind: 'start', intent: startsFresh ? 'launch' : 'resume' };
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

/**
 * The refusals a person is NOT told about out loud, and why each one is quiet.
 *
 * Silence here is not politeness: every one of these three is a state the person
 * either created or is already looking at, and a notification about it would be
 * a window that interrupts on every start.
 */
const QUIET_REFUSALS: ReadonlySet<RestoreRefusal> = new Set<RestoreRefusal>([
  /** Every terminal of every other project on the machine. It would drown the rest. */
  'foreign-folder',
  /** The person's own decision, from an hour ago. */
  'closed',
  /** Another window is holding that record and showing it right now. */
  'owner-live',
]);

/**
 * One sentence about the terminals that did not come back, or `null`.
 *
 * **The gap this closes, met by the owner on 2026-08-21.** Four records were
 * refused, the reason was written to the log in the same second, and nothing at
 * all reached the screen -- so from the chair it read as terminals silently
 * vanishing. The refusals have carried a sentence apiece since M2.14; they were
 * simply never said unless the person went and ASKED, through Adopt or Resume.
 *
 * A sentence rather than a line per record: a machine with several projects open
 * refuses by the dozen, and a person reading twelve toasts reads none of them.
 * WHICH records is the log's business, and the sentence says so.
 */
export function restoreNotice(skipped: readonly RestoreSkip[]): string | null {
  const loud = skipped.filter((skip) => !QUIET_REFUSALS.has(skip.reason));
  const [first] = loud;
  if (first === undefined) {
    return null;
  }
  if (loud.length === 1) {
    // Named, because with one record the name is the most useful thing there is.
    return `Gripterm did not bring "${first.entry.metadata.displayName}" back — ${explainRefusal(first.reason)}. See the Gripterm log.`;
  }
  const reasons = [...new Set(loud.map((skip) => skip.reason))].map(explainRefusal);
  return `Gripterm did not bring ${String(loud.length)} terminals back — ${reasons.join('; ')}. See the Gripterm log for which.`;
}
