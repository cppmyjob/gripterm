import { belongsHere } from './folder-path';
import { isWitnessedEnd } from './terminal-state-machine';
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
  /**
   * Nothing we hold says whether its `claude` is running or gone: the record
   * names no process at all.
   *
   * A refusal of its own rather than a wording of the one above, and the
   * difference is the whole of Ш7а. Both keep the record out of the plan --
   * the cost is one-sided and that does not change -- but `session-running` is
   * a CLAIM about a process and this is the absence of one, and until this
   * refusal existed they were one answer.
   *
   * **What that cost, measured against the owner's own store 2026-08-23:**
   * every conversation they had. A record with no pid was reported as one whose
   * process might still be there, and the only thing that would ever have
   * written a pid was the start being refused. A refusal a reader cannot tell
   * from a measurement is a refusal nobody can audit.
   */
  | 'session-unknown'
  /** The CLI names its conversation among the ones it is running. */
  | 'session-listed'
  /**
   * The CLI names the PROCESS this record was running as, under a conversation
   * we do not recognise.
   *
   * The second witness, and a refusal of its own rather than a wording of
   * `session-listed`, because the two are tied by different threads and one of
   * them can be true while the other is false. `session-listed` is our
   * conversation on the CLI's list. This is our PID on it -- while the id
   * beside it is one this record has never claimed.
   *
   * **Why that is not the same question, and why it is asked before a witnessed
   * end is believed.** `witnessed-end` is first-hand and it is also PAST: an
   * event arrived once, or the editor destroyed a terminal object once. The
   * listing is about NOW. So the two do not contradict each other, and the
   * reading that fits both is the dangerous one: the conversation rotated its
   * id, or the CLI printed a session file with no id at all (measured, A24 --
   * those lines are counted in `skipped` and can be matched against nothing of
   * ours). Under either reading a live process is on that transcript, and
   * `--resume` puts a second one there.
   *
   * A pid handed out again to a stranger's `claude` would refuse a record that
   * could have come back. That is the cheap side of the trade, by design: this
   * whole function fails towards refusal, and the listing is a second opinion
   * that may only ever ADD prohibitions.
   */
  | 'process-listed'
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
 *   4. Then liveness of the conversation, in the order of what each source can
 *      be about: the machine's list of what is running NOW, then our own
 *      evidence of what happened -- see below.
 *   5. Then the transcript, LAST of the per-record rules, so that a running
 *      conversation is never reported as "nothing was ever said here". That
 *      reason becomes an offer to start over (M2.13), and offering to start over
 *      on a live conversation is the mistake this whole function exists to
 *      prevent.
 *   6. Then, across the survivors, the duplicate check.
 *
 * WHY SILENCE FROM THE CLI IS NOT PERMISSION (measured, A24 + A22 §1). `claude
 * agents --json` is a projection of `~/.claude/sessions/<pid>.json`, and an
 * interactive session that is up but idle was measured NOT to appear there at
 * all for a full minute. So an empty listing is compatible with a live
 * conversation, and our own `observed` state -- the pid the CLI told us (A16)
 * and the moment we last heard from it -- has to carry the case where the list
 * says nothing. A listing that could not be read at all stops the plan entirely
 * rather than emptying it, because "we did not ask" and "nothing is running"
 * are the same value only in code that is about to be wrong.
 *
 * WHAT THE LIST SAYS WHEN IT DOES SPEAK, HOWEVER, OUTRANKS ALL OF IT (Ш7б).
 * The two directions are not symmetrical and never were: absence from the list
 * is not evidence, PRESENCE on it is -- the CLI has already filtered its
 * answer by process liveness and start time. So the list is still a second
 * opinion that can only ADD prohibitions, and it is asked first for exactly
 * that reason: every rule after it can only let a record through, and none of
 * them is about now. `witnessed-end` says an end HAPPENED; it does not say that
 * nothing is on that conversation at this moment, and believing it over a
 * process the machine says it is running is how one transcript gets two
 * `claude` writing into it.
 */
export function planRestore(inputs: RestoreInputs): RestorePlan {
  const running = runningNow(inputs.agents);
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
    const reason = refusalFor(entry, inputs, running, demanded !== null);
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
  'session-unknown':
    'we never learned which process was running it, so nothing here says whether one still is',
  'session-listed': 'Claude Code names its conversation among the ones it is running',
  'process-listed':
    'Claude Code still has the process it was running as, under a conversation this record does not name',
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
  return refusalFor(entry, inputs, runningNow(inputs.agents), true);
}

/**
 * What the machine says it is running, in the two shapes these rules ask about
 * -- or `null` when it could not be asked.
 *
 * **Both shapes, because a record and a running session are tied by two
 * different threads and either can be the only one there.** The conversation is
 * the obvious one. The process is the one that was in this value all along and
 * that nothing read: `AgentRecord.pid` has been carried since the listing was
 * first parsed, and the planner reduced the whole list to session ids and threw
 * the processes away. That is the gap the register of open questions has called
 * "the risk of a double `--resume` from `isWitnessedEnd`" since 2026-08-23.
 *
 * Neither set is ever checked against the CLI's own judgement of liveness,
 * because it has already made it: the list is filtered by process liveness and
 * start time (measured, A24). A pid on it is a `claude` that is up.
 *
 * Both sets can only ever ADD prohibitions, and that is the only direction a
 * second opinion is allowed to move.
 */
interface RunningNow {
  readonly sessions: ReadonlySet<string>;
  readonly pids: ReadonlySet<number>;
}

function runningNow(agents: AgentListing): RunningNow | null {
  if (agents.kind === 'unavailable') {
    return null;
  }
  const pids = new Set<number>();
  for (const agent of agents.agents) {
    if (agent.pid !== null) {
      pids.add(agent.pid);
    }
  }
  return { sessions: new Set(agents.agents.map((agent) => agent.sessionId.value)), pids };
}

function refusalFor(
  entry: TerminalEntry,
  inputs: RestoreInputs,
  running: RunningNow | null,
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
  return conversationRefusal(entry, inputs, running);
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
  running: RunningNow | null
): RestoreRefusal | null {
  // The rule that answered arrives here BY NAME, so this decision -- and the
  // line the orchestrator logs, which counts refusals -- says why the
  // conversation was left alone and not merely that it was.
  const liveness = REFUSAL_FOR_LIVENESS[livenessRule(entry, inputs, running)];
  if (liveness !== null) {
    return liveness;
  }
  if (running === null) {
    return 'agents-unavailable';
  }
  if (entry.claimsAnyOf(running.sessions)) {
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
  const refusal = conversationRefusal(entry, inputs, runningNow(inputs.agents));
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
 * WHICH rule answered "may its conversation still be running", and therefore
 * what the answer rests on.
 *
 * A name and not a boolean, and that is the whole of Ш7а. `true` can carry a
 * verdict and nothing else, so "it names a pid and nothing established that pid
 * to be gone" and "it names no process at all" arrived at the caller as one
 * value -- and the second was then reported, to a person and to the log, in the
 * words of the first. That is not a wording defect. It is a claim standing in
 * for the absence of one, and it is what `session-unknown` above was written
 * for.
 *
 * The rules are in the order they are asked, and the order is the design:
 * evidence of life NOW outranks every reading of the past, first-hand evidence
 * of an end outranks the clock, and the clock outranks the pid.
 */
type LivenessRule =
  /**
   * The machine lists a live agent process bearing the pid this record names.
   *
   * First because it is the only rule here about the present. Every other one
   * reads something that happened -- an event that arrived, a stamp, a probe --
   * and answers a question about now out of it.
   */
  | 'pid-listed-running'
  /** `SessionEnd` arrived, or the editor destroyed the terminal. First-hand, and it settles it. */
  | 'witnessed-end'
  /**
   * The snapshot is one the store INVENTED, so none of it is evidence of
   * anything.
   *
   * Before the clock rule, and that is the whole of it: the stand-in's
   * `lastEventAt` is the record's own creation time (`ObservedState.provenance`),
   * so a terminal made three days ago and busy five minutes ago comes back as
   * "older than the boot" on the strength of a timestamp nobody measured.
   */
  | 'snapshot-recovered'
  /** Its last sign of life predates this boot, so it describes a previous life. */
  | 'older-than-the-boot'
  /** The pid it names was ESTABLISHED to be gone. */
  | 'pid-established-gone'
  /** It names a pid, and nothing established that pid to be gone. */
  | 'pid-not-established-gone'
  /** It names no process at all. Evidence of nothing, in either direction. */
  | 'no-pid';

/**
 * What the plan does about each rule, in one place a reader can count.
 *
 * `null` is "this rule settles that nothing is running there, so the next
 * question may be asked". A total record, so a rule added above cannot be
 * answered by accident: the compiler asks what it means before it can fire.
 *
 * **The last two lines are the point.** Both refuse -- the cost is one-sided
 * and that has not changed -- but they refuse with DIFFERENT words, because one
 * of them is a measurement and the other is the absence of one. The
 * orchestrator counts refusals by name (`records this window did not bring
 * back, by reason`), so this is also the line that decides whether a person
 * reading their own log can tell "its process answers" from "we know nothing
 * about it", which is exactly what nobody could tell on 2026-08-23.
 */
const REFUSAL_FOR_LIVENESS: Readonly<Record<LivenessRule, RestoreRefusal | null>> = {
  'pid-listed-running': 'process-listed',
  // The same refusal `no-pid` gets, and deliberately the same one: both are the
  // absence of a claim rather than a claim, and the escape out of both is the
  // same door -- a first-hand end reaching the record, or any real event at all,
  // either of which replaces the invented snapshot with an observed one.
  'snapshot-recovered': 'session-unknown',
  'witnessed-end': null,
  'older-than-the-boot': null,
  'pid-established-gone': null,
  'pid-not-established-gone': 'session-running',
  'no-pid': 'session-unknown',
};

/**
 * Our own evidence about the conversation, as the rule that spoke for it.
 *
 * The boot rule outranks the pid, and it carries the common case: after a
 * machine restart every stored pid is a number from a previous life, and Windows
 * hands pids out again aggressively, so a plain probe would answer "there" for
 * whichever of them a stranger now holds -- and that window's terminals would
 * quietly never come back. An observed state older than the boot cannot be
 * describing a process alive now, whatever the pid says today.
 *
 * A record with no pid at all is still kept out of the plan, because the
 * expensive mistake is one-sided. What changed is that it is no longer kept out
 * under another rule's name: `no-pid` comes back as itself, and the caller then
 * says out loud that nothing was established rather than that something was.
 */
function livenessRule(
  entry: TerminalEntry,
  inputs: RestoreInputs,
  running: RunningNow | null
): LivenessRule {
  const { observed } = entry;
  /*
   * **The second witness, asked before anything else is believed (Ш7б).**
   *
   * Every other rule below reads the past. This one reads the present: the CLI
   * has filtered its list by process liveness and start time already (measured,
   * A24), so a pid on it is a `claude` that is up right now -- and if it is the
   * pid this record was running as, something is on that conversation whatever
   * our own history of it says.
   *
   * It goes first for that reason and not for tidiness. `witnessed-end` is
   * first-hand evidence that an end HAPPENED; it is not evidence about now, and
   * believing it over a live process is how one transcript gets two `claude`
   * writing into it. The rules below it can only ever pass a record on, so
   * asking this one first can only ever take cases away from them.
   *
   * A record with no pid reaches nothing here, because there is no thread to
   * follow: `null` is not compared against the set, it simply is not in it.
   */
  if (observed.pid !== null && running?.pids.has(observed.pid) === true) {
    return 'pid-listed-running';
  }
  /*
   * A witnessed end IS the evidence this predicate is asking for, and leaving it
   * out cost the owner every conversation they had.
   *
   * **Measured against their own store, 2026-08-23.** Two records with real
   * conversations behind them would not come back after a restart; the planner,
   * run offline over the store on disk, answered `session-running` for both.
   * Their state was `ended` -- the editor had destroyed the terminal and said so
   * -- and their pid was `null`, so the pid rule below read "no pid, therefore
   * it may be running" and refused. Nothing then started them, so nothing ever
   * wrote a pid, so the next window refused them again. A loop with no way out
   * of it but a reboot, which is what `precedesBoot` was quietly doing for
   * everybody until a machine stayed up.
   *
   * That reading is gone: `no-pid` is now an answer of its own, and it is the
   * reason the two halves of this defect could be told apart at all.
   *
   * `isWitnessedEnd` is first-hand and nothing else is let in: `ended` and
   * `resume_failed` are `SessionEnd` arriving or the editor destroying the
   * terminal object, and a process whose pty is gone is gone with it (A15,
   * A29). `orphaned` and `degraded` are this build's own guesses and stay
   * exactly as suspicious as they were.
   */
  if (isWitnessedEnd(observed.state)) {
    return 'witnessed-end';
  }
  /*
   * **A snapshot nobody observed, kept out of the clock's way (defect 8).**
   *
   * When `observed.json` is gone the codec stands one up so that the record is
   * not lost with its cache, and it stamps it with the record's creation time
   * because that is the only honest stamp there is. The boot rule then reads a
   * creation time from before this boot exactly as it reads a real last event --
   * "it describes a previous life" -- and lets the record through.
   *
   * The two are indistinguishable by looking, which is why the codec now says
   * which it is. `remove()` used to manufacture this very shape out of a record
   * a person had asked to delete, by moving the snapshot to the trash before the
   * record; it moves the record first now, for this reason.
   */
  if (observed.provenance === 'recovered') {
    return 'snapshot-recovered';
  }
  if (precedesBoot(observed.lastEventAt.getTime(), inputs.nowMs, inputs.uptimeSeconds)) {
    return 'older-than-the-boot';
  }
  /*
   * **The line the plan of 2026-08-24 said to DELETE as equivalent, kept -- and
   * the acceptance it came from is what is out of date.**
   *
   * The mutation run of that day found both mutants on this line surviving, and
   * the plan diagnosed them correctly: while this function answered a boolean,
   * removing the line changed nothing, because `deadPids` is a
   * `ReadonlySet<number>`, `Set.prototype.has(null)` is `false` at run time, and
   * `!false` is the `true` this line returned. The same value by another road,
   * so no test could ever have told the two programs apart.
   *
   * That equivalence was a fact about the RETURN TYPE and it died with it.
   * `no-pid` and `pid-not-established-gone` are different names now, the map
   * above turns them into different refusals, and the log counts them apart --
   * so falling through to the pid comparison would answer a question about a
   * pid that does not exist, and would lose precisely the distinction this step
   * exists to create. The mutants are killable here for the first time, by
   * `session-unknown` in the table of refusals.
   */
  if (observed.pid === null) {
    return 'no-pid';
  }
  return inputs.deadPids.has(observed.pid) ? 'pid-established-gone' : 'pid-not-established-gone';
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
