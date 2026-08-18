import {
  TERMINAL_CHORDS,
  chordById,
  chordFor,
  codiconClasses,
  isCopyPress,
  isPastePress,
  parseHostMessage,
  parseViewMessage,
  themeColorVariable,
} from '../../packages/webview/src/protocol';
import * as keys from '../../packages/webview/src/keys';
import * as look from '../../packages/webview/src/tab-look';

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

/** One tab as the page found it on its own screen: the glyph is the measurement. */
const TAB_REPORT = {
  terminalId: 'a2f1c8de-0000-4000-8000-000000000001',
  label: 'auth-refactor',
  active: true,
  attention: false,
  over: false,
  glyph: '',
  colour: '#3794ff',
};

/** One tab as the host orders it drawn: ids, and the page turns them into CSS. */
const TAB_ORDER = {
  terminalId: 'a2f1c8de-0000-4000-8000-000000000001',
  label: 'auth-refactor',
  iconId: 'sync~spin',
  colorId: 'charts.blue',
  active: true,
  attention: false,
  over: false,
};

/** The details half as the page found it, and the two facts only it can answer. */
const DETAILS_REPORT = {
  terminalId: 'a2f1c8de-0000-4000-8000-000000000001',
  nothing: null,
  headline: 'auth-refactor working',
  glyph: '',
  facts: ['tool: Edit', 'folder: D:/Projects/foo'],
  task: 'Move token validation',
  notes: 1,
  events: ['Edit started'],
  notices: [],
  draws: 3,
};

/** The details half as the host orders it drawn: what the core rule produced. */
const DETAILS_ORDER = {
  nothing: null,
  headline: {
    terminalId: 'a2f1c8de-0000-4000-8000-000000000001',
    label: 'auth-refactor',
    words: 'working',
    iconId: 'sync~spin',
    colorId: 'charts.blue',
    over: false,
  },
  facts: [{ name: 'tool', value: 'Edit' }],
  startedAtMs: 1_700_000_000_000,
  lastEventAtMs: 1_700_000_060_000,
  task: 'Move token validation',
  notes: [{ atMs: 1_700_000_030_000, text: 'read ADR-014 first' }],
  events: [{ atMs: 1_700_000_040_000, words: 'Edit started' }],
  notices: ['Texts are not kept in the journal.'],
};

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
  focusedHere: true,
  documentFocused: true,
  tabs: [TAB_REPORT],
  details: DETAILS_REPORT,
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

  it('takes a strip with nothing on it, which is a panel holding no terminals', () => {
    expect(parseViewMessage({ kind: 'ready', report: { ...REPORT, tabs: [] } })).toEqual({
      kind: 'ready',
      report: { ...REPORT, tabs: [] },
    });
  });

  it('takes the tab the person clicked', () => {
    expect(parseViewMessage({ kind: 'chose', terminalId: 'one' })).toEqual({
      kind: 'chose',
      terminalId: 'one',
    });
  });

  it('takes the cross the person clicked', () => {
    expect(parseViewMessage({ kind: 'wants-close', terminalId: 'one' })).toEqual({
      kind: 'wants-close',
      terminalId: 'one',
    });
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
    ['a choice of no terminal', { kind: 'chose' }],
    ['a choice of something that is not a terminal', { kind: 'chose', terminalId: 7 }],
    ['a close of no terminal', { kind: 'wants-close' }],
    ['a close of something that is not a terminal', { kind: 'wants-close', terminalId: null }],
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
    ['no strip at all, which is not the same as an empty one', { ...REPORT, tabs: undefined }],
    ['a strip that is not a list', { ...REPORT, tabs: { one: TAB_REPORT } }],
    ['a tab that is a bare word', { ...REPORT, tabs: ['auth-refactor'] }],
    ['a tab of no terminal', { ...REPORT, tabs: [{ ...TAB_REPORT, terminalId: undefined }] }],
    ['a tab with no words on it', { ...REPORT, tabs: [{ ...TAB_REPORT, label: 7 }] }],
    ['a tab that will not say whether it is the one on screen', { ...REPORT, tabs: [{ ...TAB_REPORT, active: 'yes' }] }],
    ['a tab that will not say whether it is marked', { ...REPORT, tabs: [{ ...TAB_REPORT, attention: undefined }] }],
    ['a tab that will not say whether its process is gone', { ...REPORT, tabs: [{ ...TAB_REPORT, over: null }] }],
    ['a tab with no word on what glyph it drew', { ...REPORT, tabs: [{ ...TAB_REPORT, glyph: undefined }] }],
    ['a tab with no word on what colour it resolved', { ...REPORT, tabs: [{ ...TAB_REPORT, colour: undefined }] }],
    // One bad tab refuses the whole strip: a report about three of four tabs is
    // not a report about a strip, and a suite reading the good three would be
    // asserting about a picture that was never on screen.
    ['one good tab and one hole', { ...REPORT, tabs: [TAB_REPORT, { ...TAB_REPORT, label: undefined }] }],
    ['no word on bracketed paste, which decides what a paste means', { ...REPORT, bracketedPaste: undefined }],
    ['no word on where the keyboard is, which the page answers for itself', { ...REPORT, focusedHere: undefined }],
    ['no word on whether the document has the keyboard at all', { ...REPORT, documentFocused: undefined }],
    ['no details half at all', { ...REPORT, details: undefined }],
    ['a details half that is not an object', { ...REPORT, details: 'nothing yet' }],
    ['a details half that will not say which terminal it is about', { ...REPORT, details: { ...DETAILS_REPORT, terminalId: undefined } }],
    ['a details half with no word on its empty state', { ...REPORT, details: { ...DETAILS_REPORT, nothing: undefined } }],
    ['a details half with no heading', { ...REPORT, details: { ...DETAILS_REPORT, headline: null } }],
    ['a details half with no word on the glyph it drew', { ...REPORT, details: { ...DETAILS_REPORT, glyph: undefined } }],
    ['a details half whose facts are not a list', { ...REPORT, details: { ...DETAILS_REPORT, facts: 'tool: Edit' } }],
    ['a details half with a fact that is not words', { ...REPORT, details: { ...DETAILS_REPORT, facts: [7] } }],
    ['a details half with no word on the task', { ...REPORT, details: { ...DETAILS_REPORT, task: undefined } }],
    ['a details half that will not count its notes', { ...REPORT, details: { ...DETAILS_REPORT, notes: undefined } }],
    ['a details half whose events are not a list', { ...REPORT, details: { ...DETAILS_REPORT, events: undefined } }],
    ['a details half with an event that is not words', { ...REPORT, details: { ...DETAILS_REPORT, events: [{ words: 'Edit started' }] } }],
    ['a details half whose notices are not a list', { ...REPORT, details: { ...DETAILS_REPORT, notices: null } }],
    ['a details half that will not say how many times it was drawn', { ...REPORT, details: { ...DETAILS_REPORT, draws: undefined } }],
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

  it('takes the details half, whole', () => {
    expect(parseHostMessage({ kind: 'details', view: DETAILS_ORDER })).toEqual({
      kind: 'details',
      view: DETAILS_ORDER,
    });
  });

  it('takes a details half with nothing to describe, which is a state and not a hole', () => {
    const empty = {
      ...DETAILS_ORDER,
      nothing: 'No terminal in this panel yet.',
      headline: null,
      facts: [],
      startedAtMs: null,
      lastEventAtMs: null,
      task: null,
      notes: [],
      events: [],
      notices: [],
    };

    expect(parseHostMessage({ kind: 'details', view: empty })).toEqual({ kind: 'details', view: empty });
  });

  it('takes a heading with no colour of its own', () => {
    const view = { ...DETAILS_ORDER, headline: { ...DETAILS_ORDER.headline, colorId: null } };

    expect(parseHostMessage({ kind: 'details', view })).toEqual({ kind: 'details', view });
  });

  it.each([
    ['no half at all', { kind: 'details' }],
    ['a half that is not an object', { kind: 'details', view: 'nothing' }],
    ['no word on the empty state', { kind: 'details', view: { ...DETAILS_ORDER, nothing: undefined } }],
    ['a heading that is not an object', { kind: 'details', view: { ...DETAILS_ORDER, headline: 'auth-refactor' } }],
    ['a heading of no terminal', { kind: 'details', view: { ...DETAILS_ORDER, headline: { ...DETAILS_ORDER.headline, terminalId: undefined } } }],
    ['a heading with no name', { kind: 'details', view: { ...DETAILS_ORDER, headline: { ...DETAILS_ORDER.headline, label: 7 } } }],
    ['a heading with no state in words', { kind: 'details', view: { ...DETAILS_ORDER, headline: { ...DETAILS_ORDER.headline, words: undefined } } }],
    ['a heading with no icon', { kind: 'details', view: { ...DETAILS_ORDER, headline: { ...DETAILS_ORDER.headline, iconId: undefined } } }],
    ['a heading with a colour that is not a name', { kind: 'details', view: { ...DETAILS_ORDER, headline: { ...DETAILS_ORDER.headline, colorId: 7 } } }],
    ['a heading that will not say whether the terminal is over', { kind: 'details', view: { ...DETAILS_ORDER, headline: { ...DETAILS_ORDER.headline, over: 'yes' } } }],
    ['facts that are not a list', { kind: 'details', view: { ...DETAILS_ORDER, facts: { tool: 'Edit' } } }],
    ['a fact that is not an object', { kind: 'details', view: { ...DETAILS_ORDER, facts: ['tool'] } }],
    ['a fact with no name', { kind: 'details', view: { ...DETAILS_ORDER, facts: [{ value: 'Edit' }] } }],
    ['a fact with no value', { kind: 'details', view: { ...DETAILS_ORDER, facts: [{ name: 'tool' }] } }],
    ['a start that is neither a moment nor nothing', { kind: 'details', view: { ...DETAILS_ORDER, startedAtMs: 'today' } }],
    ['a start that is not a number at all', { kind: 'details', view: { ...DETAILS_ORDER, startedAtMs: Number.NaN } }],
    ['no word on the last event', { kind: 'details', view: { ...DETAILS_ORDER, lastEventAtMs: undefined } }],
    ['no word on the task', { kind: 'details', view: { ...DETAILS_ORDER, task: undefined } }],
    ['notes that are not a list', { kind: 'details', view: { ...DETAILS_ORDER, notes: 'read ADR-014' } }],
    ['a note that is not an object', { kind: 'details', view: { ...DETAILS_ORDER, notes: ['read ADR-014'] } }],
    ['a note with no moment', { kind: 'details', view: { ...DETAILS_ORDER, notes: [{ text: 'read ADR-014' }] } }],
    ['a note with no words', { kind: 'details', view: { ...DETAILS_ORDER, notes: [{ atMs: 1, text: 7 }] } }],
    ['events that are not a list', { kind: 'details', view: { ...DETAILS_ORDER, events: undefined } }],
    ['an event that is not an object', { kind: 'details', view: { ...DETAILS_ORDER, events: ['Edit started'] } }],
    ['an event with no moment', { kind: 'details', view: { ...DETAILS_ORDER, events: [{ words: 'Edit started' }] } }],
    ['an event with no words', { kind: 'details', view: { ...DETAILS_ORDER, events: [{ atMs: 1 }] } }],
    ['notices that are not a list', { kind: 'details', view: { ...DETAILS_ORDER, notices: 'all is well' } }],
    ['a notice that is not words', { kind: 'details', view: { ...DETAILS_ORDER, notices: [7] } }],
  ])('refuses a details half with %s', (_what, message) => {
    expect(parseHostMessage(message)).toBeNull();
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

  it('takes the whole strip, which is how the page is told what to draw', () => {
    expect(parseHostMessage({ kind: 'tabs', tabs: [TAB_ORDER] })).toEqual({
      kind: 'tabs',
      tabs: [TAB_ORDER],
    });
  });

  it('takes a strip of nothing, which is how the last tab is closed', () => {
    expect(parseHostMessage({ kind: 'tabs', tabs: [] })).toEqual({ kind: 'tabs', tabs: [] });
  });

  it('takes a tab whose state has no colour of its own', () => {
    // `null` is an answer here and not an omission: a state that gives up its
    // colour (`ended`) is drawn in the page's own, and a tab whose colour field
    // went missing is a different failure -- ours.
    const plain = { ...TAB_ORDER, colorId: null };
    expect(parseHostMessage({ kind: 'tabs', tabs: [plain] })).toEqual({ kind: 'tabs', tabs: [plain] });
  });

  it('takes the click on a tab, because a suite has no mouse', () => {
    expect(parseHostMessage({ kind: 'probe', action: { kind: 'click-tab', terminalId: 'one' } })).toEqual({
      kind: 'probe',
      action: { kind: 'click-tab', terminalId: 'one' },
    });
  });

  it('takes the click on a cross, which is the one click that ends a conversation', () => {
    expect(parseHostMessage({ kind: 'probe', action: { kind: 'click-close', terminalId: 'one' } })).toEqual({
      kind: 'probe',
      action: { kind: 'click-close', terminalId: 'one' },
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
    ['a click on no tab', { kind: 'probe', action: { kind: 'click-tab' } }],
    ['a click on a cross with no terminal', { kind: 'probe', action: { kind: 'click-close', terminalId: 3 } }],
    ['a strip that is not a list', { kind: 'tabs', tabs: 'one' }],
    ['a strip with no list at all', { kind: 'tabs' }],
    ['a tab with no terminal', { kind: 'tabs', tabs: [{ ...TAB_ORDER, terminalId: undefined }] }],
    ['a tab with no words on it', { kind: 'tabs', tabs: [{ ...TAB_ORDER, label: undefined }] }],
    ['a tab with no icon', { kind: 'tabs', tabs: [{ ...TAB_ORDER, iconId: undefined }] }],
    ['a tab whose colour field went missing', { kind: 'tabs', tabs: [{ ...TAB_ORDER, colorId: undefined }] }],
    ['a tab whose colour is a number', { kind: 'tabs', tabs: [{ ...TAB_ORDER, colorId: 0x3794ff }] }],
    ['a tab that will not say whether it is on screen', { kind: 'tabs', tabs: [{ ...TAB_ORDER, active: undefined }] }],
    ['a tab that will not say whether it is marked', { kind: 'tabs', tabs: [{ ...TAB_ORDER, attention: 'no' }] }],
    ['a tab that will not say whether its process is gone', { kind: 'tabs', tabs: [{ ...TAB_ORDER, over: undefined }] }],
    ['a tab that is a bare word', { kind: 'tabs', tabs: ['auth-refactor'] }],
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

  it('carries the two translations a tab is drawn through', () => {
    // The suite that checks what the page DREW has to be able to say what it
    // should have drawn, and a second copy of these rules written beside the
    // assertions would agree with the page about anything at all.
    expect(codiconClasses('sync~spin')).toStrictEqual(look.codiconClasses('sync~spin'));
    expect(themeColorVariable('charts.blue')).toBe(look.themeColorVariable('charts.blue'));
  });
});
