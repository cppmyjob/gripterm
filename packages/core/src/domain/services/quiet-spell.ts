import { ValidationError } from '../errors/gripterm-error';
import type { Disposable } from '../ports/disposable';
import type { Scheduler } from '../ports/scheduler';

/**
 * How a burst of events ended: because it stopped, or because it would not.
 *
 * A union rather than a boolean, because the two are read differently by
 * whoever has to diagnose a window: "the workbench finished" is a measurement,
 * and "the workbench was still moving and we acted anyway" is a warning. The
 * third is neither -- it is the window being torn down while somebody waited.
 */
export type QuietEnd =
  | 'the window went quiet'
  | 'the ceiling was reached'
  | 'nothing is watching the window any more';

export interface QuietSpellOptions {
  /** How long with no stir counts as quiet. */
  readonly quietMs: number;
  /** The longest a burst may run before it is ended anyway. */
  readonly ceilingMs: number;
  readonly scheduler: Scheduler;
  readonly onQuiet: (why: QuietEnd) => void;
}

/**
 * "Nothing has happened for N ms" -- with a ceiling, which is the half that is
 * usually left out.
 *
 * **What it is for.** An extension that wants to tidy a window after the
 * workbench has finished restoring it has no event that says "finished": the
 * editor announces each group and each tab and never announces the last one. So
 * the end of the restore is inferred from silence. The alternative, and what
 * this replaces, was `VsCodeEditorStrip` sleeping six times half a second and
 * then once more -- three and a half seconds of waiting whatever the window was
 * doing, which is a bet on a number rather than a wait for something. Measured
 * on the stand of 2026-08-25: the grid was back 1.3 s after activation, so
 * two thirds of that sleep was spent doing nothing, and by the time it ended
 * a strip had been made and the sweep it was waiting for refused to run.
 *
 * **The ceiling is not optional.** Silence is also what a window that never
 * woke up sounds like, and a wait with no ceiling on it is a hang -- which is a
 * charge against the time a person's window takes to come back, in the one
 * place where nothing would say what it was waiting for. So a burst ends when
 * it goes quiet OR when it has gone on too long, and the answer says which.
 *
 * **What it does not promise.** It does not know what the events were about;
 * a burst is a burst whoever caused it, including this extension's own moves.
 * And a burst that never begins never ends -- `whenQuiet` therefore stirs one
 * itself, so that asking to be told when the window stops cannot be a wait for
 * an event that is never coming.
 */
export class QuietSpell implements Disposable {
  private readonly _quietMs: number;
  private readonly _ceilingMs: number;
  private readonly _scheduler: Scheduler;
  private readonly _onQuiet: (why: QuietEnd) => void;
  /** The wait that ends the burst by silence, rearmed on every stir. */
  private _quiet: Disposable | null = null;
  /** The wait that ends it anyway, armed ONCE per burst and never moved. */
  private _ceiling: Disposable | null = null;
  private _waiting: ((why: QuietEnd) => void)[] = [];
  private _gone = false;

  constructor(options: QuietSpellOptions) {
    if (!(options.quietMs > 0)) {
      throw new ValidationError('a spell of quiet must be longer than nothing', {
        details: { quietMs: options.quietMs },
      });
    }
    if (!(options.ceilingMs > options.quietMs)) {
      /*
       * A ceiling at or under the quiet time can only ever fire first, so every
       * burst would end as "the ceiling was reached" and the silence would
       * never be measured at all. That is not a stricter setting, it is a
       * different mechanism wearing this one's name.
       */
      throw new ValidationError('a ceiling must be longer than the quiet it is over', {
        details: { quietMs: options.quietMs, ceilingMs: options.ceilingMs },
      });
    }
    this._quietMs = options.quietMs;
    this._ceilingMs = options.ceilingMs;
    this._scheduler = options.scheduler;
    this._onQuiet = options.onQuiet;
  }

  /** Something happened. Starts a burst if none is running, and puts the end of it back. */
  public stir(): void {
    if (this._gone) {
      return;
    }
    this._quiet?.dispose();
    this._quiet = this._scheduler.after(this._quietMs, () => {
      this._end('the window went quiet');
    });
    this._ceiling ??= this._scheduler.after(this._ceilingMs, () => {
      this._end('the ceiling was reached');
    });
  }

  /**
   * Answers at the end of the burst that is running, starting one if none is.
   *
   * The stir is the point: a caller asking "tell me when the window has
   * stopped" over a window that is already still would otherwise wait for an
   * event that has already been and gone.
   */
  public async whenQuiet(): Promise<QuietEnd> {
    if (this._gone) {
      return 'nothing is watching the window any more';
    }
    const answer = new Promise<QuietEnd>((resolve) => {
      this._waiting.push(resolve);
    });
    this.stir();
    return await answer;
  }

  public dispose(): void {
    if (this._gone) {
      return;
    }
    this._gone = true;
    this._down();
    // Whoever was waiting is told, rather than left holding a promise that can
    // no longer be answered by anything.
    this._tell('nothing is watching the window any more');
  }

  private _end(why: QuietEnd): void {
    this._down();
    this._tell(why);
    this._onQuiet(why);
  }

  private _down(): void {
    this._quiet?.dispose();
    this._quiet = null;
    this._ceiling?.dispose();
    this._ceiling = null;
  }

  private _tell(why: QuietEnd): void {
    const waiting = this._waiting;
    this._waiting = [];
    for (const answer of waiting) {
      answer(why);
    }
  }
}
