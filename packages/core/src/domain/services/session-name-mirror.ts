import { isWitnessedEnd } from './terminal-state-machine';
import type { Disposable } from '../ports/disposable';
import type { Logger } from '../ports/logger';
import type { RegistryChange, SessionRegistry } from './session-registry';
import type { Scheduler } from '../ports/scheduler';
import type { SessionId } from '../entities/session-id';
import type { TerminalEntry } from '../entities/terminal-entry';
import type { TerminalId } from '../entities/terminal-id';

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
  /**
   * Tells that conversation what it is called now.
   *
   * The CLI has no channel for this but the one a person has -- `/rename`, typed
   * into the terminal -- so an implementation of this types it. That is why it
   * is called under the guards in `_look` and nowhere else, and why it takes a
   * NAME rather than a line: which command spells it is Claude Code's business,
   * and this file is not allowed to know (the linter enforces it).
   */
  readonly tell: (terminalId: TerminalId, name: string) => void;
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
  /** Terminal id -> the last name this window told that conversation to take. */
  private readonly _told = new Map<string, string>();
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
        this._told.delete(change.terminalId.value);
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
    this._told.clear();
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
        cause,
      });
      return;
    }

    // Nothing readable means nothing to compare against, in either direction.
    // `launch.mode: shell` lives here permanently -- the pid is the shell's --
    // and typing a rename into a terminal whose name we cannot read would be
    // typing blind.
    if (name === null) {
      return;
    }

    // Read again rather than acting on the entry this pass began with: an event
    // could have arrived while the file was being read, and writing back a
    // remembered entry would undo it.
    const id = entry.terminalId.value;
    const current = this._options.registry.get(entry.terminalId);
    if (current === undefined) {
      return;
    }

    if (name !== this._seen.get(id)) {
      this._follow(current, name);
      return;
    }
    this._tell(current, name);
  }

  /** The CLI moved: the row takes its name. */
  private _follow(current: TerminalEntry, name: string): void {
    const id = current.terminalId.value;
    this._seen.set(id, name);
    // Whatever we last told this conversation is spent: the name it has now is
    // the one that counts, and a later rename here must be told again.
    this._told.delete(id);
    if (current.metadata.displayName === name) {
      return;
    }
    this._options.registry.amend(current.withMetadata(current.metadata.withDisplayName(name)));
    this._options.logger.info('a conversation was renamed in Claude Code, and its row followed', {
      terminalId: id,
      was: current.metadata.displayName,
      now: name,
    });
  }

  /**
   * The CLI has not moved since the last pass, so a row that differs was renamed
   * HERE -- and the conversation is told, once.
   *
   * **Only while it is idle**, and that is a guard rather than a preference: the
   * only channel is typing, a terminal that is working has a prompt box instead
   * of a command line, and the newline would SEND whatever is in it. That costs
   * a turn and puts a line nobody wrote into somebody's conversation. A rename
   * made while the terminal is busy is simply told later, on the pass after it
   * goes idle.
   *
   * **Once per name**, because we cannot see whether it worked. The name may
   * have landed in a prompt box that was not empty, and repeating that every two
   * seconds would turn one mistake into a stream of them.
   */
  private _tell(current: TerminalEntry, theirs: string): void {
    const ours = current.metadata.displayName;
    const id = current.terminalId.value;
    if (ours === theirs || this._told.get(id) === ours || current.observed.state !== 'idle') {
      return;
    }
    this._told.set(id, ours);
    this._options.tell(current.terminalId, ours);
    this._options.logger.info('a row was renamed here, and the conversation was told', {
      terminalId: id,
      was: theirs,
      now: ours,
    });
  }
}
