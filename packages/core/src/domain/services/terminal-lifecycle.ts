import { ConflictError } from '../errors/gripterm-error';
import { HumanMetadata } from '../entities/human-metadata';
import { ObservedState } from '../entities/observed-state';
import { SessionId } from '../entities/session-id';
import { TerminalEntry } from '../entities/terminal-entry';
import { TerminalId } from '../entities/terminal-id';
import { launchExitedNonZero, resumeExitedNonZero, terminalClosed } from '../events/terminal-event';
import { observedAtStart } from './observed-projection';
import type { AgentCommandFactory } from '../ports/agent-command-factory';
import type { Clock } from '../ports/clock';
import type { Disposable } from '../ports/disposable';
import type { IdGenerator } from '../ports/id-generator';
import type { LaunchIntent } from '../entities/launch-intent';
import type { LaunchRecipe } from '../entities/launch-recipe';
import type { LaunchStrategy } from './launch-strategy';
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
   * **Refused while this window still holds a process for the record**, on the
   * same evidence `discard` uses and for a sharper reason. A restore that failed
   * in the editor leaves a LIVE `claude` in an open pane -- measured, A26: the
   * process prints its refusal and does not exit -- and starting over on top of
   * that is precisely how one terminal becomes two (О3). The pane is not closed
   * for them either: it is not ours to kill, and nothing here establishes that
   * anything is wrong with it.
   *
   * **The archive happens last.** Reversed, a start that threw would leave the
   * person with nothing on screen and their notes in the trash; this way the
   * worst case is two rows, which they can see and act on (§I.3).
   */
  public async startOver(terminalId: TerminalId): Promise<StartOverOutcome> {
    if (this._watched.has(terminalId.value)) {
      this._options.logger.warn(
        'a terminal was not started over, because this window still has a process for it',
        { terminalId: terminalId.value }
      );
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
    const handle = await this._options.gateway.create(plan.spec);

    // No `await` between these two. The editor cannot deliver a close event in
    // the middle of synchronous code, so there is no window in which the
    // terminal exists, is registered, and is unwatched.
    this._options.registry.register(starting);
    this._watch(handle, intent);

    if (plan.initialInput !== null) {
      // `shell` mode only: the command is typed into the person's shell. A11 and
      // A12 live exactly here and nowhere else (see `ShellLaunchStrategy`).
      handle.sendText(plan.initialInput, true);
    }
    if (visibility === 'focus') {
      // Takes the focus: somebody asked for a terminal, and leaving the cursor
      // where it was would be answering a different request.
      handle.show(false);
    }

    this._options.logger.info('a terminal was started', {
      terminalId: terminalId.value,
      sessionId: starting.sessionId.value,
      intent,
      visibility,
      mode: this._options.strategy.mode,
    });
    return starting;
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
   * The person is finished with this terminal -- and the ONLY producer of
   * `closedAt` (§4.2).
   *
   * Nothing else may set it, and the reason is now measured rather than argued:
   * our terminals are `isTransient`, so every editor shutdown closes them all,
   * and the platform reports that exactly as it reports a deliberate close.
   * Tying `closedAt` to the close event would therefore declare every terminal
   * rubbish at the first restart, leaving `isRestorable()` with nothing to say
   * and the cleanup of M2.15 with nothing to protect.
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
    this._options.registry.amend(entry.withClosed(this._options.clock.now()));

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
   * **Refused while this window still has a process for the terminal**, and the
   * evidence is `_watched` rather than the record's state: a record can look
   * finished -- `orphaned` is a process that died without saying so -- while its
   * terminal is still open in the editor. Deleting under an open terminal leaves
   * a pane nothing can name and events arriving for a record nobody holds. The
   * menus offer this only on rows that are over, so the refusal is the second
   * line of defence and not the first; it is here because the first one lives in
   * a manifest, and a manifest is not a rule.
   *
   * It lives on this service and not beside the metadata edits for one reason:
   * that precondition is knowledge only this object has.
   */
  public discard(terminalId: TerminalId): DiscardOutcome {
    if (this._watched.has(terminalId.value)) {
      this._options.logger.warn('a record was not deleted, because its terminal is still running', {
        terminalId: terminalId.value,
      });
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

    const event = deathEvent(this._options.registry.stateOf(terminalId), intent, exit);
    this._options.logger.info('a terminal closed', {
      terminalId: terminalId.value,
      exitCode: exit.code ?? null,
      intent,
      event: event.kind,
    });
    this._options.registry.ingest(terminalId, event);
  }
}

/**
 * Which death this was.
 *
 * Three inputs and one rule: a process that exited non-zero while the record was
 * still `launching` never got going, and that is a failure worth interrupting
 * somebody for. Everything else -- a clean exit, a person closing the window, a
 * process that ran for an hour and then died -- is an ordinary end.
 *
 * The `launch` / `resume` split is not cosmetic. The two produce different
 * states (`ended` with signal `launch_failed` against `resume_failed`), they are
 * indistinguishable at the moment they happen, and the state machine has nothing
 * in the pair (state, event) to choose with. The distinguisher exists here and
 * only here, because it was known before the process started.
 */
function deathEvent(
  state: PersistedTerminalState | null,
  intent: LaunchIntent,
  exit: TerminalExit
): TerminalEvent {
  if (state !== 'launching' || exit.code === undefined || exit.code === 0) {
    return terminalClosed();
  }
  return intent === 'launch' ? launchExitedNonZero(exit.code) : resumeExitedNonZero(exit.code);
}
