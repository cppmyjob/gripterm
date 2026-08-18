import {
  TERMINAL_CHORDS,
  chordById,
  chordFor,
  isCopyPress,
  isPastePress,
  parseHostMessage,
  parseViewMessage,
} from '../../packages/webview/src/protocol';
import * as keys from '../../packages/webview/src/keys';

/**
 * The contract between the page and the extension host, checked from both ends.
 *
 * Both parsers exist for the same reason and it is not symmetry: a webview is a
 * separate document with its own lifetime, and `postMessage` carries whatever
 * the other side last sent -- including a message from a page of the PREVIOUS
 * build after a reload, and including nothing at all if a script died halfway.
 * A parser that returned a half-built object would put `undefined` where a
 * number belongs and the failure would surface three layers away, in a `fit`
 * that quietly does nothing.
 *
 * So the rule is: an unrecognised message is `null`, and `null` is logged rather
 * than acted on.
 *
 * Since M3.7 the channel carries a terminal, which raises the cost of a bad
 * message from a wrong pixel to a wrong process: a size that is not a size
 * reaches a native `resize`, and a receipt for a negative amount buys a flood an
 * extra window before back-pressure engages. Both are refused here, at the door,
 * rather than guarded at each of the places they would arrive.
 */

const REPORT = {
  generation: 1,
  cols: 120,
  rows: 30,
  terminalWidth: 800.5,
  detailsWidth: 300.5,
  scrollback: 1000,
  background: '#1e1e1e',
  fontFamily: 'Consolas',
  fontSize: 14,
  codiconLoaded: true,
  unicodeVersion: '11',
  attached: 'a2f1c8de-0000-4000-8000-000000000001',
  written: 4096,
  bracketedPaste: true,
  acking: true,
};

describe('what the host accepts from the page', () => {
  it('takes a ready with its report', () => {
    expect(parseViewMessage({ kind: 'ready', report: REPORT })).toEqual({
      kind: 'ready',
      report: REPORT,
    });
  });

  it('takes a report from a screen with no terminal behind it', () => {
    // `null` is an answer here, not an omission: before the first agent exists
    // the page really is showing nothing, and a parser that refused it would
    // make the ordinary case look like a defect.
    expect(parseViewMessage({ kind: 'ready', report: { ...REPORT, attached: null } })).toEqual({
      kind: 'ready',
      report: { ...REPORT, attached: null },
    });
  });

  it('takes a measurement and why it was made', () => {
    expect(parseViewMessage({ kind: 'measured', report: REPORT, because: 'the panel was resized' })).toEqual({
      kind: 'measured',
      report: REPORT,
      because: 'the panel was resized',
    });
  });

  it('takes a refusal the page makes out loud', () => {
    expect(parseViewMessage({ kind: 'refused', what: 'xterm did not start' })).toEqual({
      kind: 'refused',
      what: 'xterm did not start',
    });
  });

  it('takes a policy violation, which is the one message M3.6 exists to hear', () => {
    expect(
      parseViewMessage({ kind: 'csp-violation', directive: 'script-src', blockedUri: 'inline' })
    ).toEqual({ kind: 'csp-violation', directive: 'script-src', blockedUri: 'inline' });
  });

  it('takes a receipt, which is the one message back-pressure is made of', () => {
    expect(parseViewMessage({ kind: 'ack', terminalId: 'one', chars: 8192 })).toEqual({
      kind: 'ack',
      terminalId: 'one',
      chars: 8192,
    });
  });

  it('takes what the person typed', () => {
    expect(parseViewMessage({ kind: 'input', terminalId: 'one', data: '' })).toEqual({
      kind: 'input',
      terminalId: 'one',
      data: '',
    });
  });

  it('takes the size the screen settled at', () => {
    expect(parseViewMessage({ kind: 'resized', terminalId: 'one', cols: 120, rows: 30 })).toEqual({
      kind: 'resized',
      terminalId: 'one',
      cols: 120,
      rows: 30,
    });
  });

  it('takes the word that the keyboard is inside the terminal', () => {
    // What raises the context key the keybindings hang on. `focusedView` cannot
    // do it: it is true for the details half as well (O6).
    expect(parseViewMessage({ kind: 'focused', focused: true })).toEqual({
      kind: 'focused',
      focused: true,
    });
  });

  it('takes a selection on its way to the clipboard', () => {
    expect(parseViewMessage({ kind: 'copy', text: 'READY' })).toEqual({ kind: 'copy', text: 'READY' });
  });

  it('takes the wish to paste, which only the host can grant', () => {
    expect(parseViewMessage({ kind: 'wants-paste' })).toEqual({ kind: 'wants-paste' });
  });

  it.each([
    ['nothing', null],
    ['a number', 42],
    ['a string', 'ready'],
    ['an array', ['ready']],
    ['an object with no kind', { report: REPORT }],
    ['a kind we do not know', { kind: 'hello', report: REPORT }],
    ['a ready with no report', { kind: 'ready' }],
    ['a ready whose report is a string', { kind: 'ready', report: 'fine' }],
    ['a measurement with no reason', { kind: 'measured', report: REPORT }],
    ['a refusal with no words', { kind: 'refused' }],
    ['a violation with no directive', { kind: 'csp-violation', blockedUri: 'inline' }],
    ['a violation with no uri', { kind: 'csp-violation', directive: 'font-src' }],
    ['a receipt from no terminal', { kind: 'ack', chars: 10 }],
    ['a receipt for nothing countable', { kind: 'ack', terminalId: 'one', chars: '10' }],
    ['a receipt for a negative amount', { kind: 'ack', terminalId: 'one', chars: -1 }],
    ['input from no terminal', { kind: 'input', data: 'x' }],
    ['input that is not text', { kind: 'input', terminalId: 'one', data: 3 }],
    ['a size from no terminal', { kind: 'resized', cols: 80, rows: 24 }],
    ['a size with no columns', { kind: 'resized', terminalId: 'one', rows: 24 }],
    ['a size with no rows', { kind: 'resized', terminalId: 'one', cols: 80 }],
    ['a terminal of no columns', { kind: 'resized', terminalId: 'one', cols: 0, rows: 24 }],
    ['a terminal of fractional rows', { kind: 'resized', terminalId: 'one', cols: 80, rows: 24.5 }],
    ['a size that is not a number at all', { kind: 'resized', terminalId: 'one', cols: Number.NaN, rows: 24 }],
    ['a word about focus that is not a yes or a no', { kind: 'focused', focused: 'yes' }],
    ['a copy with nothing to copy', { kind: 'copy' }],
    ['a copy of something that is not text', { kind: 'copy', text: 42 }],
  ])('refuses %s', (_what, value) => {
    expect(parseViewMessage(value)).toBeNull();
  });

  it.each([
    ['a missing field', { ...REPORT, cols: undefined }],
    ['a string where a number belongs', { ...REPORT, rows: '30' }],
    ['a number that is not one', { ...REPORT, terminalWidth: Number.NaN }],
    ['an infinite width', { ...REPORT, detailsWidth: Number.POSITIVE_INFINITY }],
    ['a number where a string belongs', { ...REPORT, background: 0x1e1e1e }],
    ['a string where a flag belongs', { ...REPORT, codiconLoaded: 'yes' }],
    ['no unicode version, which is how the width table goes missing', { ...REPORT, unicodeVersion: undefined }],
    ['a number where the unicode version belongs', { ...REPORT, unicodeVersion: 11 }],
    ['no generation', { ...REPORT, generation: undefined }],
    ['no scrollback', { ...REPORT, scrollback: undefined }],
    ['no font family', { ...REPORT, fontFamily: null }],
    ['no font size', { ...REPORT, fontSize: undefined }],
    ['no word on what is attached, which is not the same as nothing attached', { ...REPORT, attached: undefined }],
    ['a number where the attached terminal belongs', { ...REPORT, attached: 7 }],
    ['no count of what was written', { ...REPORT, written: undefined }],
    ['no word on whether receipts are being sent', { ...REPORT, acking: undefined }],
    ['no word on bracketed paste, which decides what a paste means', { ...REPORT, bracketedPaste: undefined }],
  ])('refuses a report with %s', (_what, report) => {
    expect(parseViewMessage({ kind: 'ready', report })).toBeNull();
  });
});

describe('what the page accepts from the host', () => {
  it('takes the order to repaint', () => {
    expect(parseHostMessage({ kind: 'restyle', fontFamily: 'Cascadia Mono', fontSize: 13 })).toEqual({
      kind: 'restyle',
      fontFamily: 'Cascadia Mono',
      fontSize: 13,
    });
  });

  it('takes the order to report where things are', () => {
    expect(parseHostMessage({ kind: 'measure', because: 'the suite asked' })).toEqual({
      kind: 'measure',
      because: 'the suite asked',
    });
  });

  it('takes a terminal and the tail it is redrawn from', () => {
    expect(
      parseHostMessage({ kind: 'attach', terminalId: 'one', replay: 'hello\r\n', droppedChars: 0 })
    ).toEqual({ kind: 'attach', terminalId: 'one', replay: 'hello\r\n', droppedChars: 0 });
  });

  it('takes a replay that begins in the middle, and says how much is missing', () => {
    expect(
      parseHostMessage({ kind: 'attach', terminalId: 'one', replay: 'tail', droppedChars: 12_000 })
    ).toEqual({ kind: 'attach', terminalId: 'one', replay: 'tail', droppedChars: 12_000 });
  });

  it('takes output', () => {
    expect(parseHostMessage({ kind: 'output', terminalId: 'one', data: 'line\r\n' })).toEqual({
      kind: 'output',
      terminalId: 'one',
      data: 'line\r\n',
    });
  });

  it('takes a detachment and why', () => {
    expect(parseHostMessage({ kind: 'detach', terminalId: 'one', because: 'the process ended' })).toEqual({
      kind: 'detach',
      terminalId: 'one',
      because: 'the process ended',
    });
  });

  it('takes the clipboard on its way into the terminal', () => {
    const twoLines = ['first', 'second'].join(String.fromCharCode(10));

    expect(parseHostMessage({ kind: 'paste', text: twoLines })).toEqual({ kind: 'paste', text: twoLines });
  });

  it('takes the press probe, because a suite has no fingers', () => {
    expect(parseHostMessage({ kind: 'probe', action: { kind: 'press', chord: 'ctrl+j' } })).toEqual({
      kind: 'probe',
      action: { kind: 'press', chord: 'ctrl+j' },
    });
  });

  it.each([['terminal'], ['details']])('takes the focus probe for the %s half', (where) => {
    expect(parseHostMessage({ kind: 'probe', action: { kind: 'focus', where } })).toEqual({
      kind: 'probe',
      action: { kind: 'focus', where },
    });
  });

  it('takes the right button, which a suite has no hand for', () => {
    expect(parseHostMessage({ kind: 'probe', action: { kind: 'right-click' } })).toEqual({
      kind: 'probe',
      action: { kind: 'right-click' },
    });
  });

  it.each([[true], [false]])('takes the selection probe, selecting everything: %s', (all) => {
    expect(parseHostMessage({ kind: 'probe', action: { kind: 'select', all } })).toEqual({
      kind: 'probe',
      action: { kind: 'select', all },
    });
  });

  it('takes the drag probe, because a suite has no pointer', () => {
    expect(parseHostMessage({ kind: 'probe', action: { kind: 'drag-splitter', byPx: -120 } })).toEqual({
      kind: 'probe',
      action: { kind: 'drag-splitter', byPx: -120 },
    });
  });

  it('takes the probe that proves the policy is enforced', () => {
    expect(parseHostMessage({ kind: 'probe', action: { kind: 'break-policy' } })).toEqual({
      kind: 'probe',
      action: { kind: 'break-policy' },
    });
  });

  it('takes the typing probe, because a suite has no keyboard', () => {
    expect(parseHostMessage({ kind: 'probe', action: { kind: 'type', text: '/help\r' } })).toEqual({
      kind: 'probe',
      action: { kind: 'type', text: '/help\r' },
    });
  });

  it('takes the probe that makes the consumer go silent', () => {
    // The one that keeps "back-pressure works" from being a vacuum: with no way
    // to stop the receipts, a build with no pause at all passes every test.
    expect(parseHostMessage({ kind: 'probe', action: { kind: 'receipts', sending: false } })).toEqual({
      kind: 'probe',
      action: { kind: 'receipts', sending: false },
    });
  });

  it('takes the probe that makes the screen slow to take a message in', () => {
    // The one that keeps "a receipt means the screen has it" from being a
    // vacuum: xterm parses a plain flood faster than a pty produces it, so
    // without a slow screen an arrival-side receipt is indistinguishable.
    expect(parseHostMessage({ kind: 'probe', action: { kind: 'linger', ms: 40 } })).toEqual({
      kind: 'probe',
      action: { kind: 'linger', ms: 40 },
    });
  });

  it('takes a linger of nothing, which is how the probe is switched off', () => {
    expect(parseHostMessage({ kind: 'probe', action: { kind: 'linger', ms: 0 } })).toEqual({
      kind: 'probe',
      action: { kind: 'linger', ms: 0 },
    });
  });

  it.each([
    ['nothing', null],
    ['a string', 'measure'],
    ['a kind we do not know', { kind: 'reload' }],
    ['a restyle with no font', { kind: 'restyle', fontSize: 13 }],
    ['a restyle with a size that is not a number', { kind: 'restyle', fontFamily: 'Consolas', fontSize: 'big' }],
    ['a measurement order with no reason', { kind: 'measure' }],
    ['an attachment to no terminal', { kind: 'attach', replay: '', droppedChars: 0 }],
    ['an attachment with no replay', { kind: 'attach', terminalId: 'one', droppedChars: 0 }],
    ['an attachment that will not say what it lost', { kind: 'attach', terminalId: 'one', replay: '' }],
    ['output from no terminal', { kind: 'output', data: 'x' }],
    ['output that is not text', { kind: 'output', terminalId: 'one', data: 12 }],
    ['a detachment from no terminal', { kind: 'detach', because: 'it ended' }],
    ['a detachment with no reason', { kind: 'detach', terminalId: 'one' }],
    ['a probe with no action', { kind: 'probe' }],
    ['a probe whose action is a bare word', { kind: 'probe', action: 'drag-splitter' }],
    ['a probe with an action we do not have', { kind: 'probe', action: { kind: 'close-the-panel' } }],
    ['a drag with no distance', { kind: 'probe', action: { kind: 'drag-splitter' } }],
    ['typing with nothing to type', { kind: 'probe', action: { kind: 'type' } }],
    ['a receipts probe that will not say which way', { kind: 'probe', action: { kind: 'receipts' } }],
    ['a linger with no duration', { kind: 'probe', action: { kind: 'linger' } }],
    ['a linger that is not a duration', { kind: 'probe', action: { kind: 'linger', ms: Number.NaN } }],
    ['a linger of less than nothing', { kind: 'probe', action: { kind: 'linger', ms: -1 } }],
    ['a paste with nothing in it', { kind: 'paste' }],
    ['a paste of something that is not text', { kind: 'paste', text: ['a'] }],
    ['a press with no chord named', { kind: 'probe', action: { kind: 'press' } }],
    ['a focus probe with no half named', { kind: 'probe', action: { kind: 'focus' } }],
    ['a focus probe for a half we do not have', { kind: 'probe', action: { kind: 'focus', where: 'notes' } }],
    ['a selection probe that will not say which way', { kind: 'probe', action: { kind: 'select' } }],
  ])('refuses %s', (_what, value) => {
    expect(parseHostMessage(value)).toBeNull();
  });
});

describe('what the package hands the other side', () => {
  it('carries the chord table itself, and not a copy of it', () => {
    /*
     * This file IS the package -- `@gripterm/webview` points at it -- and the
     * extension host reads the chords through it: the manifest binds them, the
     * page refuses to answer them, and the command turns them into bytes. If the
     * entry point stopped carrying them, the host would quietly fall back to
     * knowing nothing about any chord, and every one of them would be refused
     * with the terminal in plain sight.
     */
    expect(TERMINAL_CHORDS).toBe(keys.TERMINAL_CHORDS);
    expect(chordById('ctrl+j')).toBe(keys.chordById('ctrl+j'));
    expect(chordFor({ code: 'KeyJ', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }))
      .toBe(keys.chordById('ctrl+j'));
    expect(isCopyPress({ code: 'KeyC', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false })).toBe(true);
    expect(isPastePress({ code: 'Insert', ctrlKey: false, altKey: false, shiftKey: true, metaKey: false })).toBe(true);
  });
});
