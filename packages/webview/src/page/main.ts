import '@vscode/codicons/dist/codicon.css';
import '@xterm/xterm/css/xterm.css';
import './page.css';
import { PageLayout } from './layout';
import { Screen } from './screen';
import { parseHostMessage } from '../protocol';
import type { ViewMessage, ViewReport } from '../protocol';

/**
 * The page Gripterm draws in its panel.
 *
 * It does three things and says what it did: it lays out the two halves, it
 * puts a terminal screen in the left one, and it REPORTS -- its own box, its own
 * font, its own policy violations. The reporting is not instrumentation added
 * for a suite; it is how anything here can be checked at all. "The page loaded
 * and nothing was blocked" is otherwise a claim somebody makes by looking at a
 * screen, and this repository does not accept those (§I.1).
 *
 * The bytes of a real terminal arrive in M3.7. Until then the screen says so,
 * in the terminal's own colours, rather than pretending to be one.
 */

interface VsCodeApi {
  postMessage: (message: unknown) => void;
  getState: () => unknown;
  setState: (state: unknown) => void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** How long the page waits after a change before reporting where things ended up. */
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

const BANNER = [
  // Written as escapes rather than as the bytes themselves: a control character
  // pasted into a source file is invisible in every diff it appears in.
  '\u001b[1mGripterm\u001b[0m\r\n',
  'This is the screen your agents will run in.\r\n',
  'Nothing is wired to it yet — the terminal arrives with the next step.\r\n',
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

function start(root: HTMLElement): void {
  const generation = nextGeneration();
  const scrollback = attribute(root, 'scrollback', DEFAULT_SCROLLBACK);
  let fontFamily = root.dataset.fontFamily ?? 'monospace';
  let fontSize = attribute(root, 'fontSize', DEFAULT_FONT_SIZE);
  let codiconLoaded = false;
  let settling: number | null = null;

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
  });

  whenLayoutChanged = (because): void => {
    // Coalesced: a drag fires a stream of pointer moves and a panel resize fires
    // a stream of observations, and each one of them would otherwise be a fit, a
    // repaint and a message.
    if (settling !== null) {
      window.clearTimeout(settling);
    }
    settling = window.setTimeout(() => {
      settling = null;
      screen.fit();
      post({ kind: 'measured', report: report(), because });
    }, SETTLE_MS);
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
    if (message.kind === 'restyle') {
      fontFamily = message.fontFamily;
      fontSize = message.fontSize;
      screen.restyle(fontFamily, fontSize);
      layout.apply();
      screen.fit();
      post({ kind: 'measured', report: report(), because: 'the editor changed how we look' });
      return;
    }
    if (message.kind === 'measure') {
      post({ kind: 'measured', report: report(), because: message.because });
      return;
    }
    if (message.action === 'drag-splitter') {
      layout.dragBy(message.byPx);
      return;
    }
    breakThePolicy();
  });

  layout.apply();
  screen.fit();
  screen.write(BANNER);

  void codiconIsThere().then((loaded) => {
    codiconLoaded = loaded;
    // The first report goes out only once the font question is answered: a
    // `ready` that said "no" because it was asked too early would be a false
    // measurement, and a false measurement is worse than a late one.
    post({ kind: 'ready', report: report() });
  });
}

const pageRoot = document.getElementById('gripterm-root');
if (pageRoot === null) {
  post({ kind: 'refused', what: 'the page has no root element to draw in' });
} else {
  start(pageRoot);
}
