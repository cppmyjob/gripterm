import type { Clock } from '../ports/clock';
import type { ErrorDetails } from '../errors/gripterm-error';
import type { LogLevel, LogLine, LogSink, Logger } from '../ports/logger';

/**
 * How many lines are held while there is nowhere to write them.
 *
 * Bounded because the store may never be found at all: a window whose
 * `gripterm.storage.path` was refused runs all day with no sink, and an
 * unbounded buffer would be this build growing in somebody's memory for the
 * sake of a file it is never going to write.
 *
 * Five hundred, and it is CHOSEN rather than measured -- said so here because
 * the alternative is a number that reads as evidence. What was measured, in the
 * integration host on 2026-08-24: exactly ONE line was said before the store was
 * settled, and 104 lines in the whole sitting. So the ceiling is nowhere near
 * being reached on the path this was written for, and what it really guards is
 * the other path -- a window whose store was refused, which then says everything
 * it says with nowhere to put it. How many lines such a window writes in an hour
 * is not measured, and the plan's register carries that.
 */
export const HELD_LINES = 500;

export interface LogRelayOptions {
  /** Where every line goes, always: the editor's own log channel. */
  readonly first: Logger;
  /** Stamps each line at the moment it was said, not at the moment it lands. */
  readonly clock: Clock;
  /** Overridden only by a test. See `HELD_LINES`. */
  readonly held?: number;
}

/**
 * The `Logger` the whole build talks to, so that a line can also reach a place
 * that did not exist when it was said.
 *
 * **The order of activation is what makes this necessary rather than clever.**
 * The logger is built on the first line of `activate`; where the store IS -- the
 * one directory a person can be asked to send -- is not settled until the
 * setting has been read, refused, or fallen back on, a hundred lines later. And
 * those hundred lines are precisely the ones that explain a window that came up
 * showing nothing: which path was taken, which was refused, and why.
 *
 * So a line said before the store is known is HELD, and replayed into the sink
 * the moment there is one, carrying the moment it happened.
 *
 * **A sink that throws is let go of, and said out loud once.** This class runs
 * inside the reporting path of every other failure in the build. A throw from
 * here would replace the sentence explaining a defect with a second defect, on
 * the very line that was about to say what went wrong -- so the store's log
 * stops and the channel keeps going, which is the state this build was in
 * before the store ever had a log at all.
 */
export class LogRelay implements Logger {
  private readonly _options: LogRelayOptions;
  private readonly _limit: number;
  private _held: LogLine[] = [];
  private _dropped = 0;
  private _sink: LogSink | null = null;

  constructor(options: LogRelayOptions) {
    this._options = options;
    this._limit = options.held ?? HELD_LINES;
  }

  public info(message: string, details?: ErrorDetails): void {
    this._options.first.info(message, details);
    this._alsoWrite('info', message, details);
  }

  public warn(message: string, details?: ErrorDetails): void {
    this._options.first.warn(message, details);
    this._alsoWrite('warn', message, details);
  }

  public error(message: string, details?: ErrorDetails): void {
    this._options.first.error(message, details);
    this._alsoWrite('error', message, details);
  }

  /**
   * Attaches the second destination and replays everything held for it.
   *
   * Idempotent in the direction that matters: a second call replaces the sink
   * and replays nothing, because the held lines have already been written and
   * writing them again would make one activation look like two.
   */
  public alsoTo(sink: LogSink): void {
    const replay = this._held;
    const dropped = this._dropped;
    this._held = [];
    this._dropped = 0;
    this._sink = sink;
    for (const line of replay) {
      if (!this._write(line)) {
        return;
      }
    }
    if (dropped > 0) {
      // Said in the file rather than only in the channel, because the file is
      // what a person sends: a gap nobody is told about is a log that reads as
      // complete and is not.
      this._write({
        at: this._options.clock.now(),
        level: 'warn',
        message: 'the earliest lines of this window were kept and the rest were dropped while there was nowhere to write them',
        details: { dropped, held: replay.length },
      });
    }
  }

  private _alsoWrite(level: LogLevel, message: string, details: ErrorDetails | undefined): void {
    const line: LogLine = { at: this._options.clock.now(), level, message, details };
    if (this._sink === null) {
      if (this._held.length < this._limit) {
        this._held.push(line);
      } else {
        this._dropped += 1;
      }
      return;
    }
    this._write(line);
  }

  /** Writes one line, or lets go of a sink that could not take it. Answers whether it landed. */
  private _write(line: LogLine): boolean {
    const sink = this._sink;
    if (sink === null) {
      return false;
    }
    try {
      sink.write(line);
      return true;
    } catch (cause: unknown) {
      this._sink = null;
      this._options.first.error(
        'the log this window keeps in the store stopped, and the rest of this session is only in this panel',
        { cause }
      );
      return false;
    }
  }
}
