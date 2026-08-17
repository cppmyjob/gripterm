import * as vscode from 'vscode';
import { parseViewMessage } from '@gripterm/webview';
import type { HostMessage, ViewMessage, ViewReport } from '@gripterm/webview';
import type { Logger } from '@gripterm/core';
import { affectsTerminalFont, chooseTerminalFont } from './terminal-font';
import type { TerminalFont } from './terminal-font';
import { makeNonce, webviewPageHtml } from './webview-html';

/**
 * The panel tab Gripterm draws in, and the one view inside it.
 *
 * What this class is responsible for is narrow on purpose: it hands the page its
 * shell, it keeps the page's look in step with the editor's, and it LISTENS.
 * The terminal bytes are M3.7's, the tab strip is M3.9's, the details half is
 * M3.11's. Everything they will need goes through the same channel this opens.
 *
 * The listening is the part worth reading. A webview is the one surface in this
 * build where a failure is silent by construction: a script blocked by the
 * content policy, a resource outside the allowed roots, a font that did not
 * load -- none of them throws anywhere the extension can see, and all of them
 * end in a person looking at an empty panel. So the page reports its own
 * violations, and every one of them is a warning in the log with the directive
 * named.
 */

/**
 * The panel tab, and its id has no dot in it for a measured reason.
 *
 * VS Code 1.133 refuses a view container whose id is not alphanumeric with `_`
 * and `-`: `property 'id' is mandatory and must be of type 'string' with
 * non-empty value`. It refuses it in the extension host log and NOWHERE ELSE --
 * the extension activates, the views register, and they quietly land in the
 * Explorer instead of the panel. That is what `gripterm.panel` did on
 * 2026-08-17, and the suite that saw a resolved view and a working page could
 * not tell the difference. `tests/integration/workbench-view.test.ts` now asks
 * the editor whether the container exists at all.
 */
export const PANEL_CONTAINER_ID = 'griptermPanel';
export const WORKBENCH_VIEW_ID = 'gripterm.workbench';

/**
 * Lines of history one terminal keeps in the page.
 *
 * The editor's own default for `terminal.integrated.scrollback`, by the owner's
 * decision of 2026-08-17: the same depth their agents have today under the
 * `editor` engine, so switching engines is not also a change of how far back
 * they can read. Raising it is cheap and reversible; it costs memory per
 * terminal, and with `retainContextWhenHidden` it costs it while hidden too.
 */
const SCROLLBACK_LINES = 1000;

/** How long anything asked of the page is waited for before it is a failure. */
const ANSWER_WITHIN_MS = 20_000;

/** How often the deliberate-violation seam looks for its answer. */
const VIOLATION_POLL_MS = 50;

/** How much of an unreadable message goes into the log before it is cut. */
const EXCERPT_CHARS = 400;

export interface WorkbenchViewOptions {
  readonly extensionUri: vscode.Uri;
  readonly logger: Logger;
}

export interface CspViolation {
  readonly directive: string;
  readonly blockedUri: string;
}

interface Waiter {
  readonly resolve: (report: ViewReport) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  /**
   * The answer this waiter is waiting for, or `null` for whichever comes first.
   *
   * It exists because the page measures ITSELF as well as answering: a terminal
   * attaching, a terminal ending, a panel resizing all produce a `measured` of
   * their own. Without this, a caller that asked a question would be handed the
   * first unrelated answer to arrive -- which is a report taken BEFORE its own
   * question, and every assertion written on it would be about the past. Found
   * exactly that way on 2026-08-17: a suite read `attached: null` from a report
   * the page had sent about the terminal that ended a moment earlier.
   */
  readonly because: string | null;
}

/**
 * What an unreadable message looks like in the log, cut to a readable length.
 *
 * `undefined` is taken out first because `JSON.stringify` is typed as returning
 * a string and returns `undefined` for it -- and `undefined` is a message a page
 * can really send. Nothing else here can be unwritable: what crosses this
 * channel has already survived a structured clone, so no function and no symbol
 * arrives.
 */
function excerpt(raw: unknown): string {
  if (raw === undefined) {
    return 'undefined -- a message with nothing in it';
  }
  return JSON.stringify(raw).slice(0, EXCERPT_CHARS);
}

/**
 * What stands in the panel when the page cannot be built.
 *
 * No script, no resource, nothing that can fail a second time: a policy of
 * `default-src 'none'` and one paragraph of text. It is escaped through the
 * same rule the shell uses, because the sentence it carries contains whatever
 * the failure said.
 */
function sorryPage(what: string): string {
  const said = what
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="UTF-8" />',
    `    <meta http-equiv="Content-Security-Policy" content="default-src 'none';" />`,
    '  </head>',
    '  <body>',
    `    <p>Gripterm: ${said}</p>`,
    '    <p>The log has the details: run <code>Gripterm: Show Logs</code>.</p>',
    '  </body>',
    '</html>',
  ].join('\n');
}

export class WorkbenchView implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly _options: WorkbenchViewOptions;
  private readonly _subscriptions: vscode.Disposable[] = [];
  private readonly _violations: CspViolation[] = [];
  private readonly _refusals: string[] = [];
  private readonly _waitingForReady = new Set<Waiter>();
  private readonly _waitingForMeasurement = new Set<Waiter>();
  /**
   * Whoever else is listening to this page -- the terminal stage, since M3.7.
   *
   * A list rather than one owner: this class is the channel, and what travels
   * through it belongs to whoever the message is about. Keeping the terminals'
   * half here instead would put a `ScreenBuffer` in the object whose one job is
   * to hold a webview.
   */
  private readonly _listeners = new Set<(message: ViewMessage) => void>();
  private readonly _watchers = new Set<(visible: boolean) => void>();
  private _view: vscode.WebviewView | null = null;
  private _resolveCount = 0;
  private _lastReport: ViewReport | null = null;

  constructor(options: WorkbenchViewOptions) {
    this._options = options;
    this._subscriptions.push(
      // The colours live in CSS variables the editor keeps up to date by itself,
      // but xterm took its copy of them when it was built -- so the page has to
      // be told to take them again. Ordinary window paint would not.
      vscode.window.onDidChangeActiveColorTheme(() => { this._restyle(); }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (affectsTerminalFont(event)) {
          this._restyle();
        }
      })
    );
  }

  /** How many times a page has been built for this view. */
  public get resolveCount(): number {
    return this._resolveCount;
  }

  /** The last thing the page said about itself, or `null` before it spoke. */
  public get lastReport(): ViewReport | null {
    return this._lastReport;
  }

  /**
   * Every content policy violation the page has reported, in order.
   *
   * Exposed rather than only logged: "no CSP violations" is an acceptance line
   * of M3.6, and a suite that read it out of a log would be asserting on a
   * string somebody could reword.
   */
  public get violations(): readonly CspViolation[] {
    return this._violations;
  }

  /**
   * Everything the page refused to do, in its own words.
   *
   * Kept beside the violations and for the same reason: a page that threw during
   * start-up is a panel that stays empty, and the only place that fact exists is
   * a message it sent on its way down.
   */
  public get refusals(): readonly string[] {
    return this._refusals;
  }

  /** Whether the page is on screen. A page behind a hidden panel is not. */
  public get visible(): boolean {
    return this._view?.visible ?? false;
  }

  /**
   * Everything the page says, parsed, to whoever else is listening.
   *
   * The `ready` of a rebuilt page travels this way too, and that is the whole
   * rehydration handshake: this class knows a page is up, and the stage knows
   * which terminal it should be showing.
   */
  public onMessage(listener: (message: ViewMessage) => void): vscode.Disposable {
    this._listeners.add(listener);
    return { dispose: (): void => { this._listeners.delete(listener); } };
  }

  /**
   * When the page stops being on screen, and when it comes back.
   *
   * Load-bearing rather than informational: under `retainContextWhenHidden` a
   * hidden page is alive and silent -- Chromium clamps a hidden frame's timers
   * and xterm schedules its writes through `setTimeout` -- so this event is the
   * only thing that can tell a terminal's flow control that its consumer has
   * stopped answering. Without it a paused agent would stay paused for as long
   * as the panel stayed shut.
   */
  public onVisibility(watcher: (visible: boolean) => void): vscode.Disposable {
    this._watchers.add(watcher);
    return { dispose: (): void => { this._watchers.delete(watcher); } };
  }

  /**
   * Brings this view up, taking the person's focus only when asked to.
   *
   * Two roads, because the platform gives two. A view that EXISTS is shown
   * through its own object, where `preserveFocus` is the documented argument. A
   * view that has never been resolved does not exist as an object at all -- a
   * panel opened on somebody else's tab never instantiates ours -- so the only
   * way to make it exist is the command the editor contributes for it.
   *
   * What is NOT promised, and cannot be checked from a test: whether the command
   * honours `preserveFocus`. There is no API that says which widget has the
   * keyboard, so a suite can watch the view appear and nothing more. The cost of
   * being wrong is the focus taken once, at the moment a window restores its
   * terminals into a panel that was closed (§7.2).
   */
  public reveal(preserveFocus: boolean): void {
    const view = this._view;
    if (view !== null) {
      view.show(preserveFocus);
      return;
    }
    void vscode.commands.executeCommand(`${WORKBENCH_VIEW_ID}.focus`, { preserveFocus });
  }

  /** Sends the page an order. Nothing happens when there is no page. */
  public post(message: HostMessage): void {
    this._post(message);
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    this._resolveCount += 1;
    this._view = view;
    const pageRoot = vscode.Uri.joinPath(this._options.extensionUri, 'dist', 'webview');
    view.webview.options = {
      enableScripts: true,
      // One directory, and it is the built page. Everything else the page could
      // want -- the stylesheet, the codicon font -- is built into it, so a
      // wider root would only widen what a defect could reach.
      localResourceRoots: [pageRoot],
    };
    view.webview.html = this._shell(view.webview, pageRoot);
    view.onDidDispose(() => {
      if (this._view === view) {
        this._view = null;
        // Forgotten with it: `whenReady` answers "is there a page up now", and
        // a report kept from a view that has been destroyed would let a launch
        // through the gate that exists to stop an agent running unseen.
        this._lastReport = null;
        // A destroyed view is an invisible one as far as anything downstream is
        // concerned, and saying so is what releases the terminals it was
        // showing. A page that is gone acknowledges nothing ever again.
        this._sawVisibility(false);
      }
    });
    view.onDidChangeVisibility(() => { this._sawVisibility(view.visible); });
    view.webview.onDidReceiveMessage((raw: unknown) => { this._heard(raw); });
  }

  /** Resolves when the page says it is up, with what it says about itself. */
  public async whenReady(timeoutMs: number = ANSWER_WITHIN_MS): Promise<ViewReport> {
    if (this._lastReport !== null) {
      return this._lastReport;
    }
    return await this._wait(this._waitingForReady, timeoutMs, 'the page never said it was ready');
  }

  /** Asks the page where everything is, and waits for the answer. */
  public async measure(because: string, timeoutMs: number = ANSWER_WITHIN_MS): Promise<ViewReport> {
    // Waiting for THIS answer by name. The page measures itself as well as
    // answering -- an attach, an end, a resize each produce one -- and a waiter
    // that took the first report to arrive would be handed one taken before its
    // own question.
    const answer = this._wait(
      this._waitingForMeasurement,
      timeoutMs,
      `the page did not answer: ${because}`,
      because
    );
    this._post({ kind: 'measure', because });
    return await answer;
  }

  /** Waits for the next measurement the page makes of its own accord. */
  public async nextMeasurement(timeoutMs: number = ANSWER_WITHIN_MS): Promise<ViewReport> {
    return await this._wait(this._waitingForMeasurement, timeoutMs, 'the page measured nothing');
  }

  /**
   * Drags the border between the halves, by the page's own pointer events.
   *
   * The seam named in the protocol: a suite has no pointer, and "the border
   * moves" is an acceptance line. What runs is the handler a person's mouse
   * reaches -- see `PageLayout.dragBy`.
   */
  public async dragSplitterBy(byPx: number, timeoutMs: number = ANSWER_WITHIN_MS): Promise<ViewReport> {
    const answer = this._wait(this._waitingForMeasurement, timeoutMs, 'the border did not move');
    this._post({ kind: 'probe', action: { kind: 'drag-splitter', byPx } });
    return await answer;
  }

  /**
   * Types into the terminal exactly as a person's keyboard does.
   *
   * The seam for "input is not lost under a flood", which is an acceptance line
   * of M3.7 and one a suite has no hands for. The page answers by calling
   * xterm's own `input`, so what runs is the path a key press takes -- not a
   * second implementation of it.
   */
  public type(text: string): void {
    this._post({ kind: 'probe', action: { kind: 'type', text } });
  }

  /**
   * Makes the page stop -- or start -- acknowledging what it is sent.
   *
   * The seam that keeps back-pressure from being unfalsifiable. A healthy
   * consumer never needs a pause, so a build with no `pause()` at all passes
   * every test a healthy consumer takes; this is how the suite makes the
   * consumer unhealthy on purpose. Reversible by construction: the page keeps
   * count while it is silent and settles the debt the moment it is switched back
   * on, so the probe cannot leave an agent paused for good.
   */
  public receipts(sending: boolean): void {
    this._post({ kind: 'probe', action: { kind: 'receipts', sending } });
  }

  /**
   * Makes the page slow to take a message in, and `0` makes it quick again.
   *
   * The other half of the same problem `receipts` solves. A receipt in this
   * build means "the screen has parsed this", and the difference between that
   * and "the message reached the page" is what back-pressure is counted in --
   * but on this machine xterm parses a plain flood FASTER than the pty produces
   * it, so the two receipts report identical numbers and neither the suite nor
   * a mutation can tell them apart (M19 of the M3.7 battery, 2026-08-18). Under
   * this probe the screen falls behind on purpose, and a receipt sent on
   * arrival becomes a claim the page can be caught in.
   */
  public linger(ms: number): void {
    this._post({ kind: 'probe', action: { kind: 'linger', ms } });
  }

  /**
   * Asks the page to reach for something the policy forbids, and waits to hear
   * that it was stopped.
   *
   * The seam that keeps an empty list of violations from being a vacuum: with
   * no way to provoke one, `violations: []` is what a page reports whether the
   * policy is enforced or whether nobody is listening. Nothing leaves the
   * machine -- the document blocks the request before it is made.
   */
  public async breakPolicy(timeoutMs: number = ANSWER_WITHIN_MS): Promise<CspViolation> {
    const seen = this._violations.length;
    const answer = new Promise<CspViolation>((resolve, reject) => {
      const started = Date.now();
      const look = (): void => {
        const found = this._violations[seen];
        if (found !== undefined) {
          resolve(found);
          return;
        }
        if (Date.now() - started > timeoutMs) {
          reject(new Error('the page was refused nothing, so nothing was reported'));
          return;
        }
        setTimeout(look, VIOLATION_POLL_MS);
      };
      look();
    });
    this._post({ kind: 'probe', action: { kind: 'break-policy' } });
    return await answer;
  }

  public dispose(): void {
    for (const subscription of this._subscriptions) {
      subscription.dispose();
    }
    this._subscriptions.length = 0;
    this._listeners.clear();
    this._watchers.clear();
    for (const set of [this._waitingForReady, this._waitingForMeasurement]) {
      for (const waiter of set) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('the view was disposed while somebody was waiting on the page'));
      }
      set.clear();
    }
  }

  /**
   * The page, or a sentence explaining why there is no page.
   *
   * A throw in `resolveWebviewView` is the worst failure this surface has: the
   * editor swallows it, the panel stays blank, and nothing anywhere says a word.
   * That is exactly what happened on 2026-08-17 while this step was being
   * written -- the shell refused a font family of
   * `Consolas, 'Courier New', monospace`, which is what the setting really holds
   * -- and it took a probe to find out. The refusal is fixed where it belongs
   * (in `webview-html.ts`); this is the second lock, and it turns any future one
   * of these into words on the screen and a line in the log.
   */
  private _shell(webview: vscode.Webview, pageRoot: vscode.Uri): string {
    try {
      return this._html(webview, pageRoot);
    } catch (cause) {
      const what = `the panel could not be built: ${String(cause)}`;
      this._refusals.push(what);
      this._options.logger.error('the panel could not be built, so it has nothing in it', {
        reason: String(cause),
      });
      return sorryPage(what);
    }
  }

  private _html(webview: vscode.Webview, pageRoot: vscode.Uri): string {
    const font = this._font();
    return webviewPageHtml({
      cspSource: webview.cspSource,
      nonce: makeNonce(),
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(pageRoot, 'main.js')).toString(),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(pageRoot, 'main.css')).toString(),
      scrollback: SCROLLBACK_LINES,
      fontFamily: font.fontFamily,
      fontSize: font.fontSize,
    });
  }

  /**
   * What the editor is set to, through the one rule that decides it.
   *
   * The same call serves the shell and the restyle message, which is the point:
   * the page's font at load and its font after a settings change are the same
   * answer delivered twice, not two answers that can drift apart.
   */
  private _font(): TerminalFont {
    const terminal = vscode.workspace.getConfiguration('terminal.integrated');
    const editor = vscode.workspace.getConfiguration('editor');
    return chooseTerminalFont({
      terminalFamily: terminal.get<string>('fontFamily'),
      editorFamily: editor.get<string>('fontFamily'),
      terminalSize: terminal.get<number>('fontSize'),
      editorSize: editor.get<number>('fontSize'),
    });
  }

  private _restyle(): void {
    const font = this._font();
    this._post({ kind: 'restyle', fontFamily: font.fontFamily, fontSize: font.fontSize });
  }

  private _post(message: HostMessage): void {
    void this._view?.webview.postMessage(message);
  }

  private _sawVisibility(visible: boolean): void {
    for (const watcher of this._watchers) {
      watcher(visible);
    }
  }

  private _heard(raw: unknown): void {
    const message = parseViewMessage(raw);
    if (message === null) {
      this._options.logger.warn('the panel said something this window cannot read', {
        // Not `JSON.stringify(raw)` alone: it is typed as returning a string
        // and does not -- `undefined` comes back for `undefined` itself, and
        // that is precisely the kind of message worth a line in the log.
        said: excerpt(raw),
      });
      return;
    }
    // Before this class acts on it, and unconditionally: the terminals' half of
    // the channel is somebody else's, and a message this class has no case for
    // -- a receipt, a keystroke, a size -- must reach them all the same.
    for (const listener of this._listeners) {
      listener(message);
    }
    switch (message.kind) {
      case 'ready':
        this._lastReport = message.report;
        this._options.logger.info('the panel is up', { ...message.report });
        this._settle(this._waitingForReady, message.report);
        return;
      case 'measured':
        this._lastReport = message.report;
        this._settle(this._waitingForMeasurement, message.report, message.because);
        return;
      case 'refused':
        this._refusals.push(message.what);
        this._options.logger.warn('the panel refused to do something and said why', { what: message.what });
        return;
      case 'csp-violation':
        // Loud, and kept. A blocked resource is the failure mode of this whole
        // surface, and the only one that leaves nothing behind by itself.
        this._violations.push({ directive: message.directive, blockedUri: message.blockedUri });
        this._options.logger.warn('the panel was refused a resource by its own content policy', {
          directive: message.directive,
          blockedUri: message.blockedUri,
        });
        return;
      default:
        return;
    }
  }

  private async _wait(
    set: Set<Waiter>,
    timeoutMs: number,
    complaint: string,
    because: string | null = null
  ): Promise<ViewReport> {
    return await new Promise<ViewReport>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        because,
        timer: setTimeout(() => {
          set.delete(waiter);
          reject(new Error(`${complaint} (waited ${String(timeoutMs)} ms)`));
        }, timeoutMs),
      };
      set.add(waiter);
    });
  }

  /** Hands a report to everyone who was waiting for THIS answer, and to nobody else. */
  private _settle(set: Set<Waiter>, report: ViewReport, because: string | null = null): void {
    for (const waiter of set) {
      if (waiter.because !== null && waiter.because !== because) {
        continue;
      }
      clearTimeout(waiter.timer);
      waiter.resolve(report);
      set.delete(waiter);
    }
  }
}
