import { ConflictError } from '../errors/gripterm-error';
import { actsOnTheTerminal } from './terminal-presentation';
import { HumanMetadata } from '../entities/human-metadata';
import { ObservedState } from '../entities/observed-state';
import { SessionId } from '../entities/session-id';
import { TerminalEntry } from '../entities/terminal-entry';
import { TerminalId } from '../entities/terminal-id';
import { launchExitedNonZero, resumeExited, terminalClosed } from '../events/terminal-event';
import { observedAtStart } from './observed-projection';
import type { AgentCommandFactory } from '../ports/agent-command-factory';
import type { Clock } from '../ports/clock';
import type { Disposable } from '../ports/disposable';
import type { IdGenerator } from '../ports/id-generator';
import type { LaunchIntent } from '../entities/launch-intent';
import type { LaunchRecipe } from '../entities/launch-recipe';
import type { LaunchStrategy } from './launch-strategy';
import type { LaunchTrace } from '../ports/launch-trace';
import type { Logger } from '../ports/logger';
import type { OwnerRef } from '../entities/owner-ref';
import type { PersistedTerminalState } from '../entities/terminal-state';
import type { SessionRegistry } from './session-registry';
import type { TerminalEvent } from '../events/terminal-event';
import type { TerminalExit, TerminalGateway, TerminalHandle } from '../ports/terminal-gateway';

export interface TerminalLifecycleOptions {
  readonly registry: SessionRegistry;
  readonly gateway: TerminalGateway;
  readonly commands: AgentCommandFactory;
  readonly strategy: LaunchStrategy;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  /** This window, as recorded on every terminal it creates. One owner per window (M1.13). */
  readonly owner: OwnerRef;
  readonly logger: Logger;
  /**
   * Where a start writes down what it did, so that the answer outlives the
   * window (owner, 2026-08-23 -- see `LaunchTrace`).
   *
   * Optional because a lifecycle can be built with no store behind it: the
   * contract suite makes several per run, and a window that is not sharing has
   * no directory to write beside.
   */
  readonly trace?: LaunchTrace;
}

/** What a new terminal needs that is not the same for all of them. */
export interface LaunchRequest {
  /** The name in the list. `defaultTerminalName` produces one when nobody has. */
  readonly displayName: string;
  readonly recipe: LaunchRecipe;
}

/**
 * What `discard` did.
 *
 * Three answers rather than a boolean, because the caller says something
 * different about each: a person who asked to delete a running terminal is told
 * to close it first, and a person whose record had already gone is told nothing
 * at all -- the thing they wanted is already true.
 */
export type DiscardOutcome = 'discarded' | 'still-running' | 'unknown-terminal';

/**
 * What `startOver` did.
 *
 * The same three answers as `discard` and for the same reason -- each is a
 * different sentence to the person who asked -- except that the first one
 * carries the record it made, because that is what the caller shows them.
 */
export type StartOverOutcome =
  | { readonly kind: 'started', readonly entry: TerminalEntry }
  | { readonly kind: 'still-running' }
  | { readonly kind: 'unknown-terminal' };

/**
 * What to do with the pane once the process is running.
 *
 * Two values rather than a boolean, because the call site is where this is read:
 * `start(entry, 'resume', 'hidden')` says what happens, and `start(entry,
 * 'resume', false)` says nothing at all.
 *
 * It is NOT derived from the intent, although today the two agree. A restore
 * started by the window at activation is nobody's request and must not take the
 * screen; a restore started by a person pressing "adopt" (M2.14) is exactly
 * their request. The caller knows which it is and nothing else does -- the same
 * reason `LaunchIntent` is a parameter (§4.4).
 */
export type StartVisibility =
  /** Somebody pressed a button: show the terminal and put the cursor in it. */
  | 'focus'
  /** Nobody asked: create it and leave the screen alone (M2.11). */
  | 'hidden';

/** What a terminal was doing between being started and being closed. */
interface Watched {
  readonly handle: TerminalHandle;
  /** Why it was started, kept because the exit code alone cannot say. See `deathEvent`. */
  readonly intent: LaunchIntent;
  readonly subscription: Disposable;
}

/**
 * The one place a terminal is created or destroyed.
 *
 * Single on purpose (§10.1): the commands of M1.12 are thin wrappers, the
 * restore of M2.11 calls the same `start` with `intent: 'resume'`, and the
 * workflow engine of §4.12 will call it too rather than invoking commands. A
 * second creation path is how two of the three grow a subtly different idea of
 * what a terminal is.
 *
 * **Every start stamps the record `launching`**, and that is a rule rather than
 * bookkeeping: three things downstream ask for that state and nothing else sets
 * it on the restore path (see `observedAtStart`). Putting it in each caller
 * would be three chances to forget it, and forgetting it is silent.
 *
 * **It knows which agent it is starting only through `AgentCommandFactory`.**
 * The flags belong to one CLI and live under `domain/agents/`; the linter fails
 * the build if this file reaches for them.
 *
 * **A closing terminal cannot be read from its exit code alone, and that is
 * measured, not assumed.** A15, closed 2026-08-11 in a live editor: the platform
 * raises the close event for a terminal WE destroyed exactly as it does for one
 * a person closed -- `exitStatus.code` is `undefined` in both cases. So the
 * service remembers what it started and why, and names the death event from
 * that (`deathEvent`).
 */
export class TerminalLifecycleService implements Disposable {
  private readonly _options: TerminalLifecycleOptions;
  private readonly _watched = new Map<string, Watched>();

  constructor(options: TerminalLifecycleOptions) {
    this._options = options;
  }

  /** A terminal that did not exist before: new ids, a fresh record, `launching`. */
  public async launch(request: LaunchRequest): Promise<TerminalEntry> {
    const metadata = HumanMetadata.create({
      displayName: request.displayName,
      task: null,
      notes: [],
      tags: [],
      color: null,
    });
    return await this.start(this._fresh(metadata, request.recipe), 'launch');
  }

  /**
   * The conversation could not be continued, so the work moves to a new one
   * (M2.13).
   *
   * A NEW record rather than a new id on the old one, and that is the whole
   * design. The conversation that failed still exists in the CLI's store, still
   * answers `claude --resume <id>` by hand, and may still be named by `agents
   * --json`; a record that went on claiming it would veto its own restore
   * (M2.10) and would route that conversation's late events into the new work.
   * So the old record is archived whole -- to `trash/`, with its history and its
   * journal -- and what crosses over is the part a person cannot rebuild: the
   * name, the task, the notes, the tags, and the recipe that says which project
   * this is.
   *
   * **Refused while the record says a conversation is running**, by the same
   * rule `discard` uses -- `_releasedItsPane` -- and for a sharper reason. A
   * restore that failed in the editor leaves a LIVE `claude` in an open pane --
   * measured, A26: the process prints its refusal and does not exit, so the row
   * reaches `degraded` rather than any end state -- and starting over on top of
   * that is precisely how one terminal becomes two (О3). That pane is not
   * closed for them: it is not ours to kill, and nothing here establishes that
   * anything is wrong with it. A pane held for a record that IS over is the
   * other case, and that one goes; see the rule.
   *
   * **The archive happens last.** Reversed, a start that threw would leave the
   * person with nothing on screen and their notes in the trash; this way the
   * worst case is two rows, which they can see and act on (§I.3).
   */
  public async startOver(terminalId: TerminalId): Promise<StartOverOutcome> {
    if (!this._releasedItsPane(terminalId, 'started over')) {
      return { kind: 'still-running' };
    }

    const old = this._options.registry.get(terminalId);
    if (old === undefined) {
      this._options.logger.info('starting over named a terminal this window does not hold', {
        terminalId: terminalId.value,
      });
      return { kind: 'unknown-terminal' };
    }

    const entry = await this.start(this._fresh(old.metadata, old.launch), 'launch');
    this._options.registry.forget(terminalId);
    this._options.logger.info('a terminal was started over', {
      terminalId: entry.terminalId.value,
      archived: terminalId.value,
      // The conversation the person is walking away from, said out loud because
      // this id is now the only handle on it anywhere: the record that named it
      // has just been archived, and `claude --resume <id>` is what reaches it.
      leftBehind: old.sessionId.value,
    });
    return { kind: 'started', entry };
  }

  /**
   * Starts the process for a record that already exists.
   *
   * `intent` is the caller's knowledge and cannot be recovered from the entry:
   * `sessionId` is populated on both paths, and the CLI refuses `--session-id`
   * together with `--resume`. It is also the only thing that will separate
   * `launch_failed` from `resume_failed` when the process exits non-zero, since
   * both happen in `launching` (§4.3).
   */
  /**
   * Starts a record again in a NEW conversation, keeping the record itself.
   *
   * The owner's decision of 2026-08-21, and the one way a terminal whose
   * conversation was never spoken in can come back at all. `--resume` on it is
   * measured to fail -- there is no transcript, the CLI prints "No conversation
   * found" and exits 1 (2026-08-10, and again in A45 on 2.1.233) -- and
   * `--session-id` naming the SAME id would be the CLI's other refusal, the one
   * `restore-orchestrator` has a test about. So a new id is drawn here and the
   * old one moves into the history, exactly as it does when somebody types
   * `/clear` (`withSessionId`).
   *
   * The RECORD is kept: its id, name, task and notes are what a person wanted
   * back, and the conversation id it held pointed at nothing. That is the whole
   * difference from `startOver`, which archives the record because there IS a
   * conversation being walked away from.
   */
  public async startAgain(
    entry: TerminalEntry,
    visibility: StartVisibility = 'focus'
  ): Promise<TerminalEntry> {
    return await this.start(
      entry.withSessionId(SessionId.fromString(this._options.ids.newUuid())),
      'launch',
      visibility
    );
  }

  public async start(
    entry: TerminalEntry,
    intent: LaunchIntent,
    visibility: StartVisibility = 'focus'
  ): Promise<TerminalEntry> {
    const { terminalId } = entry;
    if (this._watched.has(terminalId.value)) {
      // Two processes on one conversation is the failure the whole ownership
      // design exists to prevent, and within one window it is cheap to refuse
      // outright rather than to reason about.
      throw new ConflictError('this terminal is already running', {
        details: { terminalId: terminalId.value },
      });
    }

    // From here the record says it is starting, whatever it was doing when its
    // window died. A restored one arrives from the store wearing `working` or
    // `idle`, and three rules downstream -- a non-zero exit read as a FAILED
    // restore (§4.3), the resume timeout, the silence watch -- ask for
    // `launching` and do nothing at all without it.
    const starting = entry.withObserved(observedAtStart(entry.observed, this._options.clock.now()));

    const command = await this._options.commands.commandFor(starting, intent);
    const plan = this._options.strategy.buildPlan({
      terminalId,
      name: starting.metadata.displayName,
      cwd: starting.launch.cwd,
      command,
    });

    // Everything that can fail has failed by now, which is why the record is
    // published here and not earlier: a launch that never produced a terminal
    // leaves no row stuck in `launching` for the life of the window, and the
    // person who pressed the button is told by the caller instead.
    /*
     * Written down BEFORE the create, and on disk rather than only in the log:
     * the one question the owner's window could not answer on 2026-08-23 was
     * whether a restore had asked for `--resume` at all, and by the time it was
     * asked the window -- and its Output panel with it -- was gone.
     *
     * Flag names only, never values: see `LaunchNote`.
     */
    this._options.trace?.note(terminalId, {
      what: 'start',
      intent,
      engine: this._options.gateway.engine,
      executable: command.executable,
      flags: command.args.filter((one) => one.startsWith('--')),
      args: command.args.length,
      session: starting.sessionId.value,
      cwd: starting.launch.cwd,
    });

    let handle: TerminalHandle;
    try {
      handle = await this._options.gateway.create(plan.spec);
    } catch (cause: unknown) {
      // The throw goes on to the caller untouched -- who tells the person is
      // not this method's business. What is its business is that the store
      // says a start was tried and how it ended, which is the difference
      // between "nothing happened" and "this failed".
      this._options.trace?.note(terminalId, { what: 'failed', reason: String(cause) });
      throw cause;
    }
    // The engine goes in from the gateway that just answered, not from the
    // setting that was read at activation, and not before the create either: a
    // record saying `own` for a terminal the editor made would hand
    // reconciliation a live conversation to end (M3.4(4)). A restore stamps it
    // too, which is what stops a record stored by an `own` window claiming that
    // engine in a window that fell back.
    const running = starting.withEngine(this._options.gateway.engine);

    // No `await` between these two. The editor cannot deliver a close event in
    // the middle of synchronous code, so there is no window in which the
    // terminal exists, is registered, and is unwatched.
    this._options.registry.register(running);
    this._watch(handle, intent);

    // Not awaited, and that is the decision: the editor settles this promise
    // when the process is up, and a platform that never settled it would hold
    // every restore of every window behind it. What it costs is that the record
    // is without a pid for a moment after it appears, and a restore in that
    // moment is refused rather than doubled -- the direction every unknown in
    // this project falls (`gatherRestoreInputs`).
    void this._notePid(handle);

    if (plan.initialInput !== null) {
      // `shell` mode only: the command is typed into the person's shell. A11
      // lives exactly here and nowhere else (see `ShellLaunchStrategy`). A12 --
      // the readiness race -- is the port's business now: `runLaunchCommand`
      // promises the line comes after whatever the environment does to a fresh
      // shell, and an adapter that has to wait for that waits without us.
      handle.runLaunchCommand(plan.initialInput);
    }
    if (visibility === 'focus') {
      // Takes the focus: somebody asked for a terminal, and leaving the cursor
      // where it was would be answering a different request.
      handle.show(false);
    }

    this._options.logger.info('a terminal was started', {
      terminalId: terminalId.value,
      sessionId: running.sessionId.value,
      intent,
      visibility,
      mode: this._options.strategy.mode,
      engine: running.engine,
    });
    return running;
  }

  /**
   * Brings a terminal this window started to the front, WITHOUT taking the
   * focus.
   *
   * The other half of `visibility: 'hidden'`, and deliberately not the same
   * operation as `gripterm.focusTerminal`. That one answers a person pressing a
   * button, so it moves the cursor; this one answers a restore that finished on
   * its own, so the pane appears and the cursor stays where the person put it. A
   * window coming back with five terminals would otherwise take the focus five
   * times and leave it wherever the race ended.
   *
   * A terminal that is no longer there is not an error: between a restore
   * starting and its first event, `--resume` can fail and take the pane with it.
   */
  public reveal(terminalId: TerminalId): void {
    const watched = this._watched.get(terminalId.value);
    if (watched === undefined) {
      this._options.logger.info('there was no terminal left to reveal', {
        terminalId: terminalId.value,
      });
      return;
    }
    watched.handle.show(true);
  }

  /**
   * The person is finished with this terminal -- one of the two producers of
   * `closedAt`, and the one they reached through OUR list (§4.2).
   *
   * The other is the same act performed in the editor instead: the cross on the
   * terminal's tab, which arrives at `_onClosed` wearing `reason: 'user'`. Until
   * M2.20 this was the only one, and the argument for that was sound about the
   * wrong field -- our terminals are `isTransient`, so every editor shutdown
   * closes them all, and the exit CODE is `undefined` for that exactly as it is
   * for a deliberate close (A15). Tying `closedAt` to the code would still
   * declare every terminal rubbish at the first restart. `reason` is the field
   * that separates them, and it was there all along (A29).
   *
   * **What `reason` does NOT separate, measured 2026-08-24:** the cross on one
   * tab from `workbench.action.closeAllEditors`, which wears the same word and
   * takes every conversation in the window with it. Both still stop a record
   * coming back by itself; only this one, the one a person reached through our
   * own list, is allowed to feed the sweep that empties the store unasked. That
   * is what the `ClosedBy` argument carries.
   */
  public close(terminalId: TerminalId): void {
    const entry = this._options.registry.get(terminalId);
    if (entry === undefined) {
      this._options.logger.warn('close was asked for a terminal this window does not hold', {
        terminalId: terminalId.value,
      });
      return;
    }

    // Before the destruction, so that a listener told the terminal has ended
    // already sees the record as closed rather than being told twice about one
    // act (M2's persistence subscribes here).
    this._options.registry.amend(entry.withClosed(this._options.clock.now(), 'person'));

    const watched = this._watched.get(terminalId.value);
    if (watched === undefined) {
      // No process of ours to destroy: it is already gone, or this record was
      // restored into the list without being started (M2). The record still has
      // to reach an end state, and nothing else is going to bring it there.
      this._options.registry.ingest(terminalId, terminalClosed());
      return;
    }
    // One path for the state, and it is the measured one: destroying the
    // terminal raises the close event (A15), which lands in `_onClosed` like
    // any other close.
    watched.handle.dispose();
  }

  /**
   * The person is throwing the record away: the row, the name, the task, the
   * notes and the tags (M2.7).
   *
   * What it does NOT touch is the point of the whole operation. The Claude Code
   * conversation is not ours -- it lives in the CLI's own store and this
   * extension never writes there -- and neither is the event journal, which is
   * the one thing in our store no later version can go back for (§10.1а). What
   * goes is our record of the terminal, and it goes to `trash/` rather than to
   * nothing, so the answer to "I did not mean that" is a file move (§I.3).
   *
   * **Refused while the record says a conversation is running, and never on any
   * other ground** -- `_releasedItsPane`, which is where the 2026-08-22
   * correction and the report behind it are written down. A pane this window is
   * still holding for a record that is over goes with the record.
   *
   * It lives on this service and not beside the metadata edits for one reason:
   * that precondition is knowledge only this object has.
   */
  public discard(terminalId: TerminalId): DiscardOutcome {
    if (!this._releasedItsPane(terminalId, 'deleted')) {
      return 'still-running';
    }
    if (!this._options.registry.knows(terminalId)) {
      this._options.logger.info('a deletion named a terminal this window does not hold', {
        terminalId: terminalId.value,
      });
      return 'unknown-terminal';
    }

    this._options.registry.forget(terminalId);
    this._options.logger.info('a terminal record was deleted by the person who owns it', {
      terminalId: terminalId.value,
    });
    return 'discarded';
  }

  public dispose(): void {
    for (const watched of this._watched.values()) {
      watched.subscription.dispose();
    }
    this._watched.clear();
    // The terminals are NOT destroyed. Deactivation is not a decision about
    // anybody's conversation, and `isTransient` takes them when the editor goes.
  }

  /**
   * A record for a conversation that does not exist yet.
   *
   * Both ids are drawn here rather than by the agent's command builder, because
   * `--session-id` on the launch path is US telling the CLI which conversation
   * this is. The record and the process therefore agree on the id before the
   * process exists, which is what makes the first hook event routable.
   */
  private _fresh(metadata: HumanMetadata, launch: LaunchRecipe): TerminalEntry {
    const startedAt = this._options.clock.now();
    return TerminalEntry.create({
      terminalId: TerminalId.fromString(this._options.ids.newUuid()),
      sessionId: SessionId.fromString(this._options.ids.newUuid()),
      owner: this._options.owner,
      metadata,
      launch,
      observed: ObservedState.create({
        // Not `idle`: nothing has been observed yet, and a record that claims to
        // be idle before its process exists is indistinguishable from one whose
        // turn has finished. `launching` is also what makes a non-zero exit
        // readable as a failed launch rather than as an ordinary end (§4.3).
        state: 'launching',
        lastEventAt: startedAt,
        currentTool: null,
        lastAssistantMessage: null,
        cost: null,
        contextWindow: null,
        pid: null,
      }),
      createdAt: startedAt,
    });
  }

  /**
   * Writes down which process the editor started for this terminal.
   *
   * The pid is the only evidence any window has that a conversation has stopped
   * running -- `mayBeRunning` reads its absence as "it may still be going" and
   * refuses to restore -- so the record without one is the record that never
   * comes back. Measured in the acceptance run of M2.16: with no producer at
   * all, every restore was refused with `session-running`.
   *
   * The entry is re-read here rather than closed over. Between the start and
   * this answer a hook can arrive, a person can rename the terminal or delete
   * the row, and writing back the record this method remembers would undo
   * whichever of those happened. A record that is gone is left gone: it is not
   * this window's any more, and `amend` would be right to refuse it.
   */
  private async _notePid(handle: TerminalHandle): Promise<void> {
    const { terminalId } = handle;
    const pid = await handle.processId();
    if (pid === null) {
      // The shape two of the owner's three records were left in on 2026-08-23,
      // and the reason this goes to disk as well as to the log: a terminal with
      // no process is one the editor made and never started, and nothing else
      // in the store says so.
      this._options.trace?.note(terminalId, { what: 'no-pid' });
      this._options.logger.info('the editor did not say which process the terminal is running', {
        terminalId: terminalId.value,
      });
      return;
    }
    this._options.trace?.note(terminalId, { what: 'pid', pid });
    const current = this._options.registry.get(terminalId);
    if (current === undefined) {
      /*
       * The pid has nowhere to go, and it goes into the log instead (Ш3).
       *
       * Silence here and silence on success were the same silence, and this
       * method's own doc says why that could not stand: a record with no pid is
       * a record `mayBeRunning` refuses to restore for ever. So "the editor
       * never named a process" and "it named one and we had already let the
       * record go" have to be different things to read afterwards.
       */
      this._options.logger.info('a process was named for a terminal this window no longer holds', {
        terminalId: terminalId.value,
        pid,
      });
      return;
    }
    this._options.registry.amend(current.withObserved(current.observed.withPid(pid)));
    // Once per terminal, at its start. This is the value every later restore of
    // that record is decided on (`mayBeRunning`), so whether it ever landed is
    // the first thing anybody reading a "it did not come back" log needs.
    this._options.logger.info('the process the editor named was written onto the record', {
      terminalId: terminalId.value,
      pid,
    });
  }

  /**
   * The person closed the terminal in the editor itself, so the record is closed
   * for good -- the second producer of `closedAt`, and the last (§4.2).
   *
   * **THE RULE IS THE PAIR, and both halves are measured (A29, 2026-08-13, VS
   * Code 1.133 on win32).** M2.20 began as "read `reason`", because A15 had
   * established that the CODE cannot tell a deliberate close from a shutdown --
   * true, and a statement about the wrong field. The measurement then refused
   * the simple version too:
   *
   *   * `shutdown` is what a window reload and a window close BOTH report, in
   *     the panel and the editor area alike. That is the value that makes the
   *     rule survivable at all: our terminals are transient, so every reload
   *     closes all of them, and reading that as intent would empty the base at
   *     the first restart -- the owner's complaint, inverted and worse;
   *   * `user` does NOT mean "a person did this". In the editor area -- this
   *     build's default -- a process exiting on its own is reported as `user`
   *     too, because what the platform sees is its tab closing. The same process
   *     in the panel reports `process`;
   *   * the CODE is what separates those two, and it separates them the same way
   *     in both areas: a process that exited has one, and a terminal somebody
   *     closed has none, because nothing inside it exited (A15).
   *
   * So: `user` AND nothing exited. Neither half alone is the rule, and each of
   * them alone is a different conversation thrown away.
   *
   * Every other answer leaves the record alone, and the asymmetry is deliberate:
   * a record wrongly kept is a row somebody closes a second time, a record
   * wrongly closed is a conversation no restore will ever offer again.
   *
   * **Before the death event**, for the reason `close` gives: a listener told the
   * terminal has ended must already see a closed record, or one act reaches the
   * store as two writes.
   *
   * A record this window no longer holds is left alone rather than warned about.
   * The close is real, and there is nothing to write it on -- `ingest` says so a
   * line later, once, which is enough.
   */
  private _noteDeliberateClose(terminalId: TerminalId, exit: TerminalExit): void {
    if (exit.reason !== 'user' || exit.code !== undefined) {
      return;
    }
    const entry = this._options.registry.get(terminalId);
    if (entry === undefined) {
      return;
    }
    this._options.registry.amend(entry.withClosed(this._options.clock.now(), 'editor'));
    /*
     * The sentence says less than it used to, because this build knows less
     * than it claimed to. The editor reports one word for the cross on a tab
     * and for every gesture that closes many at once (measured 2026-08-24), so
     * "the person closed this" was a guess wearing the clothes of a fact.
     */
    this._options.logger.info('a terminal went away in the editor, so its record will not come back by itself', {
      terminalId: terminalId.value,
    });
  }

  /**
   * Whether the person may have this record, and takes its leftover pane if so.
   *
   * The one rule behind both `discard` and `startOver`, written once because
   * having it twice is how they came to disagree with the ROW -- and the row is
   * what the person is looking at.
   *
   * **What went wrong, reproduced by the owner on 2026-08-22 in three moves:**
   * open a terminal, close it without typing anything, wait until the row says
   * `no process`, press Delete. Both methods asked "is this window still
   * holding a terminal object" and refused on yes. But the record by then said
   * `orphaned` -- the reconciler had found the process gone -- so
   * `presentTerminal` drew the row as OVER, and the manifest offers Delete and
   * Start Over there and does NOT offer Close. So the answer was "close this
   * terminal before deleting its record", naming an act that row has no button
   * for; Start Over refused in the same breath; and Resume could not run either,
   * because a watched terminal must not be started twice. Every act on that row
   * failed and only a restart cleared it: "удалить их нельзя никакими
   * способами".
   *
   * So the question is now the one the row was drawn from --
   * `actsOnTheTerminal`, the same table, read twice rather than guessed at
   * twice. While the record says a conversation is running, this refuses, and
   * the row is LIVE, which is exactly where Close is offered: the person is
   * told to do something they can do.
   *
   * **And when the record says it is over, the leftover pane goes with it.** The
   * old comment was right that acting under an open terminal leaves a pane
   * nothing can name; what it missed is that the way out is to take the pane,
   * not to refuse. A pane still held for a record whose conversation is over is
   * a husk -- the process is established gone, which is how the record reached
   * that state at all. `dispose` on a terminal that has already gone is
   * harmless, which is what makes this safe in the case that produced the
   * report: an editor that never told us the terminal had closed.
   */
  private _releasedItsPane(terminalId: TerminalId, act: string): boolean {
    const watched = this._watched.get(terminalId.value);
    if (watched === undefined) {
      return true;
    }
    const state = this._options.registry.stateOf(terminalId);
    if (state !== null && actsOnTheTerminal(state)) {
      this._options.logger.warn(`a record was not ${act}, because its terminal is still running`, {
        terminalId: terminalId.value,
        state,
      });
      return false;
    }
    // Dropped from the watch BEFORE the pane is taken, so that the close event
    // this raises finds nothing left to write: one act must not reach the
    // record as two.
    watched.subscription.dispose();
    this._watched.delete(terminalId.value);
    watched.handle.dispose();
    this._options.logger.info(`a record being ${act} still had a pane of its own, which went with it`, {
      terminalId: terminalId.value,
      state,
    });
    return true;
  }

  private _watch(handle: TerminalHandle, intent: LaunchIntent): void {
    const subscription = handle.onDidClose((exit) => {
      this._onClosed(handle.terminalId, intent, exit);
    });
    this._watched.set(handle.terminalId.value, { handle, intent, subscription });
  }

  /**
   * Without this subscription a terminal whose process died before sending a
   * single hook would sit in `launching` for the life of the window -- the CLI
   * cannot report its own death, so the editor's word is the only evidence
   * there will ever be.
   */
  private _onClosed(terminalId: TerminalId, intent: LaunchIntent, exit: TerminalExit): void {
    const watched = this._watched.get(terminalId.value);
    if (watched !== undefined) {
      watched.subscription.dispose();
      this._watched.delete(terminalId.value);
    }

    this._noteDeliberateClose(terminalId, exit);
    const event = deathEvent(this._options.registry.stateOf(terminalId), intent, exit);
    // `reason` travels with the code because the code alone could not settle the
    // one failure this line was read for: on 2026-08-25 a run that reported
    // `exitCode: 0` for a process that exits 1 left nothing to say WHO ended the
    // terminal, and the editor's own word on that is the only other witness.
    this._options.logger.info('a terminal closed', {
      terminalId: terminalId.value,
      exitCode: exit.code ?? null,
      reason: exit.reason,
      intent,
      event: event.kind,
    });
    this._options.registry.ingest(terminalId, event);
  }
}

/**
 * Which death this was.
 *
 * Three inputs and one rule: a process that ENDED while the record was still
 * `launching` never got going, and that is a failure worth interrupting somebody
 * for. Everything else -- a person closing the window, a process that ran for an
 * hour and then died -- is an ordinary end.
 *
 * The `launch` / `resume` split is not cosmetic. The two produce different
 * states (`ended` with signal `launch_failed` against `resume_failed`), they are
 * indistinguishable at the moment they happen, and the state machine has nothing
 * in the pair (state, event) to choose with. The distinguisher exists here and
 * only here, because it was known before the process started.
 *
 * It is also the split that decides whether the exit CODE is asked about at all,
 * and the asymmetry is deliberate. A fresh launch that exits 0 before saying
 * anything is a person opening a terminal and typing `/exit`: nothing of theirs
 * was lost, so it is an ordinary end. A RESTORE that does the same did not bring
 * back the conversation the person asked for, whatever number came out of it --
 * and the number is the one input here we do not own. Measured 2026-08-25 over
 * 34 live runs of the resume-refusal scenario: the editor reported
 * `exitStatus.code` as 0 once for a `claude` that exits 1, against 40 runs under
 * our own engine that reported 1 every time. Read strictly, that one number cost
 * the person the offer to start their conversation over (M2.13).
 *
 * THE PRICE, said out loud: on a machine with no `SessionStart` forwarder (H1,
 * no `node` on PATH) a restored conversation reports nothing, so it sits in
 * `launching` and a person who leaves it inside the first twenty seconds is told
 * the restore failed when it did not. Bounded by exactly that clock:
 * `ResumeTimedOut` moves the record to `degraded` at 20 s
 * (`RestoreOrchestrator`), and from there this rule no longer applies. The cost
 * of being wrong that way is one row and one toast about a record that is still
 * whole; the cost of the other way is a conversation the person is never offered
 * back.
 */
function deathEvent(
  state: PersistedTerminalState | null,
  intent: LaunchIntent,
  exit: TerminalExit
): TerminalEvent {
  if (state !== 'launching' || exit.code === undefined) {
    return terminalClosed();
  }
  if (intent === 'resume') {
    return resumeExited(exit.code);
  }
  return exit.code === 0 ? terminalClosed() : launchExitedNonZero(exit.code);
}
