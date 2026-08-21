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
   * Whether the terminal on this screen has asked for bracketed paste.
   *
   * The program's own request (DECSET 2004) as xterm understands it after the
   * request has crossed ConPTY, our channel and a replay. It is reported because
   * the promise of M3.8 -- "a paste arrives wrapped" -- is only true while this
   * is true, and a suite that asserted the wrapping without asserting this would
   * be unable to tell "we sent it wrong" from "the program never asked".
   */
  readonly bracketedPaste: boolean;
  /**
   * Whether the keyboard is inside the terminal, as the PAGE sees it.
   *
   * The page already says so when it changes (`focused`), and the host keeps
   * that answer -- but a message is a thing that can be missed, and "the host
   * believes the keyboard is elsewhere" and "the page never got the focus" send
   * somebody to different places. In the report, both can be read at once.
   */
  readonly focusedHere: boolean;
  /**
   * Whether this document has the keyboard at all, as the browser sees it.
   *
   * Beside `focusedHere` because the two answer different questions and only
   * together tell the two failures apart: an element of ours that refused the
   * focus, and a whole webview the editor never gave it to.
   */
  readonly documentFocused: boolean;
  /**
   * The strip as the page really DREW it -- one entry per tab on screen.
   *
   * Not an echo of what the host sent: every field here is read back off the
   * document, and two of them cannot be read anywhere else. `glyph` is the
   * character the codicon font actually put in the tab, so an icon id carried
   * across literally (`sync~spin` as one class) reports `none` instead of a
   * turning arrow -- which is the defect of M3.9 and is otherwise invisible in
   * everything but a screenshot. `colour` is what the editor's own variable
   * resolved to, so "the theme gave us this colour" is a value rather than an
   * assumption in a stylesheet.
   */
  readonly tabs: readonly TabReport[];
  /**
   * The details half as the page really DREW it (M3.11).
   *
   * Read back off the document for the same reason the strip is: the half is
   * the one surface that claims to say what this build KNOWS, and an assertion
   * against what the host SENT would be an assertion that the host agrees with
   * itself. `draws` is here for the promise the plan makes in words -- that the
   * half follows the registry's signal and does not poll -- because a number
   * that stands still while nothing happens is the only way to tell the two
   * apart.
   */
  readonly details: DetailsReport;
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

/**
 * One tab, as the host orders it drawn.
 *
 * The same fields `stripTabs` produces in the core, carried across without a
 * translation of their own -- the translations happen in the page, where the
 * document is (`tab-look.ts`), because they are about CSS and not about
 * terminals.
 */
export interface TabOrder {
  readonly terminalId: string;
  readonly label: string;
  /** A `ThemeIcon` id, modifier and all. Turned into classes by the page. */
  readonly iconId: string;
  readonly colorId: string | null;
  readonly active: boolean;
  readonly attention: boolean;
  readonly over: boolean;
}

/** One tab, as the page found it on its own screen afterwards. */
export interface TabReport {
  readonly terminalId: string;
  readonly label: string;
  readonly active: boolean;
  readonly attention: boolean;
  readonly over: boolean;
  /**
   * The character the codicon font put in this tab, or `none` when it put
   * nothing there.
   *
   * The measurement the whole icon question turns on. A class the stylesheet
   * has no rule for leaves `content` at `none`, which is exactly what a
   * literally-carried `sync~spin` produces -- and what a person sees as an empty
   * space where a state should be.
   */
  readonly glyph: string;
  /** What the icon's theme variable resolved to, or an empty string when the theme has none. */
  readonly colour: string;
}

/**
 * The details half, as the host orders it drawn.
 *
 * The same fields `describeTerminal` produces in the core, carried across
 * without a translation of their own -- the page turns them into a document,
 * and the moments into words a person's own clock agrees with, which is the one
 * decision that cannot be taken in a rule (`atMs` here, `toLocaleString`
 * there).
 */
export interface DetailsOrder {
  /** What to say when there is nothing to describe, or `null` when there is. */
  readonly nothing: string | null;
  readonly headline: DetailsHeadOrder | null;
  readonly facts: readonly DetailsFactOrder[];
  readonly startedAtMs: number | null;
  readonly lastEventAtMs: number | null;
  readonly task: string | null;
  readonly notes: readonly DetailsNoteOrder[];
  readonly events: readonly DetailsEventOrder[];
  readonly notices: readonly string[];
}

export interface DetailsHeadOrder {
  readonly terminalId: string;
  readonly label: string;
  readonly words: string;
  /** A `ThemeIcon` id, modifier and all -- turned into classes by the page. */
  readonly iconId: string;
  readonly colorId: string | null;
  readonly over: boolean;
}

export interface DetailsFactOrder {
  readonly name: string;
  readonly value: string;
}

export interface DetailsNoteOrder {
  readonly atMs: number;
  readonly text: string;
}

export interface DetailsEventOrder {
  readonly atMs: number;
  readonly words: string;
}

/** The details half, as the page found it on its own screen afterwards. */
export interface DetailsReport {
  /** The terminal the half is about, or `null` when it is drawing an empty state. */
  readonly terminalId: string | null;
  /** The sentence in place of a terminal, or `null` when there is a terminal. */
  readonly nothing: string | null;
  /** The heading as text: the name and what it is doing. */
  readonly headline: string;
  /** The character the codicon font put beside the heading, or `none`. */
  readonly glyph: string;
  /** Every fact as `name: value`, in the order they were drawn. */
  readonly facts: readonly string[];
  readonly task: string | null;
  readonly notes: number;
  /** The words of every event drawn, oldest first. */
  readonly events: readonly string[];
  readonly notices: readonly string[];
  /**
   * How many times this half has been redrawn since the page was built.
   *
   * The measurement behind "without polling": a half that redraws on a timer
   * counts up while a person does nothing, and no assertion about its contents
   * can tell that from a half that redraws on a signal.
   */
  readonly draws: number;
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
  | { readonly kind: 'resized', readonly terminalId: string, readonly cols: number, readonly rows: number }
  /**
   * The keyboard is inside the terminal, or it has left it.
   *
   * What raises and lowers the context key the keybindings hang on, and the
   * reason it is the PAGE that says so rather than the editor: `focusedView` is
   * true for the whole panel, so the details half would take the arrow keys and
   * `Esc` away from a person editing a note in it (O6). Only the terminal
   * element's own focus means the terminal has the keyboard.
   */
  | { readonly kind: 'focused', readonly focused: boolean }
  /** The selection, on its way to the clipboard: a webview cannot write it itself. */
  | { readonly kind: 'copy', readonly text: string }
  /** The person asked to paste, and only the host can read the clipboard. */
  | { readonly kind: 'wants-paste' }
  /**
   * The person clicked a tab: show me this one.
   *
   * A wish and not an act. Which terminal the panel is showing is one answer
   * owned by the stage (`terminal-stage.ts`), asked from four directions that
   * cannot see each other -- so the strip is one more caller of `shown` rather
   * than a second copy of that state.
   */
  | { readonly kind: 'chose', readonly terminalId: string }
  /**
   * The person dragged a tab and let go of it somewhere (owner's decision
   * 2026-08-21).
   *
   * `toIndex` is in the units the STORE speaks -- the place this tab will have
   * in the strip once it has moved -- and not "the tab it was dropped on plus a
   * half". The arithmetic that gets from a pointer to that number is a rule with
   * a test of its own (`drop-rule.ts`); doing it again on the host's side is how
   * two sides of a channel come to disagree about the same drop.
   */
  | { readonly kind: 'reorder', readonly terminalId: string, readonly toIndex: number }
  /**
   * The person clicked the cross on a tab.
   *
   * Also a wish, and this one has to be: closing a terminal is what writes
   * `closedAt`, which is the mark that keeps a record from ever coming back
   * (§4.2). A page that disposed of it itself would have gone round the one
   * command that owns that decision.
   */
  | { readonly kind: 'wants-close', readonly terminalId: string };

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
   * The clipboard, on its way into the terminal.
   *
   * It travels this way -- host reads, page pastes -- for one reason, and it is
   * the defect M3.8 exists to avoid: the text must reach the pty through
   * `term.paste`, which wraps it in the bracketed-paste markers the CLI turns
   * on. Written straight into the pty instead, a multi-line paste arrives as a
   * run of Enter presses, and Claude Code sends the first line as a finished
   * prompt.
   */
  | { readonly kind: 'paste', readonly text: string }
  /**
   * The whole strip, and it is the whole of it every time.
   *
   * A list rather than a delta, for the reason every list in this build is one
   * (M2.5): a page that applied differences would drift the moment one message
   * was lost, and a strip that has drifted is a person clicking the tab of an
   * agent that is not there. It is also AUTHORITATIVE -- a screen the host no
   * longer lists is a screen the page disposes of, which is what keeps a closed
   * terminal's xterm from living on in a page nobody rebuilt.
   *
   * Which tab is `active` travels inside the list rather than beside it, so the
   * page cannot be told to show a terminal that has no tab.
   */
  | { readonly kind: 'tabs', readonly tabs: readonly TabOrder[] }
  /**
   * The details half, whole, every time -- a picture and not a delta, for the
   * same reason the strip is one: a half that applied differences would drift
   * the moment a message was lost, and a drifted half is a person reading last
   * week's task about today's agent.
   */
  | { readonly kind: 'details', readonly view: DetailsOrder }
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
  | { readonly kind: 'linger', readonly ms: number }
  /**
   * Presses a chord the way a person does, as far as a page can.
   *
   * The seam for the whole of M3.8, and the reason it exists: a suite has no
   * keyboard, and "the key reaches the agent" is the acceptance line. The event
   * is dispatched on the page's own document, which is where a real one lands
   * too -- so what runs afterwards is the editor's forwarding, our keybinding,
   * our context key and our command, rather than a copy of any of them. What it
   * does NOT prove is the hardware and the operating system's own layer; that is
   * the owner's eyes in M3.14.
   */
  | { readonly kind: 'press', readonly chord: string }
  /** Puts the keyboard into one half of the page or the other. */
  | { readonly kind: 'focus', readonly where: 'terminal' | 'details' }
  /** The right button, over the terminal: copy when there is a selection, paste when there is not. */
  | { readonly kind: 'right-click' }
  /** Selects everything on the screen, or nothing -- the two states the right button tells apart. */
  | { readonly kind: 'select', readonly all: boolean }
  /**
   * Clicks a tab, and clicks the cross on one.
   *
   * The seam of M3.9, and the same rule as every probe above it: the click is
   * dispatched on the element a person's mouse would hit, so what runs
   * afterwards is our handler, our message, our command -- not a second
   * implementation of any of them. What it does not stand in for is the mouse
   * and the operating system's own layer (M3.14).
   */
  | { readonly kind: 'click-tab', readonly terminalId: string }
  | { readonly kind: 'click-close', readonly terminalId: string }
  /**
   * Drags one tab onto another, the way a person's hand does.
   *
   * The seam for the drag of 2026-08-21, and the same rule as every probe above
   * it: the events are dispatched on the elements a mouse would hit, so what
   * runs afterwards is the page's own drag handler, its rule and its message --
   * not a second implementation of any of them. `afterMidpoint` is which half of
   * the target tab the pointer was over, which is what decides before or after.
   */
  | {
    readonly kind: 'drag-tab';
    readonly terminalId: string;
    readonly over: string;
    readonly afterMidpoint: boolean;
  };

/**
 * The chord table, from the one file that holds it.
 *
 * Re-exported here because this file IS the package: `@gripterm/webview` points
 * at it, and the extension needs the same list the page refuses to handle. A
 * second copy on the host's side is precisely the drift this table exists to
 * prevent.
 */
export { TERMINAL_CHORDS, chordById, chordFor, isCopyPress, isPastePress } from './keys';
export type { KeyPress, TerminalChord } from './keys';

/**
 * The two translations a tab needs, from the one file that holds them.
 *
 * Re-exported for the same reason the chord table is: this file IS the package.
 * Nothing on the host's side draws a tab, but the suite that checks what the
 * page drew has to be able to say what it should have drawn -- and a second
 * copy of the rule in the suite would agree with the page about anything.
 */
export { codiconClasses, themeColorVariable } from './tab-look';

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

/**
 * A list of things, each of which has to be one.
 *
 * Every element is parsed, and one bad element refuses the whole list. A report
 * with three good tabs and one hole is not a report about a strip: the page
 * either drew what it was told to or it did not, and a suite reading the good
 * three would be asserting about a strip that never existed.
 */
function each<T>(value: unknown, parse: (item: unknown) => T | null): readonly T[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const parsed: T[] = [];
  for (const item of value as readonly unknown[]) {
    const one = parse(item);
    if (one === null) {
      return null;
    }
    parsed.push(one);
  }
  return parsed;
}

function parseTabReport(value: unknown): TabReport | null {
  const source = fields(value);
  if (source === null) {
    return null;
  }
  const terminalId = text(source, 'terminalId');
  const label = text(source, 'label');
  const active = flag(source, 'active');
  const attention = flag(source, 'attention');
  const over = flag(source, 'over');
  const glyph = text(source, 'glyph');
  const colour = text(source, 'colour');
  if (
    terminalId === null ||
    label === null ||
    active === null ||
    attention === null ||
    over === null ||
    glyph === null ||
    colour === null
  ) {
    return null;
  }
  return { terminalId, label, active, attention, over, glyph, colour };
}

function parseTabOrder(value: unknown): TabOrder | null {
  const source = fields(value);
  if (source === null) {
    return null;
  }
  const terminalId = text(source, 'terminalId');
  const label = text(source, 'label');
  const iconId = text(source, 'iconId');
  const colorId = textOrNothing(source, 'colorId');
  const active = flag(source, 'active');
  const attention = flag(source, 'attention');
  const over = flag(source, 'over');
  if (
    terminalId === null ||
    label === null ||
    iconId === null ||
    colorId === null ||
    active === null ||
    attention === null ||
    over === null
  ) {
    return null;
  }
  return { terminalId, label, iconId, colorId: colorId.value, active, attention, over };
}

/**
 * The order for the details half, parsed rather than cast like everything else
 * that crosses this channel.
 *
 * One bad item refuses the whole order, for the reason `each` gives: a half
 * drawn from three good facts and a hole is not the record it claims to be.
 */
function parseDetailsOrder(value: unknown): DetailsOrder | null {
  const source = fields(value);
  if (source === null) {
    return null;
  }
  const nothing = textOrNothing(source, 'nothing');
  const headline = parseDetailsHead(source.headline);
  const facts = each(source.facts, parseDetailsFact);
  const startedAtMs = countOrNothing(source, 'startedAtMs');
  const lastEventAtMs = countOrNothing(source, 'lastEventAtMs');
  const task = textOrNothing(source, 'task');
  const notes = each(source.notes, parseDetailsNote);
  const events = each(source.events, parseDetailsEvent);
  const notices = each(source.notices, asText);
  if (
    nothing === null ||
    headline === null ||
    facts === null ||
    startedAtMs === null ||
    lastEventAtMs === null ||
    task === null ||
    notes === null ||
    events === null ||
    notices === null
  ) {
    return null;
  }
  return {
    nothing: nothing.value,
    headline: headline.value,
    facts,
    startedAtMs: startedAtMs.value,
    lastEventAtMs: lastEventAtMs.value,
    task: task.value,
    notes,
    events,
    notices,
  };
}

/** Wrapped like `textOrNothing`, and for the same reason: absent is not `null`. */
function parseDetailsHead(value: unknown): { readonly value: DetailsHeadOrder | null } | null {
  if (value === null) {
    return { value: null };
  }
  const source = fields(value);
  if (source === null) {
    return null;
  }
  const terminalId = text(source, 'terminalId');
  const label = text(source, 'label');
  const words = text(source, 'words');
  const iconId = text(source, 'iconId');
  const colorId = textOrNothing(source, 'colorId');
  const over = flag(source, 'over');
  if (
    terminalId === null ||
    label === null ||
    words === null ||
    iconId === null ||
    colorId === null ||
    over === null
  ) {
    return null;
  }
  return { value: { terminalId, label, words, iconId, colorId: colorId.value, over } };
}

function parseDetailsFact(value: unknown): DetailsFactOrder | null {
  const source = fields(value);
  if (source === null) {
    return null;
  }
  const name = text(source, 'name');
  const factValue = text(source, 'value');
  return name === null || factValue === null ? null : { name, value: factValue };
}

function parseDetailsNote(value: unknown): DetailsNoteOrder | null {
  const source = fields(value);
  if (source === null) {
    return null;
  }
  const atMs = count(source, 'atMs');
  const noteText = text(source, 'text');
  return atMs === null || noteText === null ? null : { atMs, text: noteText };
}

function parseDetailsEvent(value: unknown): DetailsEventOrder | null {
  const source = fields(value);
  if (source === null) {
    return null;
  }
  const atMs = count(source, 'atMs');
  const words = text(source, 'words');
  return atMs === null || words === null ? null : { atMs, words };
}

function parseDetailsReport(value: unknown): DetailsReport | null {
  const source = fields(value);
  if (source === null) {
    return null;
  }
  const terminalId = textOrNothing(source, 'terminalId');
  const nothing = textOrNothing(source, 'nothing');
  const headline = text(source, 'headline');
  const glyph = text(source, 'glyph');
  const facts = each(source.facts, asText);
  const task = textOrNothing(source, 'task');
  const notes = count(source, 'notes');
  const events = each(source.events, asText);
  const notices = each(source.notices, asText);
  const draws = count(source, 'draws');
  if (
    terminalId === null ||
    nothing === null ||
    headline === null ||
    glyph === null ||
    facts === null ||
    task === null ||
    notes === null ||
    events === null ||
    notices === null ||
    draws === null
  ) {
    return null;
  }
  return {
    terminalId: terminalId.value,
    nothing: nothing.value,
    headline,
    glyph,
    facts,
    task: task.value,
    notes,
    events,
    notices,
    draws,
  };
}

/** A plain string in a list. `each` wants a parser, and a string is its own. */
function asText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** `count`, for a number that may legitimately be nothing. See `textOrNothing`. */
function countOrNothing(source: Fields, key: string): { readonly value: number | null } | null {
  const found = source[key];
  if (found === null) {
    return { value: null };
  }
  return typeof found === 'number' && Number.isFinite(found) ? { value: found } : null;
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
  const bracketedPaste = flag(source, 'bracketedPaste');
  const focusedHere = flag(source, 'focusedHere');
  const documentFocused = flag(source, 'documentFocused');
  const tabs = each(source.tabs, parseTabReport);
  const details = parseDetailsReport(source.details);
  if (
    tabs === null ||
    details === null ||
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
    acking === null ||
    bracketedPaste === null ||
    focusedHere === null ||
    documentFocused === null
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
    bracketedPaste,
    focusedHere,
    documentFocused,
    tabs,
    details,
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
    case 'focused': {
      const focused = flag(source, 'focused');
      return focused === null ? null : { kind: 'focused', focused };
    }
    case 'copy': {
      const copied = text(source, 'text');
      return copied === null ? null : { kind: 'copy', text: copied };
    }
    case 'wants-paste':
      return { kind: 'wants-paste' };
    case 'chose': {
      const terminalId = text(source, 'terminalId');
      return terminalId === null ? null : { kind: 'chose', terminalId };
    }
    case 'wants-close': {
      const terminalId = text(source, 'terminalId');
      return terminalId === null ? null : { kind: 'wants-close', terminalId };
    }
    case 'reorder': {
      const terminalId = text(source, 'terminalId');
      const toIndex = count(source, 'toIndex');
      // A whole number, at least zero. Anything else is a page that has lost
      // count rather than a hand that slipped, and acting on it would move a
      // person's tabs to a place neither of us chose.
      return terminalId === null || toIndex === null || !Number.isInteger(toIndex) || toIndex < 0
        ? null
        : { kind: 'reorder', terminalId, toIndex };
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
    case 'paste': {
      const pasted = text(source, 'text');
      return pasted === null ? null : { kind: 'paste', text: pasted };
    }
    case 'tabs': {
      const tabs = each(source.tabs, parseTabOrder);
      return tabs === null ? null : { kind: 'tabs', tabs };
    }
    case 'details': {
      const view = parseDetailsOrder(source.view);
      return view === null ? null : { kind: 'details', view };
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
    case 'press': {
      const chord = text(source, 'chord');
      return chord === null ? null : { kind: 'press', chord };
    }
    case 'focus': {
      const where = text(source, 'where');
      return where === 'terminal' || where === 'details' ? { kind: 'focus', where } : null;
    }
    case 'right-click':
      return { kind: 'right-click' };
    case 'select': {
      const all = flag(source, 'all');
      return all === null ? null : { kind: 'select', all };
    }
    case 'click-tab': {
      const terminalId = text(source, 'terminalId');
      return terminalId === null ? null : { kind: 'click-tab', terminalId };
    }
    case 'click-close': {
      const terminalId = text(source, 'terminalId');
      return terminalId === null ? null : { kind: 'click-close', terminalId };
    }
    case 'drag-tab': {
      const terminalId = text(source, 'terminalId');
      const over = text(source, 'over');
      const afterMidpoint = flag(source, 'afterMidpoint');
      return terminalId === null || over === null || afterMidpoint === null
        ? null
        : { kind: 'drag-tab', terminalId, over, afterMidpoint };
    }
    default:
      return null;
  }
}
