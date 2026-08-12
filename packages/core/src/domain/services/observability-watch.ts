import { isWitnessedEnd } from './terminal-state-machine';
import type { Disposable } from '../ports/disposable';
import type { Logger } from '../ports/logger';
import type {
  RegistryChange,
  SessionRegistry,
  UnknownConversationChange,
} from './session-registry';
import type { Scheduler } from '../ports/scheduler';
import type { SessionId } from '../entities/session-id';
import type { TerminalEntry } from '../entities/terminal-entry';

/**
 * How long a starting terminal may say nothing before we call it unobserved.
 *
 * Long enough to clear a cold start with room to spare: `claude --version`
 * answers in 264 ms (measured), the TUI's first output came at 31 ms (A13), and
 * the `SessionStart` forwarder is a node process start on top of that. Short
 * enough that a person who started a terminal is still looking at it.
 */
export const DEFAULT_SILENCE_MS = 20_000;

/** A terminal that started and has said nothing since. */
export interface SilentTerminal {
  readonly kind: 'silent';
  readonly entry: TerminalEntry;
  readonly silenceMs: number;
}

/**
 * A terminal whose row says its conversation is over, and which is answering a
 * conversation this window never saw begin.
 *
 * The two halves are what make it reportable. Either alone is ordinary: a record
 * at a witnessed end is what every finished terminal looks like, and an event
 * from an unrecognised session is a refusal §4.6 makes several times during a
 * normal `/clear`. Together they are a contradiction that can only be resolved
 * one way -- something is plainly still talking, so the row is wrong.
 */
export interface StrandedTerminal {
  readonly kind: 'stranded';
  readonly entry: TerminalEntry;
  /** The conversation nobody announced. It is the only handle on it that exists. */
  readonly sessionId: SessionId;
}

/** What this watch found. Both are "the row is not tracking the terminal". */
export type WatchReport = SilentTerminal | StrandedTerminal;

export interface ObservabilityWatchOptions {
  readonly registry: SessionRegistry;
  readonly scheduler: Scheduler;
  /** Says it where a person will see it. The log line is written here regardless. */
  readonly announce: (report: WatchReport) => void;
  readonly logger: Logger;
  readonly silenceMs?: number;
}

/**
 * The two checks that cover the causes nobody listed.
 *
 * §4.7 states the first rule and states it as a correction: reading settings can
 * only find the blockers we know the names of, while "started, and has sent
 * nothing for N seconds" covers `disableAllHooks`, an administrator's
 * `allowManagedHooksOnly`, a CLI whose hook contract moved, an interpreter that
 * is not there, a filtered URL and our own mistake in the settings file -- with
 * one rule that does not age with a version number.
 *
 * WHAT COUNTS AS PROOF OF LIFE is any transition at all, including one the state
 * machine ignored. The question there is not whether the event was useful; it is
 * whether the channel exists.
 *
 * **The second rule is M2.8's, and it exists because the first one covered
 * nothing here.** This doc used to claim that the silence timer caught the limit
 * M1.9 named -- a terminal whose `SessionStart` never arrived after `/clear`,
 * refusing every event of the new conversation and sitting in `ended` while
 * somebody types into it. It did not: the timer arms only for a record that
 * claims to be `launching` and settles for good on its first event, so a
 * terminal that goes wrong an hour into its life was watched by nobody at all.
 *
 * What catches it is the refusal itself. An event from a conversation the record
 * has never had, arriving at a record that says its conversation is over, is a
 * contradiction: something is talking, so the row is stale. That pair is
 * reported once per conversation -- see `_onUnknownConversation` for why both
 * halves are required and why the id is not simply adopted.
 *
 * There is still no self-repair for it. The rename would have to be invented
 * from a signal we have not measured, and the cost of getting it wrong is a
 * record pointing at the wrong conversation -- which is a restore, later, onto a
 * conversation the person never asked for (§8.2). Saying so is what this class
 * can honestly do.
 */
export class ObservabilityWatch implements Disposable {
  private readonly _options: ObservabilityWatchOptions;
  private readonly _waiting = new Map<string, Disposable>();
  /** Terminals already decided about: heard from, announced, or dead. */
  private readonly _settled = new Set<string>();
  /** Terminal id -> the unannounced conversation we last reported for it. */
  private readonly _stranded = new Map<string, string>();
  private readonly _subscription: Disposable;

  constructor(options: ObservabilityWatchOptions) {
    this._options = options;
    this._subscription = options.registry.subscribe((change) => {
      this._onChange(change);
    });
  }

  public dispose(): void {
    this._subscription.dispose();
    for (const timer of this._waiting.values()) {
      timer.dispose();
    }
    this._waiting.clear();
  }

  private _onChange(change: RegistryChange): void {
    if (change.kind === 'unknown-conversation') {
      this._onUnknownConversation(change);
      return;
    }
    if (change.kind === 'removed') {
      // A timer left running for a record a person has just deleted announces
      // "Gripterm is not seeing this terminal" about a terminal nobody is
      // looking for -- twenty seconds later, with no row on screen to explain
      // it.
      //
      // The wait is dropped and nothing is remembered, which is the smaller of
      // the two promises available here: `_settled` would additionally say that
      // this id is never watched again, and that is a claim about a record
      // coming back from the dead which nothing today can make true or false.
      this._stopWaiting(change.terminalId.value);
      // Everything remembered about a record goes when the record does. A
      // restored one is a new record here, and the person who has just been
      // given it back is owed the same warning as the first time.
      this._stranded.delete(change.terminalId.value);
      return;
    }
    if (change.kind !== 'entry') {
      // A record another window owns is that window's to watch, and it is
      // watching. Starting a silence timer for one here would announce "Gripterm
      // is not seeing this terminal" about a terminal we were never wired to
      // -- true, useless, and indistinguishable from the failure this class
      // exists to report.
      return;
    }

    const id = change.entry.terminalId.value;
    if (this._settled.has(id)) {
      return;
    }

    if (change.transition !== null) {
      // Something arrived and was routed to this record. That is the whole of
      // the question -- a terminal that has been heard from once is a terminal
      // whose channel exists, and the states after that are the tree's business.
      this._settle(id);
      return;
    }

    // A registration or an amendment. Only a record that claims to be starting
    // owes us an event: `launching` is the one state that means "a process was
    // just asked to exist and has not reported in".
    if (change.entry.observed.state !== 'launching' || this._waiting.has(id)) {
      return;
    }

    const silenceMs = this._options.silenceMs ?? DEFAULT_SILENCE_MS;
    this._waiting.set(
      id,
      this._options.scheduler.after(silenceMs, () => {
        this._onSilent(change.entry, silenceMs);
      })
    );
  }

  /**
   * An event refused as belonging to a conversation this record never had.
   *
   * **Both halves are required, and the second one is the whole of the safety
   * here.** A refusal on its own says only that something we do not recognise
   * posted to this terminal's address, and this build has not measured
   * everything that can: a hook from a part of the CLI we have not met would
   * arrive exactly like a missed `SessionStart`, and a warning on every one of
   * those would be a warning nobody reads. Adding "the record says its
   * conversation is over" removes that whole class -- a conversation the CLI
   * itself considers finished is not producing prompts -- and leaves the case
   * this is for: `/clear` whose `SessionEnd` arrived over HTTP and whose
   * `SessionStart` did not (H1).
   *
   * **The id is reported, not adopted.** Renaming the record onto it would make
   * the row right again in the common case and would, in the case we have not
   * measured, point the record at a conversation that is not the terminal's --
   * which a restore turns into `claude --resume` on somebody else's history
   * (§8.2). Reporting is reversible; renaming is not.
   *
   * Once per conversation, because everything the person types from here on
   * arrives the same way. A second `/clear` with the forwarder still dead is a
   * new id and is said again: the terminal is stranded a second time, on a
   * handle the person has not been given.
   */
  private _onUnknownConversation(change: UnknownConversationChange): void {
    const id = change.entry.terminalId.value;
    if (!isWitnessedEnd(change.entry.observed.state)) {
      return;
    }
    if (this._stranded.get(id) === change.sessionId.value) {
      return;
    }
    this._stranded.set(id, change.sessionId.value);
    this._options.logger.warn('a terminal is answering a conversation this window never saw begin', {
      terminalId: id,
      displayName: change.entry.metadata.displayName,
      state: change.entry.observed.state,
      recorded: change.entry.sessionId.value,
      arrived: change.sessionId.value,
    });
    this._options.announce({ kind: 'stranded', entry: change.entry, sessionId: change.sessionId });
  }

  private _settle(id: string): void {
    this._stopWaiting(id);
    this._settled.add(id);
  }

  private _stopWaiting(id: string): void {
    this._waiting.get(id)?.dispose();
    this._waiting.delete(id);
  }

  private _onSilent(entry: TerminalEntry, silenceMs: number): void {
    this._settle(entry.terminalId.value);
    // Both, and for different readers. The notification reaches the person who
    // pressed the button and is gone in seconds; the log line is what remains
    // to be read beside the hook policy report written at activation, which is
    // where the reason usually is.
    this._options.logger.warn('a terminal has been running without sending a single event', {
      terminalId: entry.terminalId.value,
      displayName: entry.metadata.displayName,
      silenceMs,
    });
    this._options.announce({ kind: 'silent', entry, silenceMs });
  }
}
