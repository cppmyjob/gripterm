import { isWitnessedEnd } from './terminal-state-machine';
import type { Disposable } from '../ports/disposable';
import type { Logger } from '../ports/logger';
import type { RegistryChange, SessionRegistry } from './session-registry';
import type { Scheduler } from '../ports/scheduler';
import type { SessionId } from '../entities/session-id';
import type { TerminalEntry } from '../entities/terminal-entry';

/**
 * How often the CLI is asked what it calls each conversation.
 *
 * A person who types `/rename` is looking at the row while they do it, so the
 * delay is what they read as "did it work". Two seconds is short enough to be
 * one blink and long enough that the cost is nothing: a pass reads one small
 * file per LIVE terminal of this window and spawns no process -- unlike the
 * reconciler's sweep, which runs `claude agents --json` and therefore cannot be
 * asked this often.
 */
export const DEFAULT_NAME_POLL_MS = 2000;

export interface SessionNameMirrorOptions {
  readonly registry: SessionRegistry;
  /**
   * The name Claude Code has for that conversation, or `null` for every kind of
   * "we cannot say" -- no file, a file about another conversation, a name the
   * CLI derived itself.
   */
  readonly read: (pid: number, conversation: SessionId) => Promise<string | null>;
  readonly scheduler: Scheduler;
  readonly logger: Logger;
  /** Defaults to `DEFAULT_NAME_POLL_MS`. */
  readonly intervalMs?: number;
}

/**
 * `/rename`, typed inside a terminal, arriving on the row.
 *
 * The CLI offers no hook for it and no event: it writes the new name into its
 * own session file, keyed by the pid of the process holding the conversation --
 * which is the pid the editor gave us when it started that terminal (M2.16). So
 * this is a poll, and the alternative was measured before it was rejected: the
 * reconciler already lists sessions every thirty seconds and its listing carries
 * a `name`, but it carries no `nameSource`, so it cannot tell a name a person
 * typed from one the CLI made up -- and thirty seconds is not an answer to
 * somebody watching a row.
 *
 * **The memory is what keeps the two names from fighting.** Both this and the
 * person's own `Gripterm: Rename Terminal` write the same field, and the CLI
 * never learns what happens here. Without a memory, every pass would put the
 * CLI's name back over the one the person typed in our list -- so a name is
 * applied when it CHANGES, and a name that has not changed since the last pass
 * is left where it is. The last person to type wins, whichever box they typed
 * into.
 *
 * What that costs is stated rather than hidden: a rename made while this window
 * was not running is not noticed, because the first pass of a window applies
 * whatever the CLI says. It costs nothing in practice for a reason that was
 * measured (2026-08-13) -- `claude --resume` does NOT keep the name, the resumed
 * conversation comes back with a fresh derived one, and a derived name is
 * refused by `readSessionName`. The row therefore remembers what the CLI forgets.
 */
export class SessionNameMirror implements Disposable {
  private readonly _options: SessionNameMirrorOptions;
  /** Terminal id -> the last name the CLI was seen to have for it. */
  private readonly _seen = new Map<string, string>();
  private readonly _subscription: Disposable;
  private _timer: Disposable | null = null;
  private _stopped = false;

  constructor(options: SessionNameMirrorOptions) {
    this._options = options;
    this._subscription = options.registry.subscribe((change: RegistryChange) => {
      // A record that is gone takes its memory with it. Otherwise a terminal id
      // that comes back -- a record deleted and restored -- would be measured
      // against a name from a conversation that is no longer there, and the
      // first rename after that would be skipped as "nothing changed".
      if (change.kind === 'removed') {
        this._seen.delete(change.terminalId.value);
      }
    });
  }

  /** Starts looking, and keeps looking until disposed of. */
  public start(): void {
    if (this._stopped || this._timer !== null) {
      return;
    }
    this._arm();
  }

  /**
   * One look at every terminal this window owns.
   *
   * Public because the interval is a schedule and not a rule: a test drives the
   * rule directly, and nothing here depends on how often it is called.
   */
  public async pass(): Promise<void> {
    for (const entry of this._options.registry.own()) {
      await this._look(entry);
    }
  }

  public dispose(): void {
    this._stopped = true;
    this._subscription.dispose();
    this._timer?.dispose();
    this._timer = null;
    this._seen.clear();
  }

  private _arm(): void {
    this._timer = this._options.scheduler.after(
      this._options.intervalMs ?? DEFAULT_NAME_POLL_MS,
      () => {
        this._timer = null;
        void this.pass().then(
          () => {
            this._rearm();
          },
          () => {
            // `pass` swallows what one terminal's read throws; this is the
            // programming error above that, and going quiet after it would be a
            // feature that stops working with nothing said. The next pass gets
            // its own chance.
            this._rearm();
          }
        );
      }
    );
  }

  private _rearm(): void {
    if (!this._stopped) {
      this._arm();
    }
  }

  /**
   * One terminal.
   *
   * Two records are skipped before anything is read, and both are the pid being
   * a weaker thing than it looks: a record with no pid has nothing to look up,
   * and a record whose conversation has demonstrably ended has a pid that now
   * belongs to somebody else. The conversation id in the file is what makes the
   * second one harmless anyway -- this is the cheaper half of the same guard.
   */
  private async _look(entry: TerminalEntry): Promise<void> {
    const { pid } = entry.observed;
    if (pid === null || isWitnessedEnd(entry.observed.state)) {
      return;
    }

    let name: string | null;
    try {
      name = await this._options.read(pid, entry.sessionId);
    } catch (cause: unknown) {
      this._options.logger.warn('the name Claude Code has for a conversation could not be read', {
        terminalId: entry.terminalId.value,
        pid,
        reason: String(cause),
      });
      return;
    }

    const id = entry.terminalId.value;
    if (name === null || name === this._seen.get(id)) {
      return;
    }
    this._seen.set(id, name);

    // Read again rather than amending the entry this pass began with: an event
    // could have arrived while the file was being read, and writing back a
    // remembered entry would undo it.
    const current = this._options.registry.get(entry.terminalId);
    if (current === undefined || current.metadata.displayName === name) {
      return;
    }
    this._options.registry.amend(current.withMetadata(current.metadata.withDisplayName(name)));
    this._options.logger.info('a conversation was renamed in Claude Code, and its row followed', {
      terminalId: id,
      was: current.metadata.displayName,
      now: name,
    });
  }
}
