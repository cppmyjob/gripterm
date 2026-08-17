import '@vscode/codicons/dist/codicon.css';
import '@xterm/xterm/css/xterm.css';
import './page.css';
import { PageLayout } from './layout';
import { Screen } from './screen';
import { parseHostMessage } from '../protocol';
import type { ProbeAction, ViewMessage, ViewReport } from '../protocol';

/**
 * The page Gripterm draws in its panel.
 *
 * It does four things and says what it did: it lays out the two halves, it puts
 * a terminal screen in the left one, it carries that terminal's bytes in both
 * directions, and it REPORTS -- its own box, its own font, its own policy
 * violations, and since M3.7 how much it has written and whether it is
 * acknowledging what it is sent. The reporting is not instrumentation added for
 * a suite; it is how anything here can be checked at all. "The agent's output
 * arrived" is otherwise a claim somebody makes by looking at a screen, and this
 * repository does not accept those (§I.1).
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
 * is a real cost avoided rather than a cycle saved.
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
  /** The terminal this screen is showing, or `null` when it is showing nothing. */
  let attached: string | null = null;
  /** Whether receipts are being sent. Turned off only by the probe -- see `receipts`. */
  let acking = true;
  /** Code units written while receipts were off, owed to the host the moment they resume. */
  let owed = 0;

  // Assigned once the screen exists. The layout is built first because the
  // screen needs a box to live in, and the layout has to be able to report a
  // change from the moment it starts observing one -- so the indirection is
  // written down rather than left as an initialisation order to remember.
  let whenLayoutChanged: (because: string) => void = () => { /* nothing to report before there is a screen */ };

  const layout = new PageLayout(root, {
    onChanged: (because) => { whenLayoutChanged(because); },
  });
  const screen = new Screen(layout.terminalHost, { scrollback, fontFamily, fontSize });

  const report = (): ViewReport => ({
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
    attached,
    written: screen.written,
    acking,
  });

  /** Says what this screen has taken, unless the probe has asked it to go silent. */
  const acknowledge = (terminalId: string, chars: number): void => {
    if (!acking) {
      owed += chars;
      return;
    }
    post({ kind: 'ack', terminalId, chars });
  };

  /**
   * Turns receipts off and on, and settles the debt when they come back.
   *
   * The debt matters: without it, output written while the page was silent would
   * never be acknowledged, the host's counter would stay above the pause line
   * and the terminal would stay paused for good -- the probe would have made an
   * irreversible change to a running agent (§I.3).
   */
  const receipts = (sending: boolean): void => {
    acking = sending;
    if (!sending || attached === null) {
      return;
    }
    const settled = owed;
    owed = 0;
    if (settled > 0) {
      post({ kind: 'ack', terminalId: attached, chars: settled });
    }
  };

  screen.onInput((data) => {
    if (attached === null) {
      // Nothing to type into. Dropped rather than reported: a person leaning on
      // a key with no agent on the screen would otherwise fill the log.
      return;
    }
    post({ kind: 'input', terminalId: attached, data });
  });

  screen.onResized((cols, rows) => {
    if (attached === null) {
      return;
    }
    post({ kind: 'resized', terminalId: attached, cols, rows });
  });

  whenLayoutChanged = (because): void => {
    if (settling !== null) {
      window.clearTimeout(settling);
    }
    settling = window.setTimeout(() => {
      settling = null;
      screen.fit();
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
        screen.type(action.text);
        return;
      case 'receipts':
        receipts(action.sending);
        return;
      default:
        screen.linger(action.ms);
        return;
    }
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
        screen.restyle(fontFamily, fontSize);
        layout.apply();
        screen.fit();
        post({ kind: 'measured', report: report(), because: 'the editor changed how we look' });
        return;
      case 'measure':
        post({ kind: 'measured', report: report(), because: message.because });
        return;
      case 'attach':
        // Emptied first, and with `reset` rather than `clear`: whatever the
        // previous agent left switched on -- bracketed paste, the alternate
        // buffer, a scroll region -- would otherwise be applied to this one's
        // output.
        screen.reset();
        attached = message.terminalId;
        owed = 0;
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
        post({ kind: 'measured', report: report(), because: 'a terminal was attached' });
        return;
      case 'output':
        if (message.terminalId !== attached) {
          // Said out loud rather than written: output landing on the wrong
          // screen is how two agents get mixed into one transcript, and it is
          // invisible from the outside.
          post({
            kind: 'refused',
            what: `output arrived for ${message.terminalId} while the screen is showing ${attached ?? 'nothing'}`,
          });
          return;
        }
        screen.write(message.data, () => { acknowledge(message.terminalId, message.data.length); });
        return;
      case 'detach':
        if (message.terminalId !== attached) {
          return;
        }
        attached = null;
        // NOT cleared: what the agent printed on its way out is the whole of
        // what a person has to read afterwards. The screen keeps it and says
        // underneath that it is over.
        screen.write(`\r\n${DIM}— ${message.because} —${PLAIN}\r\n`);
        post({ kind: 'measured', report: report(), because: 'a terminal was detached' });
        return;
      default:
        probed(message.action);
        return;
    }
  });

  layout.apply();
  screen.fit();
  screen.write(NOTHING_HERE);

  void codiconIsThere().then((loaded) => {
    codiconLoaded = loaded;
    // The first report goes out only once the font question is answered: a
    // `ready` that said "no" because it was asked too early would be a false
    // measurement, and a false measurement is worse than a late one.
    //
    // It is also the handshake: the host answers `ready` by attaching whichever
    // terminal this window is showing, with the tail it is redrawn from. A page
    // that was thrown away and rebuilt knows nothing else about the agent it
    // belongs to.
    post({ kind: 'ready', report: report() });
  });
}

const pageRoot = document.getElementById('gripterm-root');
if (pageRoot === null) {
  post({ kind: 'refused', what: 'the page has no root element to draw in' });
} else {
  start(pageRoot);
}
