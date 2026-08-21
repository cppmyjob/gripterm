import '@vscode/codicons/dist/codicon.css';
import '@xterm/xterm/css/xterm.css';
import './page.css';
import { PageDetails } from './details';
import { PageLayout } from './layout';
import { PageStrip } from './strip';
import { Screens } from './screens';
import { chordById, chordFor, isCopyPress, isPastePress } from '../keys';
import { parseHostMessage } from '../protocol';
import type { ProbeAction, TabOrder, ViewMessage, ViewReport } from '../protocol';
import type { Screen } from './screen';

/**
 * The page Gripterm draws in its panel.
 *
 * It does five things and says what it did: it lays out the two halves, it keeps
 * a screen for every terminal the panel holds, it draws the strip that switches
 * between them, it carries those terminals' bytes in both directions, and it
 * REPORTS -- its own box, its own font, its own policy violations, how much it
 * has written, whether it is acknowledging what it is sent, and since M3.9 what
 * the strip really looks like. The reporting is not instrumentation added for a
 * suite; it is how anything here can be checked at all. "The agent's output
 * arrived" and "the tab shows its state" are otherwise claims somebody makes by
 * looking at a screen, and this repository does not accept those (§I.1).
 */

interface VsCodeApi {
  postMessage: (message: unknown) => void;
  getState: () => unknown;
  setState: (state: unknown) => void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/**
 * How long the page waits after a change before it re-fits and reports.
 *
 * This IS the trailing debounce on resize that M3.7 asks for by number, and it
 * is one timer rather than two: a drag fires a stream of pointer moves and a
 * panel resize fires a stream of observations, and every one of them would
 * otherwise be a fit, a repaint, a message and -- through xterm's own
 * `onResize` -- a native call on a pty. It matters more than a repaint budget:
 * a resize under a live stream was measured LOSING output inside xterm (35
 * lines of 20 000, deterministically, M3.2 stage B §8), so each resize skipped
 * is a real cost avoided rather than a cycle saved. Since M3.9 one fit is N
 * fits, one per screen, which makes the debounce worth more rather than less.
 */
const SETTLE_MS = 80;

/*
 * What the page draws with when the shell says nothing.
 *
 * The shell always says something -- the extension writes both values into it --
 * so these stand for one case only: a page loaded by something that is not this
 * extension. They are deliberately the same numbers the extension would send.
 */
const DEFAULT_SCROLLBACK = 1000;
const DEFAULT_FONT_SIZE = 14;

/*
 * Written as escapes rather than as the bytes themselves: a control character
 * pasted into a source file is invisible in every diff it appears in.
 */
const BOLD = '\u001b[1m';
const DIM = '\u001b[2m';
const PLAIN = '\u001b[0m';

const NOTHING_HERE = [
  `${BOLD}Gripterm${PLAIN}\r\n`,
  `No agent on this screen yet. Run ${BOLD}Gripterm: New Terminal${PLAIN} to start one.\r\n`,
].join('');

const host = acquireVsCodeApi();

function post(message: ViewMessage): void {
  host.postMessage(message);
}

/*
 * Registered before anything else runs, because a failure during start-up is
 * exactly the one worth hearing: a script that never got going cannot report on
 * itself, and what a person would see is an empty panel with nothing anywhere
 * saying why.
 */
window.addEventListener('error', (event) => {
  post({ kind: 'refused', what: `the page threw: ${event.message} (${event.filename}:${String(event.lineno)})` });
});

window.addEventListener('unhandledrejection', (event) => {
  post({ kind: 'refused', what: `the page dropped a promise: ${String(event.reason)}` });
});

document.addEventListener('securitypolicyviolation', (event) => {
  post({
    kind: 'csp-violation',
    directive: event.effectiveDirective === '' ? event.violatedDirective : event.effectiveDirective,
    blockedUri: event.blockedURI,
  });
});

/**
 * Which build of the page this is.
 *
 * Kept in the webview's own persisted state, which survives the page being
 * thrown away and rebuilt but not the view being registered anew. That makes it
 * the one number able to tell "the panel was hidden and came back" from "the
 * page was rebuilt" -- the difference `retainContextWhenHidden` is about.
 */
function nextGeneration(): number {
  const state = host.getState();
  const before = typeof state === 'object' && state !== null ? (state as { generation?: unknown }).generation : null;
  const generation = (typeof before === 'number' && Number.isFinite(before) ? before : 0) + 1;
  host.setState({ generation });
  return generation;
}

/** A number the extension wrote into the shell, or the one we would rather have. */
function attribute(root: HTMLElement, name: string, fallback: number): number {
  const found = Number(root.dataset[name]);
  return Number.isFinite(found) && found > 0 ? found : fallback;
}

/**
 * Reaches for something the policy forbids, on purpose.
 *
 * An image from another origin: `img-src` names our own origin and `data:` and
 * nothing else, so the document blocks the load and fires
 * `securitypolicyviolation`. Nothing leaves this machine -- the policy stops the
 * request before it is made -- and what the suite learns is worth the fifteen
 * lines: that the policy is enforced, and that we hear about it when it bites.
 * Without this, an empty list of violations would also be what a page with no
 * listener at all reports.
 */
function breakThePolicy(): void {
  const image = document.createElement('img');
  image.src = 'https://example.invalid/gripterm-probe.png';
  image.style.display = 'none';
  document.body.append(image);
}

/** Whether the codicon font is really usable, rather than merely referenced. */
async function codiconIsThere(): Promise<boolean> {
  try {
    await document.fonts.load('16px codicon');
    return document.fonts.check('16px codicon');
  } catch {
    return false;
  }
}

/** The legacy code of the one key `Insert`, which is not a letter. */
const INSERT_KEY_CODE = 45;

/**
 * A key press, built the way the editor expects to read one.
 *
 * `keyCode` is the part that matters and the part `KeyboardEventInit` has no
 * field for: the editor forwards presses out of this document and dispatches its
 * own keybindings from `StandardKeyboardEvent`, which reads the legacy
 * `keyCode`. An event without one is a press the editor sees and cannot name --
 * and the whole road of M3.8 runs through that dispatch.
 */
function keyPress(code: string, held: { readonly ctrlKey?: boolean, readonly shiftKey?: boolean }): KeyboardEvent {
  const letter = code.slice(-1);
  const legacy = code === 'Insert' ? INSERT_KEY_CODE : letter.charCodeAt(0);
  const press = new KeyboardEvent('keydown', {
    key: code === 'Insert' ? 'Insert' : letter.toLowerCase(),
    code,
    ctrlKey: held.ctrlKey ?? false,
    shiftKey: held.shiftKey ?? false,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(press, 'keyCode', { get: () => legacy });
  Object.defineProperty(press, 'which', { get: () => legacy });
  return press;
}

/** What the press probe is allowed to name: the six chords, and the three that are not chords. */
function keyPressFor(id: string): KeyboardEvent | null {
  const chord = chordById(id);
  if (chord !== null) {
    return keyPress(chord.code, { ctrlKey: true });
  }
  if (id === 'ctrl+c') {
    return keyPress('KeyC', { ctrlKey: true });
  }
  if (id === 'shift+insert') {
    return keyPress('Insert', { shiftKey: true });
  }
  if (id === 'ctrl+v') {
    return keyPress('KeyV', { ctrlKey: true });
  }
  return null;
}

/** The line that says a replay begins in the middle of the output rather than at its start. */
function lostLine(droppedChars: number): string {
  return `${DIM}— ${String(droppedChars)} earlier characters are not kept; this screen begins mid-stream —${PLAIN}\r\n`;
}

function start(root: HTMLElement): void {
  const generation = nextGeneration();
  const scrollback = attribute(root, 'scrollback', DEFAULT_SCROLLBACK);
  let fontFamily = root.dataset.fontFamily ?? 'monospace';
  let fontSize = attribute(root, 'fontSize', DEFAULT_FONT_SIZE);
  let codiconLoaded = false;
  let settling: number | null = null;
  /** Whether receipts are being sent. Turned off only by the probe -- see `receipts`. */
  let acking = true;
  /** Whether the keyboard is in a terminal of ours, as this document sees it. */
  let focusedHere = false;
  /**
   * The terminal the host last said was the active one.
   *
   * Kept because the strip can arrive BEFORE the screen it names: the host draws
   * the strip first, so that a screen made afterwards is made at the height the
   * strip has left it and its pty is told one size rather than two. A wish for a
   * terminal with no screen yet is remembered here and granted when it appears.
   */
  let wanted: string | null = null;
  /**
   * Code units written while receipts were off, owed to each terminal.
   *
   * Per terminal since M3.9: every screen takes output at once, and a single
   * counter would settle one terminal's debt against another's flow -- which is
   * an agent released early and an agent left paused.
   */
  const owed = new Map<string, number>();

  // Assigned once the screens exist. The layout is built first because they need
  // a box to live in, and the layout has to be able to report a change from the
  // moment it starts observing one -- so the indirection is written down rather
  // than left as an initialisation order to remember.
  let whenLayoutChanged: (because: string) => void = () => { /* nothing to report before there is a screen */ };

  const layout = new PageLayout(root, {
    onChanged: (because) => { whenLayoutChanged(because); },
  });
  const screens = new Screens(layout.screensHost, { scrollback, fontFamily, fontSize });
  const strip = new PageStrip(layout.stripHost, {
    onChose: (terminalId) => { post({ kind: 'chose', terminalId }); },
    onClose: (terminalId) => { post({ kind: 'wants-close', terminalId }); },
    onRefused: (what) => { post({ kind: 'refused', what }); },
    onReorder: (terminalId, toIndex) => { post({ kind: 'reorder', terminalId, toIndex }); },
  });
  const details = new PageDetails(layout.detailsHost, (what) => { post({ kind: 'refused', what }); });

  const report = (): ViewReport => {
    const screen = screens.visible;
    return {
      generation,
      cols: screen.cols,
      rows: screen.rows,
      terminalWidth: layout.terminalWidth,
      detailsWidth: layout.detailsWidth,
      scrollback: screen.scrollback,
      background: screen.background,
      fontFamily: screen.fontFamily,
      fontSize: screen.fontSize,
      codiconLoaded,
      unicodeVersion: screen.unicodeVersion,
      attached: screens.showing,
      written: screen.written,
      acking,
      bracketedPaste: screen.bracketedPaste,
      focusedHere,
      documentFocused: document.hasFocus(),
      tabs: strip.report(),
      details: details.report(),
    };
  };

  /** Says what a screen has taken, unless the probe has asked it to go silent. */
  const acknowledge = (terminalId: string, chars: number): void => {
    if (!acking) {
      owed.set(terminalId, (owed.get(terminalId) ?? 0) + chars);
      return;
    }
    post({ kind: 'ack', terminalId, chars });
  };

  /**
   * Turns receipts off and on, and settles every debt when they come back.
   *
   * The debt matters: without it, output written while the page was silent would
   * never be acknowledged, the host's counter would stay above the pause line
   * and the terminal would stay paused for good -- the probe would have made an
   * irreversible change to a running agent (§I.3).
   */
  const receipts = (sending: boolean): void => {
    acking = sending;
    if (!sending) {
      return;
    }
    for (const [terminalId, chars] of owed) {
      if (chars > 0) {
        post({ kind: 'ack', terminalId, chars });
      }
    }
    owed.clear();
  };

  /**
   * The presses this page does not let xterm answer, and what it does with them.
   *
   * Three kinds, and each has a reason xterm must keep out:
   *
   *   * a **chord** of `keys.ts` -- the editor is going to hand it back as a
   *     command with the bytes, and two answers would put two of everything into
   *     the agent's prompt;
   *   * **`Ctrl+C` with something selected** -- it copies rather than
   *     interrupts, which is the owner's decision and the editor's own rule for
   *     its terminal. With nothing selected this returns false and xterm sends
   *     the interrupt, which is the whole difference;
   *   * **a paste press** -- `Shift+Insert`, `Ctrl+V` or `Cmd+V` -- for which
   *     this page does nothing beyond keeping xterm out. The editor pastes all
   *     three by itself; a page that asked the host for the clipboard as well
   *     put it in twice, and xterm's `0x16` in front of that paste ate its
   *     front. Both measured by hand on 2026-08-20, both written in `keys.ts`.
   */
  const answeredHere = (screen: Screen, event: KeyboardEvent): boolean => {
    if (chordFor(event) !== null) {
      return true;
    }
    if (event.type !== 'keydown') {
      // The releases of those same keys, which must not post a second time.
      return false;
    }
    if (isCopyPress(event)) {
      const selected = screen.selection();
      if (selected.length === 0) {
        return false;
      }
      post({ kind: 'copy', text: selected });
      screen.select(false);
      return true;
    }
    if (isPastePress(event)) {
      // Nothing at all, and that IS the answer: the editor pastes this press
      // by itself. The one thing that has to happen is that xterm does not send
      // `0x16` in front of that paste, which is what returning true does.
      return true;
    }
    return false;
  };

  /**
   * The right button: copy what is selected, and paste when nothing is.
   *
   * The owner's decision of 2026-08-18, and the editor's own default for its
   * terminal on Windows. Both halves have to go through the host -- a webview
   * can neither read nor write the clipboard by itself.
   */
  const rightClicked = (screen: Screen): void => {
    const selected = screen.selection();
    if (selected.length > 0) {
      post({ kind: 'copy', text: selected });
      // Cleared, as the editor's terminal does: a selection left standing makes
      // the next right button copy again when the person meant to paste.
      screen.select(false);
      return;
    }
    post({ kind: 'wants-paste' });
  };

  /**
   * Everything one screen says, on its way out.
   *
   * Done once per screen, at the moment it is made, and never twice: a screen
   * wired up again would post every keystroke to the pty two times, and the two
   * copies are indistinguishable from the other end.
   *
   * `terminalId` is `null` for the idle screen, which has no pty to talk to. It
   * still refuses the chords and still says where the keyboard is: the half is
   * a terminal as far as a person and the context key are concerned, whether or
   * not an agent is on it.
   */
  const wire = (screen: Screen, terminalId: string | null): void => {
    screen.leaveToTheHost((event) => answeredHere(screen, event));
    screen.onFocusChanged((focused) => {
      focusedHere = focused;
      post({ kind: 'focused', focused });
    });
    screen.onRightClick(() => { rightClicked(screen); });
    if (terminalId === null) {
      return;
    }
    screen.onInput((data) => { post({ kind: 'input', terminalId, data }); });
    screen.onResized((cols, rows) => { post({ kind: 'resized', terminalId, cols, rows }); });
  };

  whenLayoutChanged = (because): void => {
    if (settling !== null) {
      window.clearTimeout(settling);
    }
    settling = window.setTimeout(() => {
      settling = null;
      // EVERY screen, not the one in front. A hidden screen fitted only when it
      // is shown would be resized in front of the person switching to it, and
      // the agent would redraw its whole TUI at that moment.
      screens.fit();
      post({ kind: 'measured', report: report(), because });
    }, SETTLE_MS);
  };

  const probed = (action: ProbeAction): void => {
    switch (action.kind) {
      case 'drag-splitter':
        layout.dragBy(action.byPx);
        return;
      case 'break-policy':
        breakThePolicy();
        return;
      case 'type':
        screens.visible.type(action.text);
        return;
      case 'receipts':
        receipts(action.sending);
        return;
      case 'linger':
        screens.linger(action.ms);
        return;
      case 'press': {
        const press = keyPressFor(action.chord);
        if (press === null) {
          post({ kind: 'refused', what: `a press this page does not know: ${action.chord}` });
          return;
        }
        screens.visible.dispatchKey(press);
        return;
      }
      case 'focus':
        if (action.where === 'terminal') {
          screens.visible.focus();
          return;
        }
        layout.focusDetails();
        return;
      case 'right-click':
        rightClicked(screens.visible);
        return;
      case 'select':
        screens.visible.select(action.all);
        return;
      case 'click-tab':
      case 'click-close': {
        if (!strip.click(action.terminalId, action.kind === 'click-close')) {
          post({ kind: 'refused', what: `a click on a tab this strip does not have: ${action.terminalId}` });
        }
        return;
      }
      case 'drag-tab': {
        if (!strip.dragTab(action.terminalId, action.over, action.afterMidpoint)) {
          post({ kind: 'refused', what: `a drag between tabs this strip does not have: ${action.terminalId} onto ${action.over}` });
        }
        return;
      }
      default:
        post({ kind: 'refused', what: 'a probe this page does not know' });
        return;
    }
  };

  /**
   * Draws the strip, throws away the screens it no longer names, and shows the
   * one it says is active.
   *
   * The message is the whole truth about which terminals the panel holds, so
   * this is where a closed terminal's screen really goes: a page kept alive
   * behind a hidden panel never reloads, and a screen nothing disposes of holds
   * its scrollback for as long as the window is open.
   */
  const drawStrip = (tabs: readonly TabOrder[]): void => {
    const named = new Set(tabs.map((tab) => tab.terminalId));
    for (const terminalId of screens.ids) {
      if (!named.has(terminalId)) {
        screens.close(terminalId);
      }
    }
    wanted = tabs.find((tab) => tab.active)?.terminalId ?? null;
    screens.show(wanted);
    // The strip takes its height out of the terminal's, and it appears with the
    // first tab and goes with the last: every screen has to be told about it, or
    // the one in front would draw a row into the space the tabs are in.
    screens.fit();
  };

  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    const message = parseHostMessage(event.data);
    if (message === null) {
      // Neither thrown nor ignored: a message the page cannot read is either a
      // page from an older build or a defect in the host, and both are worth a
      // line in the log rather than silence.
      post({ kind: 'refused', what: `a message the page cannot read: ${JSON.stringify(event.data)}` });
      return;
    }
    switch (message.kind) {
      case 'restyle':
        fontFamily = message.fontFamily;
        fontSize = message.fontSize;
        screens.restyle(fontFamily, fontSize);
        layout.apply();
        screens.fit();
        post({ kind: 'measured', report: report(), because: 'the editor changed how we look' });
        return;
      case 'measure':
        post({ kind: 'measured', report: report(), because: message.because });
        return;
      case 'attach': {
        const { screen, fresh } = screens.open(message.terminalId);
        if (fresh) {
          wire(screen, message.terminalId);
          // Before anything is written on it: a screen that has never been
          // fitted is 80x24 whatever the panel is, and the first thing it would
          // tell its pty is a size nobody has.
          screen.fit();
        }
        // Emptied first, and with `reset` rather than `clear`: whatever this
        // terminal left switched on before -- bracketed paste, the alternate
        // buffer, a scroll region -- would otherwise be applied to the replay.
        screen.reset();
        owed.delete(message.terminalId);
        if (message.droppedChars > 0) {
          screen.write(lostLine(message.droppedChars));
        }
        screen.write(message.replay);
        // The size, unprompted. xterm only raises `onResize` when the number
        // changes, so a terminal attaching to a screen that is already the right
        // size would never tell its pty how wide it is -- and the pty would stay
        // at the 80x30 it was spawned with, which is the one thing a TUI reads
        // before it draws anything.
        post({ kind: 'resized', terminalId: message.terminalId, cols: screen.cols, rows: screen.rows });
        if (message.terminalId === wanted) {
          // The strip named this terminal as the one to show before it had a
          // screen to show. Now it has one.
          screens.show(wanted);
        }
        post({ kind: 'measured', report: report(), because: 'a terminal was attached' });
        return;
      }
      case 'output': {
        const screen = screens.get(message.terminalId);
        if (screen === undefined) {
          // Said out loud rather than written somewhere: output that reached no
          // screen is output a person will never see, and it is invisible from
          // the outside.
          post({
            kind: 'refused',
            what: `output arrived for ${message.terminalId}, which has no screen here`,
          });
          return;
        }
        screen.write(message.data, () => { acknowledge(message.terminalId, message.data.length); });
        return;
      }
      case 'paste':
        // Through xterm rather than into the pty: it is what puts the brackets
        // around the text, and a multi-line paste without them is a run of
        // Enter presses with the first line leaving as a finished prompt.
        screens.visible.paste(message.text);
        return;
      case 'detach': {
        const screen = screens.get(message.terminalId);
        if (screen === undefined) {
          return;
        }
        // NOT cleared and NOT thrown away: what the agent printed on its way out
        // is the whole of what a person has to read afterwards, and the tab waits
        // for them to close it (the owner's decision of 2026-08-18). The screen
        // keeps it and says underneath that it is over.
        screen.write(`\r\n${DIM}— ${message.because} —${PLAIN}\r\n`);
        post({ kind: 'measured', report: report(), because: 'a terminal was detached' });
        return;
      }
      case 'tabs':
        strip.draw(message.tabs);
        drawStrip(message.tabs);
        post({ kind: 'measured', report: report(), because: 'the strip was drawn' });
        return;
      case 'details':
        // Drawn, and NOT announced. `dragSplitterBy` and `nextMeasurement` wait
        // for the next measurement whatever its reason, so a report posted here
        // would be handed to a suite waiting for the border to move -- taken
        // after the layout changed and before xterm had refitted, which is a
        // measurement of a moment that never existed (2026-08-18).
        details.draw(message.view);
        return;
      default:
        probed(message.action);
        return;
    }
  });

  layout.apply();
  wire(screens.idle, null);
  screens.fit();
  screens.idle.write(NOTHING_HERE);

  void codiconIsThere().then((loaded) => {
    codiconLoaded = loaded;
    // The first report goes out only once the font question is answered: a
    // `ready` that said "no" because it was asked too early would be a false
    // measurement, and a false measurement is worse than a late one.
    //
    // It is also the handshake: the host answers `ready` by attaching whichever
    // terminals this window is holding, with the tails they are redrawn from. A
    // page that was thrown away and rebuilt knows nothing else about them.
    post({ kind: 'ready', report: report() });
  });
}

const pageRoot = document.getElementById('gripterm-root');
if (pageRoot === null) {
  post({ kind: 'refused', what: 'the page has no root element to draw in' });
} else {
  start(pageRoot);
}
