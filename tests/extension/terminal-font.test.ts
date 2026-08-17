import { chooseTerminalFont } from '../../packages/extension/src/ui/terminal-font';

/**
 * Which font the page draws a terminal in.
 *
 * A rule rather than three `??` at the call site, and it exists because of a
 * measured trap rather than a hypothetical one: `terminal.integrated.fontFamily`
 * defaults to an EMPTY STRING, not to absence. The M3.1 stand read it with `??`,
 * handed the canvas `14px ` -- an invalid font -- and measured a character width
 * of 9.44 px in a proportional font it never asked for. The first protocol
 * carried that number until the defect was found.
 *
 * A webview cannot read settings at all, so whatever this returns is what the
 * person's agents are drawn in.
 */

const FALLBACK = { fontFamily: 'monospace', fontSize: 14 };

describe('which font the terminal is drawn in', () => {
  it('prefers what the person chose for their terminals', () => {
    expect(
      chooseTerminalFont({
        terminalFamily: 'Cascadia Mono',
        editorFamily: 'Consolas',
        terminalSize: 13,
        editorSize: 15,
      })
    ).toEqual({ fontFamily: 'Cascadia Mono', fontSize: 13 });
  });

  it('falls back to the editor font when the terminal setting is the empty string', () => {
    // The trap itself: empty rather than absent.
    expect(
      chooseTerminalFont({ terminalFamily: '', editorFamily: 'Consolas', terminalSize: 0, editorSize: 15 })
    ).toEqual({ fontFamily: 'Consolas', fontSize: 15 });
  });

  it('treats blank as empty, because a space is not a font', () => {
    expect(
      chooseTerminalFont({ terminalFamily: '   ', editorFamily: ' Consolas ', terminalSize: 0, editorSize: 15 })
    ).toEqual({ fontFamily: 'Consolas', fontSize: 15 });
  });

  it('falls back all the way when nothing is set', () => {
    expect(
      chooseTerminalFont({
        terminalFamily: undefined,
        editorFamily: undefined,
        terminalSize: undefined,
        editorSize: undefined,
      })
    ).toEqual(FALLBACK);
  });

  it.each([
    ['zero', 0],
    ['a negative size', -12],
    ['a size that is not a number', Number.NaN],
    ['an infinite size', Number.POSITIVE_INFINITY],
  ])('refuses %s and takes the next answer', (_what, terminalSize) => {
    expect(
      chooseTerminalFont({ terminalFamily: 'Consolas', editorFamily: '', terminalSize, editorSize: 15 })
    ).toEqual({ fontFamily: 'Consolas', fontSize: 15 });
  });

  it('refuses a bad size everywhere, not only in the first place it looks', () => {
    expect(
      chooseTerminalFont({
        terminalFamily: 'Consolas',
        editorFamily: '',
        terminalSize: Number.NaN,
        editorSize: -1,
      })
    ).toEqual({ fontFamily: 'Consolas', fontSize: FALLBACK.fontSize });
  });
});
