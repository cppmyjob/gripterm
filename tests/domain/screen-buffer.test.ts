import { SCREEN_BUFFER_CEILING_CHARS, ScreenBuffer, ValidationError } from '../../packages/core/src/index';

/**
 * The tail of a terminal's output, kept so that a view which was destroyed can
 * be drawn again.
 *
 * Not a recording (§7.2 promises there is none): a ring buffer with a ceiling,
 * in memory, per terminal. It is also where output goes while the panel is
 * hidden -- M3.7 lifts back-pressure on invisibility and drains here, because a
 * paused pty with no consumer is an agent frozen mid-`pnpm install`.
 *
 * **The ceiling counts UTF-16 code units** -- what `String.prototype.length`
 * gives and what VS Code's own watermarks count. Named because this project
 * promises emoji and CJK: `🙂` is two of these units and `中` is one, so a
 * ceiling in "characters" means something different depending on who is asked.
 *
 * Two rules exist because a ring buffer that cuts wherever the arithmetic lands
 * produces text no terminal can render, and both are cheap:
 *   * a cut never separates a surrogate pair -- the kept half would reach xterm
 *     as U+FFFD and the person would see a box where an emoji was;
 *   * a cut prefers the next line boundary -- `\u001b[32m` cut in half prints
 *     `[32m` as literal text, and a replay that begins mid-sequence colours
 *     everything after it wrongly.
 */

describe('ScreenBuffer keeps what it can under a named ceiling', () => {
  it('keeps every chunk while the total fits', () => {
    const buffer = new ScreenBuffer(16);

    buffer.append('one ');
    buffer.append('two');

    expect(buffer.snapshot()).toStrictEqual({ text: 'one two', droppedChars: 0 });
    expect(buffer.length).toBe(7);
  });

  it('holds exactly the ceiling without dropping anything', () => {
    const buffer = new ScreenBuffer(4);

    buffer.append('abcd');

    expect(buffer.snapshot()).toStrictEqual({ text: 'abcd', droppedChars: 0 });
  });

  it('ignores an empty chunk', () => {
    // A pty produces them, and an empty chunk in the list is a slot that costs
    // memory and answers nothing.
    const buffer = new ScreenBuffer(4);

    buffer.append('');

    expect(buffer.snapshot()).toStrictEqual({ text: '', droppedChars: 0 });
    expect(buffer.length).toBe(0);
  });

  it('drops the oldest text once the ceiling is passed', () => {
    const buffer = new ScreenBuffer(10);

    buffer.append('0123456789');
    buffer.append('abc');

    expect(buffer.snapshot()).toStrictEqual({ text: '3456789abc', droppedChars: 3 });
  });

  it('drops whole chunks that fall entirely outside the ceiling', () => {
    const buffer = new ScreenBuffer(4);

    buffer.append('aa');
    buffer.append('bb');
    buffer.append('cccc');

    expect(buffer.snapshot()).toStrictEqual({ text: 'cccc', droppedChars: 4 });
  });

  it('keeps only the tail of a chunk larger than the whole ceiling', () => {
    const buffer = new ScreenBuffer(4);

    buffer.append('abcdefgh');

    expect(buffer.snapshot()).toStrictEqual({ text: 'efgh', droppedChars: 4 });
  });
});

describe('ScreenBuffer cuts where a terminal can start reading again', () => {
  it('cuts at the next line boundary rather than inside a line', () => {
    const buffer = new ScreenBuffer(8);

    buffer.append('ab\ncdef\n');
    buffer.append('gh');

    // Two units had to go; three went, because the third is the newline. The
    // arithmetic alone would have kept `\ncdef\ngh` and begun a replay with a
    // stray line break.
    expect(buffer.snapshot()).toStrictEqual({ text: 'cdef\ngh', droppedChars: 3 });
  });

  it('never begins a replay inside an escape sequence', () => {
    const buffer = new ScreenBuffer(10);

    buffer.append('\u001b[32mgreen\r\n');
    buffer.append('plain\r\n');

    // The whole coloured line went rather than its second half: there is no
    // line boundary inside it to cut at, so the cut moved to the end of it.
    // That is the cost of the rule, and it is a line at a time.
    const { text } = buffer.snapshot();
    expect(text).toBe('plain\r\n');
    expect(text).not.toContain('[32m');
  });

  it('cuts a single line longer than the ceiling where the ceiling falls', () => {
    // The named limit of the rule above. A progress bar redrawing itself with
    // `\r` produces no newline for minutes, and there is nothing to cut at, so
    // the first line of such a replay may begin mid-sequence. Named here rather
    // than discovered: §7.2 does not promise a recording, and this is the
    // shape of what it does promise.
    const buffer = new ScreenBuffer(5);

    buffer.append('x'.repeat(8));

    expect(buffer.snapshot()).toStrictEqual({ text: 'xxxxx', droppedChars: 3 });
  });

  it('never leaves a lone surrogate at the start of a replay', () => {
    const buffer = new ScreenBuffer(4);

    buffer.append('\u{1F642}ab');
    buffer.append('c');

    const { text, droppedChars } = buffer.snapshot();
    // One unit had to go and two went: half an emoji is not a character, and
    // xterm would draw the replacement box for it.
    expect(text).toBe('abc');
    expect(droppedChars).toBe(2);
    expect(loneSurrogates(text)).toBe(0);
  });

  it('keeps a surrogate pair that the cut does not touch', () => {
    const buffer = new ScreenBuffer(4);

    buffer.append('ab\u{1F642}');
    buffer.append('');

    expect(loneSurrogates(buffer.snapshot().text)).toBe(0);
    expect(buffer.snapshot().text).toBe('ab\u{1F642}');
  });
});

describe('ScreenBuffer says how much the person will never see', () => {
  it('adds up everything dropped so far', () => {
    const buffer = new ScreenBuffer(4);

    buffer.append('aaaa');
    buffer.append('bbbb');
    buffer.append('cccc');

    expect(buffer.snapshot()).toStrictEqual({ text: 'cccc', droppedChars: 8 });
  });

  it('forgets both the text and the count when cleared', () => {
    // The count answers "does the text I am about to write start in the middle",
    // which is a question about the text currently held. Once that text has been
    // written the question is answered and the count is about nothing.
    const buffer = new ScreenBuffer(4);
    buffer.append('aaaaaa');

    buffer.clear();

    expect(buffer.snapshot()).toStrictEqual({ text: '', droppedChars: 0 });
    expect(buffer.length).toBe(0);
  });
});

describe('ScreenBuffer has a ceiling it will not be asked to exceed', () => {
  it('defaults to the named ceiling', () => {
    const buffer = new ScreenBuffer();

    buffer.append('x'.repeat(SCREEN_BUFFER_CEILING_CHARS + 1));

    expect(buffer.length).toBe(SCREEN_BUFFER_CEILING_CHARS);
    expect(SCREEN_BUFFER_CEILING_CHARS).toBe(200_000);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a ceiling of %p, which describes no buffer at all',
    (ceiling) => {
      expect(() => new ScreenBuffer(ceiling)).toThrow(ValidationError);
    }
  );
});

/**
 * Counts code points that are surrogates on their own. Iterating a string with
 * `for...of` walks code points, so a valid pair arrives as one character above
 * U+FFFF and only an orphan lands in the surrogate range.
 */
function loneSurrogates(text: string): number {
  let count = 0;
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0;
    if (point >= 0xd800 && point <= 0xdfff) {
      count += 1;
    }
  }
  return count;
}
