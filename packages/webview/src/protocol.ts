/**
 * The contract between the page and the extension host.
 *
 * One channel, two parsers, and both directions are parsed rather than cast.
 * A webview is a separate document with its own lifetime: it can be rebuilt
 * under the host, it can be a page of the previous build after a reload, and it
 * can die halfway through its own start-up. `postMessage` carries whatever the
 * other side sent, and a cast would turn every one of those cases into an
 * `undefined` three layers away -- in a `fit` that quietly does nothing, or in a
 * report that says a terminal has no columns because it has no report at all.
 *
 * So the rule of this module: what is not recognised is `null`, and `null` is
 * said out loud rather than acted on.
 *
 * This file is the one part of the webview package that runs on BOTH sides, so
 * it may not touch the document or the editor API. Nothing here does, and the
 * page's own code lives under `page/` where a linter rule keeps `vscode` and the
 * Node builtins out.
 */

/** What the page knows about itself, and the only thing the host learns from it. */
export interface ViewReport {
  /**
   * How many times this view has built a page, counted through the webview's own
   * persisted state.
   *
   * It exists because `retainContextWhenHidden: true` is a DECISION of M3.6 and
   * this is the only number that can check it: a page that survived being hidden
   * reports the generation it was born with, and a page that was thrown away and
   * rebuilt reports the next one.
   */
  readonly generation: number;
  readonly cols: number;
  readonly rows: number;
  /** Width of each half in CSS pixels, as the page's own box reports it. */
  readonly terminalWidth: number;
  readonly detailsWidth: number;
  readonly scrollback: number;
  /** The colour xterm was actually given, so "the theme arrived" is a value. */
  readonly background: string;
  readonly fontFamily: string;
  readonly fontSize: number;
  /** Whether the codicon font loaded -- what M3.9 draws terminal state with. */
  readonly codiconLoaded: boolean;
  /**
   * Which Unicode width table xterm is using.
   *
   * In the report because it is otherwise unfalsifiable: the addon is loaded in
   * one line, and dropping that line breaks nothing a suite can see -- while
   * every `✅` and every CJK glyph Claude Code prints becomes one cell instead
   * of two, and the frame after it is off by a column (M3.2 stage B, answer 4).
   */
  readonly unicodeVersion: string;
  /**
   * The terminal whose bytes this screen is showing, or `null` for a screen with
   * nothing behind it.
   *
   * `null` is a value and not a hole, so it is parsed as one: a page that
   * answered "no terminal" and a page that forgot the field are different
   * failures, and the second one is ours.
   */
  readonly attached: string | null;
  /**
   * Code units the screen has PARSED since it attached.
   *
   * The page's own count, so that "everything the host sent arrived" is an
   * equality between two numbers rather than a look at a screen. It is what
   * makes a lost message visible: the host knows what it sent, the page knows
   * what it has taken in, and nothing between them can quietly swallow a chunk.
   *
   * Parsed rather than handed over, since 2026-08-18: xterm queues what it is
   * given, so the two differ by however much of a flood is still waiting -- and
   * that difference is exactly what tells an honest receipt from one sent on
   * arrival (see `Screen.written`).
   */
  readonly written: number;
  /**
   * Whether the page is sending receipts.
   *
   * Here because the integration suite turns it OFF on purpose: with no way to
   * make a consumer go silent there is no way to show that back-pressure ever
   * engages, and "it did not need to pause" is what a build with no pause at all
   * reports too.
   */
  readonly acking: boolean;
}

export type ViewMessage =
  | { readonly kind: 'ready', readonly report: ViewReport }
  | { readonly kind: 'measured', readonly report: ViewReport, readonly because: string }
  | { readonly kind: 'refused', readonly what: string }
  | { readonly kind: 'csp-violation', readonly directive: string, readonly blockedUri: string }
  /**
   * The receipt, and the only honest one there is.
   *
   * It is posted from the callback of `term.write(data, cb)`, which fires when
   * xterm has PARSED the text rather than when the message arrived -- the
   * difference between the two is the whole of back-pressure. Measured at 17.5
   * ms on average through a 16 ms window (M3.2 stage B, §6).
   */
  | { readonly kind: 'ack', readonly terminalId: string, readonly chars: number }
  /** What the person typed, on its way to the process. */
  | { readonly kind: 'input', readonly terminalId: string, readonly data: string }
  /**
   * The size the screen settled at, on its way to the pty.
   *
   * Sent when xterm's own `onResize` fires, which is after the page has already
   * coalesced the stream of layout changes into one `fit` -- so this is the
   * trailing edge of the debounce rather than a second one.
   */
  | { readonly kind: 'resized', readonly terminalId: string, readonly cols: number, readonly rows: number };

export type HostMessage =
  | { readonly kind: 'restyle', readonly fontFamily: string, readonly fontSize: number }
  | { readonly kind: 'measure', readonly because: string }
  /**
   * Take this terminal, from this text.
   *
   * The rehydration half of the handshake. A page that was thrown away and
   * rebuilt has an empty xterm and no idea which agent it belongs to, so the
   * host answers its `ready` with everything needed to draw the terminal again:
   * the id it is showing and the tail of what that terminal has printed.
   *
   * `droppedChars` is how much came before the tail and is gone. Carried rather
   * than hidden because a replay that starts mid-stream looks exactly like a
   * complete one, and a person reading it would take a fragment for the whole
   * history (§7.2: there is no recording, only a bounded tail).
   */
  | {
    readonly kind: 'attach';
    readonly terminalId: string;
    readonly replay: string;
    readonly droppedChars: number;
  }
  /** Bytes the terminal produced, joined into one message per 16 ms window. */
  | { readonly kind: 'output', readonly terminalId: string, readonly data: string }
  /** This terminal is no longer on this screen, and why -- it ended, or another took its place. */
  | { readonly kind: 'detach', readonly terminalId: string, readonly because: string }
  /**
   * The seam the integration suite drives the page through, and it is named
   * `probe` so that nobody has to guess what it is for.
   *
   * A suite has no pointer and no keyboard. "The border between the halves
   * moves" and "input is not lost under a flood" are acceptance lines, and the
   * alternatives to this are worse: asserting on the handlers through a copy of
   * them, or asserting nothing and calling the step done. Every probe below
   * takes the SAME path a person's hand would.
   */
  | { readonly kind: 'probe', readonly action: ProbeAction };

/**
 * What a probe may ask for.
 *
 * Two of the four exist to keep an assertion from being a vacuum -- the defect
 * class this repository keeps meeting (M1.5, M2.11, M3.5):
 *
 *   * `break-policy` reaches for a resource the policy forbids, so that "no CSP
 *     violations" is a measurement rather than what a page with no listener
 *     reports.
 *   * `receipts` stops the page acknowledging output, so that "back-pressure
 *     engages" can be watched. Without it, a build with no `pause()` at all
 *     passes every test a healthy consumer takes.
 *   * `linger` makes the screen SLOW to take a message in, so that "a receipt
 *     means the screen has it" can be watched. Without it the two possible
 *     receipts are indistinguishable: on this machine xterm parses plain output
 *     faster than a pty produces it, so a page acknowledging on arrival and a
 *     page acknowledging on parsing report the same numbers (M19, 2026-08-18).
 */
export type ProbeAction =
  | { readonly kind: 'drag-splitter', readonly byPx: number }
  | { readonly kind: 'break-policy' }
  /** Types into the screen exactly as a keystroke does -- through xterm's own `input`. */
  | { readonly kind: 'type', readonly text: string }
  | { readonly kind: 'receipts', readonly sending: boolean }
  /** Milliseconds the screen takes over each message before it counts as taken in. `0` is off. */
  | { readonly kind: 'linger', readonly ms: number };

type Fields = Record<string, unknown>;

function fields(value: unknown): Fields | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Fields;
}

/** A number that is really one: `NaN` and the infinities are not measurements. */
function count(source: Fields, key: string): number | null {
  const found = source[key];
  return typeof found === 'number' && Number.isFinite(found) ? found : null;
}

function text(source: Fields, key: string): string | null {
  const found = source[key];
  return typeof found === 'string' ? found : null;
}

function flag(source: Fields, key: string): boolean | null {
  const found = source[key];
  return typeof found === 'boolean' ? found : null;
}

/**
 * A string that may legitimately be nothing.
 *
 * Wrapped in an object, and that is the whole reason it is a separate reader:
 * `null` means two different things here -- "the page said there is no terminal"
 * and "the field was missing" -- and a reader that returned a bare `null` would
 * make the second one indistinguishable from the first. An explicit `null`
 * passes; an absent field is refused like any other.
 */
function textOrNothing(source: Fields, key: string): { readonly value: string | null } | null {
  const found = source[key];
  if (found === null) {
    return { value: null };
  }
  return typeof found === 'string' ? { value: found } : null;
}

function parseReport(value: unknown): ViewReport | null {
  const source = fields(value);
  if (source === null) {
    return null;
  }
  const generation = count(source, 'generation');
  const cols = count(source, 'cols');
  const rows = count(source, 'rows');
  const terminalWidth = count(source, 'terminalWidth');
  const detailsWidth = count(source, 'detailsWidth');
  const scrollback = count(source, 'scrollback');
  const background = text(source, 'background');
  const fontFamily = text(source, 'fontFamily');
  const fontSize = count(source, 'fontSize');
  const codiconLoaded = flag(source, 'codiconLoaded');
  const unicodeVersion = text(source, 'unicodeVersion');
  const attached = textOrNothing(source, 'attached');
  const written = count(source, 'written');
  const acking = flag(source, 'acking');
  if (
    generation === null ||
    cols === null ||
    rows === null ||
    terminalWidth === null ||
    detailsWidth === null ||
    scrollback === null ||
    background === null ||
    fontFamily === null ||
    fontSize === null ||
    codiconLoaded === null ||
    unicodeVersion === null ||
    attached === null ||
    written === null ||
    acking === null
  ) {
    return null;
  }
  return {
    generation,
    cols,
    rows,
    terminalWidth,
    detailsWidth,
    scrollback,
    background,
    fontFamily,
    fontSize,
    codiconLoaded,
    unicodeVersion,
    attached: attached.value,
    written,
    acking,
  };
}

/** What the host is willing to hear from the page. */
export function parseViewMessage(value: unknown): ViewMessage | null {
  const source = fields(value);
  if (source === null) {
    return null;
  }
  switch (source.kind) {
    case 'ready': {
      const report = parseReport(source.report);
      return report === null ? null : { kind: 'ready', report };
    }
    case 'measured': {
      const report = parseReport(source.report);
      const because = text(source, 'because');
      return report === null || because === null ? null : { kind: 'measured', report, because };
    }
    case 'refused': {
      const what = text(source, 'what');
      return what === null ? null : { kind: 'refused', what };
    }
    case 'csp-violation': {
      const directive = text(source, 'directive');
      const blockedUri = text(source, 'blockedUri');
      return directive === null || blockedUri === null
        ? null
        : { kind: 'csp-violation', directive, blockedUri };
    }
    case 'ack': {
      const terminalId = text(source, 'terminalId');
      const chars = count(source, 'chars');
      // A receipt for a negative amount would put the flow counter into credit
      // and buy a flood a whole extra window before the next pause.
      return terminalId === null || chars === null || chars < 0
        ? null
        : { kind: 'ack', terminalId, chars };
    }
    case 'input': {
      const terminalId = text(source, 'terminalId');
      const data = text(source, 'data');
      return terminalId === null || data === null ? null : { kind: 'input', terminalId, data };
    }
    case 'resized': {
      const terminalId = text(source, 'terminalId');
      const cols = count(source, 'cols');
      const rows = count(source, 'rows');
      // A size that is not one reaches a native call: `proposeDimensions()`
      // answers `NaN` for a hidden box (xterm.js#3029), and a pty asked for
      // zero columns is a TUI that draws nothing ever again.
      return terminalId === null || !isSize(cols) || !isSize(rows)
        ? null
        : { kind: 'resized', terminalId, cols, rows };
    }
    default:
      return null;
  }
}

/** A number of cells a terminal can really have: whole, and at least one. */
function isSize(value: number | null): value is number {
  if (value === null) {
    return false;
  }
  return Number.isInteger(value) && value > 0;
}

/** What the page is willing to hear from the host. */
export function parseHostMessage(value: unknown): HostMessage | null {
  const source = fields(value);
  if (source === null) {
    return null;
  }
  switch (source.kind) {
    case 'restyle': {
      const fontFamily = text(source, 'fontFamily');
      const fontSize = count(source, 'fontSize');
      return fontFamily === null || fontSize === null
        ? null
        : { kind: 'restyle', fontFamily, fontSize };
    }
    case 'measure': {
      const because = text(source, 'because');
      return because === null ? null : { kind: 'measure', because };
    }
    case 'attach': {
      const terminalId = text(source, 'terminalId');
      const replay = text(source, 'replay');
      const droppedChars = count(source, 'droppedChars');
      return terminalId === null || replay === null || droppedChars === null
        ? null
        : { kind: 'attach', terminalId, replay, droppedChars };
    }
    case 'output': {
      const terminalId = text(source, 'terminalId');
      const data = text(source, 'data');
      return terminalId === null || data === null ? null : { kind: 'output', terminalId, data };
    }
    case 'detach': {
      const terminalId = text(source, 'terminalId');
      const because = text(source, 'because');
      return terminalId === null || because === null ? null : { kind: 'detach', terminalId, because };
    }
    case 'probe': {
      const action = parseProbe(source.action);
      return action === null ? null : { kind: 'probe', action };
    }
    default:
      return null;
  }
}

function parseProbe(value: unknown): ProbeAction | null {
  const source = fields(value);
  if (source === null) {
    return null;
  }
  switch (source.kind) {
    case 'drag-splitter': {
      const byPx = count(source, 'byPx');
      return byPx === null ? null : { kind: 'drag-splitter', byPx };
    }
    case 'break-policy':
      return { kind: 'break-policy' };
    case 'type': {
      const probeText = text(source, 'text');
      return probeText === null ? null : { kind: 'type', text: probeText };
    }
    case 'receipts': {
      const sending = flag(source, 'sending');
      return sending === null ? null : { kind: 'receipts', sending };
    }
    case 'linger': {
      // Zero is a value here -- it is how the probe is switched off -- so what
      // is refused is a delay that is not a duration at all.
      const ms = count(source, 'ms');
      return ms === null || ms < 0 ? null : { kind: 'linger', ms };
    }
    default:
      return null;
  }
}
