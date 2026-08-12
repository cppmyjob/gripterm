import type { AttentionAction, AttentionPresenter, AttentionRequest } from '../ports/attention-presenter';
import type { AttentionSignal } from './terminal-state-machine';
import type { Disposable } from '../ports/disposable';
import type { RegistryChange, SessionRegistry } from './session-registry';
import type { TerminalEntry } from '../entities/terminal-entry';

/** The command that brings a terminal to the front. Named here so the manifest, the registration and the button cannot drift apart. */
export const FOCUS_TERMINAL_COMMAND = 'gripterm.focusTerminal';

/** The command that opens our log. Where the cause is, when the terminal is not. */
export const SHOW_LOGS_COMMAND = 'gripterm.showLogs';

/**
 * `gripterm.notify.toastStates` by default.
 *
 * `waiting_permission` because it blocks a turn until a person answers.
 * `launch_failed` because nothing else will ever mention it -- the terminal is
 * already gone by the time the signal is born.
 *
 * `waiting_input` is deliberately NOT here: the only emitter of
 * `agent_needs_input` in binary 2.1.225 is the background agent-jobs strip, and
 * the state does not occur in a single interactive terminal [Ф, round 9].
 * `resume_failed` joins with M2, which is when a restore can fail at all.
 */
export const DEFAULT_TOAST_SIGNALS: readonly AttentionSignal[] = ['waiting_permission', 'launch_failed'];

/** Signals that mean the terminal is already gone, so there is nothing to focus. */
const TERMINAL_IS_GONE: ReadonlySet<AttentionSignal> = new Set<AttentionSignal>([
  'launch_failed',
  'resume_failed',
]);

/**
 * What each signal is called in a notification. Total over `AttentionSignal`, so
 * a state added to the union cannot reach a person as an empty sentence.
 */
const WORDING: Readonly<Record<AttentionSignal, string>> = {
  waiting_permission: 'is waiting for permission',
  waiting_input: 'is waiting for you',
  launch_failed: 'could not start',
  resume_failed: 'could not be restored',
  turn_failed: 'could not finish the turn',
  ended: 'has ended',
  orphaned: 'has no process',
  degraded: 'is not reporting its state',
  idle: 'is done',
  working: 'started working',
  launching: 'is starting',
};

/**
 * Every signal, as values.
 *
 * Derived from `WORDING` rather than written out a second time: the record is
 * total over the union, so this list cannot fall behind it. Its consumer is the
 * settings reader -- a person can type anything into `settings.json`, and a
 * configured state we do not recognise must be reported rather than silently
 * dropped into a set that then never matches.
 */
export const ATTENTION_SIGNALS: readonly AttentionSignal[] = Object.freeze(
  Object.keys(WORDING) as AttentionSignal[]
);

export function isAttentionSignal(value: string): value is AttentionSignal {
  return (ATTENTION_SIGNALS as readonly string[]).includes(value);
}

export interface AttentionNotifierOptions {
  readonly registry: SessionRegistry;
  readonly presenter: AttentionPresenter;
  readonly signals?: readonly AttentionSignal[];
}

/**
 * One rule, and no state of its own.
 *
 * The rule: a terminal ENTERED a state worth interrupting a person for. Rounds
 * 7 to 9 produced nine blockers on everything more elaborate than that (§11
 * v9), so the badge, the focus suppression and the collapsing are all absent by
 * decision rather than by omission.
 *
 * **The de-duplication the plan asks for is the state machine's, not ours.**
 * "Suppress a repeat without a change of state, notify again after an
 * intervening one" is exactly the difference between `moved` and `stayed`, and
 * `moved` guarantees `from !== to` by construction. Keeping a `Map` of
 * already-notified pairs here would re-derive, less reliably, something already
 * true one layer down -- and would then need its own rule for when to forget.
 *
 * Only this window's terminals reach it, because only they are in the registry:
 * foreign records are a projection this milestone does not build (§4.6).
 */
export class AttentionNotifier implements Disposable {
  private readonly _presenter: AttentionPresenter;
  private readonly _signals: ReadonlySet<AttentionSignal>;
  private readonly _subscription: Disposable;

  constructor(options: AttentionNotifierOptions) {
    this._presenter = options.presenter;
    this._signals = new Set(options.signals ?? DEFAULT_TOAST_SIGNALS);
    this._subscription = options.registry.subscribe((change) => {
      this._onChange(change);
    });
  }

  public dispose(): void {
    this._subscription.dispose();
  }

  private _onChange(change: RegistryChange): void {
    if (change.kind !== 'entry') {
      // Two things, and neither is news. Other windows' records arrive
      // wholesale from the base: this window did not see any of it happen,
      // cannot say which of them moved, and a toast offering to focus a
      // terminal that lives in another window is an interruption with nothing
      // behind it. A deletion is the person's own act of a moment ago, and
      // telling somebody what they have just done is the definition of noise.
      return;
    }

    const { transition } = change;
    // `stayed` is the same state again, `ignored` was dropped, and `null` is a
    // registration -- an entry appearing in the list is not news to interrupt
    // anyone with.
    //
    // This guard is held by the COMPILER, not by the suite, and that is worth
    // knowing before anyone simplifies it away: only `MovedTransition` carries
    // a `signal`, so removing the check does not compile -- while at runtime
    // the lookup below would filter the other two anyway, and no test can tell
    // the difference. Measured by mutation on 2026-08-11: the mutant is green
    // under bare `jest`, which transpiles, and red under `pnpm test`, which
    // type-checks first.
    if (transition?.kind !== 'moved') {
      return;
    }
    if (!this._signals.has(transition.signal)) {
      return;
    }
    this._presenter.present(requestFor(change.entry, transition.signal));
  }
}

function requestFor(entry: TerminalEntry, signal: AttentionSignal): AttentionRequest {
  return {
    terminalId: entry.terminalId,
    signal,
    message: `${entry.metadata.displayName} ${WORDING[signal]}`,
    actions: [actionFor(entry, signal)],
  };
}

/**
 * The button, and it is not decoration.
 *
 * By the time `launch_failed` exists the terminal has been destroyed -- the
 * signal is BORN of its closing (M1.12) -- so the promised "jump to your
 * terminal" would be a button that does nothing. Where there is no terminal,
 * the offer is the place the cause is visible instead.
 *
 * `resume_failed` gets the same treatment for now; M2.13 replaces it with
 * "Show record", which is where starting over will be offered.
 */
function actionFor(entry: TerminalEntry, signal: AttentionSignal): AttentionAction {
  return TERMINAL_IS_GONE.has(signal)
    ? { title: 'Open logs', command: SHOW_LOGS_COMMAND, arguments: [] }
    : {
      title: 'Show terminal',
      command: FOCUS_TERMINAL_COMMAND,
      arguments: [entry.terminalId.value],
    };
}
