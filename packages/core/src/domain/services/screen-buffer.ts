import { ValidationError } from '../errors/gripterm-error';

/**
 * How much of one terminal's output is kept in order to draw its screen again.
 *
 * **The unit is UTF-16 code units** -- what `String.prototype.length` counts, and
 * what VS Code's own pty-host watermarks count. Named rather than left as
 * "characters", because this project promises emoji and CJK and the two answers
 * differ there: `🙂` is two of these units and `中` is one.
 *
 * 200 000 of them is about 400 KB of memory per terminal and, at the 120x30 that
 * a normal panel gives, some 55 screens of scrollback. Two agents cost less than
 * a megabyte. The number is a ceiling and not a target: a burst of 560 928
 * characters was measured arriving from a single `pnpm`-shaped stream (M3.2 stage
 * B, §6), so a buffer sized to hold whole bursts is a recording, and §7.2
 * promises there is none.
 */
export const SCREEN_BUFFER_CEILING_CHARS = 200_000;

/** Everything a destroyed screen can be redrawn from, and how much is missing. */
export interface ScreenReplay {
  /** What is held, oldest first. */
  readonly text: string;
  /**
   * Code units dropped before `text` begins. Zero means the tail IS the whole
   * output; anything else means a replay starts mid-stream, which is a thing to
   * say out loud on the screen rather than to leave looking complete.
   */
  readonly droppedChars: number;
}

const HIGH_SURROGATE_FIRST = 0xd800;
const HIGH_SURROGATE_LAST = 0xdbff;
const LOW_SURROGATE_FIRST = 0xdc00;
const LOW_SURROGATE_LAST = 0xdfff;

/**
 * The tail of a terminal's output, under a ceiling, in memory.
 *
 * Two consumers, both in M3.7. A view that was DESTROYED (the panel was closed,
 * or the editor decided) comes back with an empty xterm and this is the only
 * thing that can fill it. A view that is merely HIDDEN keeps its xterm but stops
 * acknowledging writes -- Chromium clamps timers in a hidden frame and xterm
 * schedules through `setTimeout` -- so back-pressure is lifted on invisibility
 * and the output goes here instead of freezing the agent against a full pty.
 *
 * **Not a recording** (§7.2). It holds a tail, it is bounded, it never reaches
 * disk, and it says how much it dropped rather than pretending it dropped
 * nothing.
 *
 * Two cutting rules, because a ring buffer that cuts wherever the arithmetic
 * lands hands a terminal text no terminal can draw:
 *
 *   * **a cut never separates a surrogate pair.** The kept half is a lone
 *     surrogate, and it reaches xterm as U+FFFD -- a replacement box where an
 *     emoji was, one column narrower than the line was drawn for.
 *   * **a cut prefers the next line boundary.** `\u001b[32m` cut in half prints
 *     `[32m` as literal text and leaves everything after it the wrong colour.
 *     There is no way to be certain a cut is not inside a sequence, and there is
 *     a cheap way to be nearly certain: start after a newline. The cost is at
 *     most one extra line, and the named limit is a line longer than the whole
 *     ceiling -- a progress bar redrawing itself with `\r` -- where there is no
 *     boundary to move to and the first line of a replay may be rubbish.
 */
export class ScreenBuffer {
  private readonly _ceilingChars: number;
  /**
   * The chunks as they arrived, rather than one string. A single string means a
   * concatenation and a slice per chunk, which is the whole buffer copied per
   * arrival: at the measured rates -- millions of characters a second, in pieces
   * of a few hundred -- that is the wrong shape by orders of magnitude.
   */
  private readonly _chunks: string[] = [];
  private _length = 0;
  private _droppedChars = 0;

  constructor(ceilingChars: number = SCREEN_BUFFER_CEILING_CHARS) {
    if (!Number.isInteger(ceilingChars) || ceilingChars < 1) {
      throw new ValidationError('a screen buffer needs a whole ceiling of at least one code unit', {
        details: { ceilingChars },
      });
    }
    this._ceilingChars = ceilingChars;
  }

  /** Code units held right now. Never above the ceiling; often below it, by a line. */
  public get length(): number {
    return this._length;
  }

  public append(chunk: string): void {
    if (chunk.length === 0) {
      // A pty produces them. An empty chunk in the list costs a slot and answers
      // nothing.
      return;
    }
    this._chunks.push(chunk);
    this._length += chunk.length;
    this._trim();
  }

  public snapshot(): ScreenReplay {
    return { text: this._chunks.join(''), droppedChars: this._droppedChars };
  }

  /**
   * Forgets the text AND the count.
   *
   * The count answers "does the text I am about to write begin in the middle",
   * which is a question about the text currently held. Once that text has been
   * written the question is answered, and a count that outlived it would make a
   * fresh screen claim a loss that is already on it.
   */
  public clear(): void {
    this._chunks.length = 0;
    this._length = 0;
    this._droppedChars = 0;
  }

  private _trim(): void {
    let head = this._chunks[0];
    while (this._length > this._ceilingChars && head !== undefined) {
      const excess = this._length - this._ceilingChars;
      if (head.length <= excess) {
        this._chunks.shift();
        this._drop(head.length);
      } else {
        const cut = cutIndex(head, excess);
        this._chunks[0] = head.slice(cut);
        this._drop(cut);
      }
      head = this._chunks[0];
    }
  }

  private _drop(units: number): void {
    this._length -= units;
    this._droppedChars += units;
  }
}

/**
 * Where to cut a chunk that has to lose at least `excess` code units from its
 * front, given that the remainder is about to be handed to a terminal.
 *
 * Never less than `excess`, sometimes more: the newline rule moves the cut
 * forward by up to a line, and the surrogate rule by one unit. Both directions
 * are the safe one -- dropping a little more than asked costs a line of history,
 * and dropping a little less costs a line of garbage.
 */
function cutIndex(head: string, excess: number): number {
  const lineEnd = head.indexOf('\n', excess);
  if (lineEnd !== -1) {
    return lineEnd + 1;
  }
  return splitsSurrogatePair(head, excess) ? excess + 1 : excess;
}

/**
 * Whether cutting at `at` would keep the second half of a surrogate pair.
 *
 * `at` is always inside the string here -- the caller only cuts a chunk longer
 * than the excess -- and always at least 1, so neither `charCodeAt` can be asked
 * about a position that does not exist.
 */
function splitsSurrogatePair(text: string, at: number): boolean {
  const before = text.charCodeAt(at - 1);
  const after = text.charCodeAt(at);
  return (
    before >= HIGH_SURROGATE_FIRST &&
    before <= HIGH_SURROGATE_LAST &&
    after >= LOW_SURROGATE_FIRST &&
    after <= LOW_SURROGATE_LAST
  );
}
