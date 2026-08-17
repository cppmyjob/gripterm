import { parseHostMessage, parseViewMessage } from '../../packages/webview/src/protocol';

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
};

describe('what the host accepts from the page', () => {
  it('takes a ready with its report', () => {
    expect(parseViewMessage({ kind: 'ready', report: REPORT })).toEqual({
      kind: 'ready',
      report: REPORT,
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

  it('takes a policy violation, which is the one message this step exists to hear', () => {
    expect(
      parseViewMessage({ kind: 'csp-violation', directive: 'script-src', blockedUri: 'inline' })
    ).toEqual({ kind: 'csp-violation', directive: 'script-src', blockedUri: 'inline' });
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

  it('takes the probe, because a suite has no hands', () => {
    expect(parseHostMessage({ kind: 'probe', action: 'drag-splitter', byPx: -120 })).toEqual({
      kind: 'probe',
      action: 'drag-splitter',
      byPx: -120,
    });
  });

  it('takes the other probe, the one that proves the policy is enforced', () => {
    expect(parseHostMessage({ kind: 'probe', action: 'break-policy', byPx: 0 })).toEqual({
      kind: 'probe',
      action: 'break-policy',
      byPx: 0,
    });
  });

  it.each([
    ['nothing', null],
    ['a string', 'measure'],
    ['a kind we do not know', { kind: 'reload' }],
    ['a restyle with no font', { kind: 'restyle', fontSize: 13 }],
    ['a restyle with a size that is not a number', { kind: 'restyle', fontFamily: 'Consolas', fontSize: 'big' }],
    ['a measurement order with no reason', { kind: 'measure' }],
    ['a probe with an action we do not have', { kind: 'probe', action: 'close-the-panel', byPx: 10 }],
    ['a probe with no distance', { kind: 'probe', action: 'drag-splitter' }],
  ])('refuses %s', (_what, value) => {
    expect(parseHostMessage(value)).toBeNull();
  });
});
