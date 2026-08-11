import type { Disposable } from '../ports/disposable';
import type { Logger } from '../ports/logger';
import type { RegistryChange, SessionRegistry } from './session-registry';
import type { Scheduler } from '../ports/scheduler';
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
  readonly entry: TerminalEntry;
  readonly silenceMs: number;
}

export interface ObservabilityWatchOptions {
  readonly registry: SessionRegistry;
  readonly scheduler: Scheduler;
  /** Says it where a person will see it. The log line is written here regardless. */
  readonly announce: (silent: SilentTerminal) => void;
  readonly logger: Logger;
  readonly silenceMs?: number;
}

/**
 * The one check that covers the causes nobody listed.
 *
 * §4.7 states the rule it implements, and states it as a correction: reading
 * settings can only find the blockers we know the names of, while "started, and
 * has sent nothing for N seconds" covers `disableAllHooks`, an administrator's
 * `allowManagedHooksOnly`, a CLI whose hook contract moved, an interpreter that
 * is not there, a filtered URL and our own mistake in the settings file -- with
 * one rule that does not age with a version number.
 *
 * It is also the only thing that catches the limit M1.9 named: after `/clear`,
 * a terminal whose `SessionStart` forwarder is dead sees every later event
 * refused as `foreign-session`, and sits in `ended` while somebody is talking to
 * it. There is no self-repair for that in M1 -- but there is no longer a silence
 * either.
 *
 * WHAT COUNTS AS PROOF OF LIFE is any transition at all, including one the state
 * machine ignored. The question here is not whether the event was useful; it is
 * whether the channel exists.
 */
export class ObservabilityWatch implements Disposable {
  private readonly _options: ObservabilityWatchOptions;
  private readonly _waiting = new Map<string, Disposable>();
  /** Terminals already decided about: heard from, announced, or dead. */
  private readonly _settled = new Set<string>();
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

  private _settle(id: string): void {
    this._waiting.get(id)?.dispose();
    this._waiting.delete(id);
    this._settled.add(id);
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
    this._options.announce({ entry, silenceMs });
  }
}
