import { ConflictError } from '../errors/gripterm-error';
import { HumanMetadata } from '../entities/human-metadata';
import { ObservedState } from '../entities/observed-state';
import { SessionId } from '../entities/session-id';
import { TerminalEntry } from '../entities/terminal-entry';
import { TerminalId } from '../entities/terminal-id';
import { launchExitedNonZero, resumeExitedNonZero, terminalClosed } from '../events/terminal-event';
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

  /**
   * A terminal that did not exist before: new ids, a fresh record, `launching`.
   *
   * Both ids are drawn here rather than by the agent's command builder, because
   * `--session-id` on the launch path is US telling the CLI which conversation
   * this is. The record and the process therefore agree on the id before the
   * process exists, which is what makes the first hook event routable.
   */
  public async launch(request: LaunchRequest): Promise<TerminalEntry> {
    const startedAt = this._options.clock.now();
    const entry = TerminalEntry.create({
      terminalId: TerminalId.fromString(this._options.ids.newUuid()),
      sessionId: SessionId.fromString(this._options.ids.newUuid()),
      owner: this._options.owner,
      metadata: HumanMetadata.create({
        displayName: request.displayName,
        task: null,
        notes: [],
        tags: [],
        color: null,
      }),
      launch: request.recipe,
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

    return await this.start(entry, 'launch');
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
  public async start(entry: TerminalEntry, intent: LaunchIntent): Promise<TerminalEntry> {
    const { terminalId } = entry;
    if (this._watched.has(terminalId.value)) {
      // Two processes on one conversation is the failure the whole ownership
      // design exists to prevent, and within one window it is cheap to refuse
      // outright rather than to reason about.
      throw new ConflictError('this terminal is already running', {
        details: { terminalId: terminalId.value },
      });
    }

    const command = await this._options.commands.commandFor(entry, intent);
    const plan = this._options.strategy.buildPlan({
      terminalId,
      name: entry.metadata.displayName,
      cwd: entry.launch.cwd,
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
    this._options.registry.register(entry);
    this._watch(handle, intent);

    if (plan.initialInput !== null) {
      // `shell` mode only: the command is typed into the person's shell. A11 and
      // A12 live exactly here and nowhere else (see `ShellLaunchStrategy`).
      handle.sendText(plan.initialInput, true);
    }
    // Takes the focus: somebody asked for a terminal, and leaving the cursor
    // where it was would be answering a different request.
    handle.show(false);

    this._options.logger.info('a terminal was started', {
      terminalId: terminalId.value,
      sessionId: entry.sessionId.value,
      intent,
      mode: this._options.strategy.mode,
    });
    return entry;
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

  public dispose(): void {
    for (const watched of this._watched.values()) {
      watched.subscription.dispose();
    }
    this._watched.clear();
    // The terminals are NOT destroyed. Deactivation is not a decision about
    // anybody's conversation, and `isTransient` takes them when the editor goes.
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
