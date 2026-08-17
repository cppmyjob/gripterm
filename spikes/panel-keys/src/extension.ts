/**
 * Throwaway measurement stand for 14-m3-plan.md, step M3.1 -- the keyboard gate.
 *
 * It answers three questions and nothing else:
 *
 *   0. Does a webview view render in the bottom panel at all? (A40 -- the class
 *      of defect is live in Cursor: the tab switches and the body stays empty.)
 *   1. For each key of the P6 list: does it reach the webview by itself, does it
 *      arrive only as our contributed keybinding, or does the editor swallow it?
 *      (A31.)
 *   2. Side questions, not gates: how many terminal columns fit at the usual
 *      panel height, and what `retainContextWhenHidden` costs in state.
 *
 * Nothing here moves into `packages/`. The output is a JSON protocol that gets
 * transcribed into `docs/experiments/`.
 *
 * The binding list is NOT duplicated: the chords are read back from our own
 * manifest, so the table below can only add meaning (what the key is for), never
 * a second list of keys that silently disagrees with `contributes.keybindings`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

const VIEW_ID = 'spikePanelKeys.board';
const RESULTS_DEBOUNCE_MS = 250;

/** Where a key is expected to matter. Cursor has its own default bindings. */
type Column = 'both' | 'cursor';

/** What the probe knows about a key beyond its chord. */
interface ProbeSpec {
  readonly id: string;
  readonly label: string;
  readonly purpose: string;
  readonly column: Column;
  /** `null` means: deliberately not bound -- measured in the webview only. */
  readonly command: string | null;
}

/**
 * The P6 list (11-mvp-plan.md P6, quoted in 14-m3-plan.md §1) plus the six keys
 * named by M3.1, plus Cursor's own five in its column.
 */
const PROBES: readonly ProbeSpec[] = [
  { id: 'slash', label: '/', purpose: 'slash-command menu', column: 'both', command: 'spikePanelKeys.key.slash' },
  { id: 'escape', label: 'Escape', purpose: 'interrupt the agent', column: 'both', command: 'spikePanelKeys.key.escape' },
  { id: 'shiftTab', label: 'Shift+Tab', purpose: 'switch mode (plan / auto-accept)', column: 'both', command: 'spikePanelKeys.key.shiftTab' },
  { id: 'ctrlC', label: 'Ctrl+C', purpose: 'interrupt, or copy when there is a selection', column: 'both', command: 'spikePanelKeys.key.ctrlC' },
  { id: 'up', label: 'Up', purpose: 'prompt history', column: 'both', command: 'spikePanelKeys.key.up' },
  { id: 'down', label: 'Down', purpose: 'prompt history', column: 'both', command: 'spikePanelKeys.key.down' },
  { id: 'left', label: 'Left', purpose: 'cursor inside the prompt', column: 'both', command: 'spikePanelKeys.key.left' },
  { id: 'right', label: 'Right', purpose: 'cursor inside the prompt', column: 'both', command: 'spikePanelKeys.key.right' },
  { id: 'home', label: 'Home', purpose: 'start of line', column: 'both', command: 'spikePanelKeys.key.home' },
  { id: 'end', label: 'End', purpose: 'end of line', column: 'both', command: 'spikePanelKeys.key.end' },
  { id: 'ctrlV', label: 'Ctrl+V', purpose: 'paste from the clipboard', column: 'both', command: 'spikePanelKeys.key.ctrlV' },
  { id: 'shiftInsert', label: 'Shift+Insert', purpose: 'paste, the second way', column: 'both', command: 'spikePanelKeys.key.shiftInsert' },
  { id: 'ctrlP', label: 'Ctrl+P', purpose: 'previous entry; VS Code: Quick Open', column: 'both', command: 'spikePanelKeys.key.ctrlP' },
  { id: 'ctrlB', label: 'Ctrl+B', purpose: 'VS Code: toggle the side bar', column: 'both', command: 'spikePanelKeys.key.ctrlB' },
  { id: 'ctrlJ', label: 'Ctrl+J', purpose: 'VS Code: toggle the panel -- ours', column: 'both', command: 'spikePanelKeys.key.ctrlJ' },
  { id: 'ctrlR', label: 'Ctrl+R', purpose: 'reverse search in history', column: 'both', command: 'spikePanelKeys.key.ctrlR' },
  { id: 'ctrlZ', label: 'Ctrl+Z', purpose: 'suspend; VS Code: undo', column: 'both', command: 'spikePanelKeys.key.ctrlZ' },
  { id: 'ctrlW', label: 'Ctrl+W', purpose: 'delete word back; VS Code: CLOSE THE WINDOW', column: 'both', command: 'spikePanelKeys.key.ctrlW' },
  { id: 'ctrlK', label: 'Ctrl+K', purpose: 'Cursor: inline edit; VS Code: chord prefix', column: 'cursor', command: 'spikePanelKeys.key.ctrlK' },
  { id: 'ctrlL', label: 'Ctrl+L', purpose: 'clear the screen; Cursor: chat', column: 'cursor', command: 'spikePanelKeys.key.ctrlL' },
  { id: 'ctrlI', label: 'Ctrl+I', purpose: 'Cursor: composer', column: 'cursor', command: 'spikePanelKeys.key.ctrlI' },
  { id: 'tab', label: 'Tab', purpose: 'completion in Claude Code', column: 'cursor', command: 'spikePanelKeys.key.tab' },
  { id: 'ctrlShiftL', label: 'Ctrl+Shift+L', purpose: 'Cursor: add to chat', column: 'cursor', command: 'spikePanelKeys.key.ctrlShiftL' },
  { id: 'cyrillic', label: 'Cyrillic letter', purpose: 'non-latin input; deliberately not bound', column: 'both', command: null },
  // Not a P6 key at all: a discriminator. The first run showed every key
  // reaching the page while our contributed command never fired once, and that
  // has two possible causes -- the webview consumes the event before the
  // workbench sees it, or `focusedView` simply never equals our view id, in
  // which case the whole M3.8 guard is built on sand. This chord belongs to
  // nobody, so if it fires the command, the guard works and the silence above
  // was consumption; if it does not, the guard is the problem.
  { id: 'guardProbe', label: 'Ctrl+Alt+F9 (guard probe)', purpose: 'does our focusedView guard fire at all', column: 'both', command: 'spikePanelKeys.key.guardProbe' },
];

/** One row of the protocol, as it stands at any moment. */
interface RowState {
  readonly id: string;
  readonly label: string;
  readonly purpose: string;
  readonly column: Column;
  readonly command: string | null;
  /** Chord as our manifest asks for it, or `null` when we bind nothing. */
  readonly chord: string | null;
  /** The keydown reached the webview document. */
  webviewSaw: boolean;
  /** Our contributed keybinding fired the command in the extension host. */
  commandFired: boolean;
  /** Owner says: neither happened, the editor took it. */
  blocked: boolean;
  /** What the editor did instead, in the owner's words. */
  note: string;
  /** Where focus was when the command fired -- the O6 question. */
  focusAtCommand: string | null;
}

interface Metrics {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly charWidthPx: number;
  readonly charHeightPx: number;
  readonly cols: number;
  readonly rows: number;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly devicePixelRatio: number;
}

interface RawEvent {
  readonly at: number;
  readonly chord: string;
  readonly key: string;
  readonly code: string;
  readonly activeElement: string;
  readonly matched: string | null;
}

/** One activation of the stand. A window reload starts a new one. */
interface SessionRecord {
  readonly startedAt: string;
  readonly retainContextWhenHidden: boolean;
  resolveCount: number;
  /**
   * When the page itself spoke. This is the answer to question zero (A40) and
   * it is deliberately separate from `resolveCount`: the Cursor symptom is a
   * provider that resolves while the body stays empty, so "we were asked for
   * html" and "the html came alive" must be two different facts.
   */
  readyAt: string | null;
  visibilityChanges: { readonly visible: boolean; readonly at: string }[];
}

/** Everything the protocol file holds. */
interface Protocol {
  readonly writtenAt: string;
  readonly editor: Record<string, string | boolean | undefined>;
  readonly runtime: Record<string, string | undefined>;
  /** The activation that is running now. */
  readonly view: SessionRecord;
  /** Activations before this one, oldest first. Reloads land here. */
  readonly previousSessions: SessionRecord[];
  metrics: Metrics | null;
  readonly rows: RowState[];
  rawEvents: RawEvent[];
}

/** A keybinding as it appears in our own manifest. */
interface ManifestKeybinding {
  readonly command?: unknown;
  readonly key?: unknown;
}

function readChords(extension: vscode.Extension<unknown>): Map<string, string> {
  const chords = new Map<string, string>();
  const manifest = extension.packageJSON as { contributes?: { keybindings?: unknown } };
  const contributed = manifest.contributes?.keybindings;
  if (!Array.isArray(contributed)) {
    return chords;
  }
  for (const entry of contributed as ManifestKeybinding[]) {
    if (typeof entry.command === 'string' && typeof entry.key === 'string') {
      chords.set(entry.command, entry.key);
    }
  }
  return chords;
}

function nonce(): string {
  let text = '';
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let index = 0; index < 32; index += 1) {
    text += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return text;
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/gu, '-');
}

/**
 * The rows of a protocol written by an earlier activation, by row id.
 *
 * Saving after every change was not enough. Two of the probed keys destroy the
 * board: Ctrl+W closes the window, and Ctrl+R reloads it in an Extension
 * Development Host -- measured 2026-08-17, the owner pressed it and the board
 * came back empty. A stand whose own key list wipes its results makes the owner
 * repeat the whole pass, so the file is not just written but READ BACK.
 */
function restoreRows(filePath: string, rows: RowState[]): SessionRecord[] {
  let parsed: Protocol;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Protocol;
  } catch {
    return [];
  }
  const previous = new Map((parsed.rows ?? []).map((row) => [row.id, row]));
  for (const row of rows) {
    const before = previous.get(row.id);
    if (before === undefined) {
      continue;
    }
    row.webviewSaw = before.webviewSaw;
    row.commandFired = before.commandFired;
    row.blocked = before.blocked;
    row.note = before.note;
    row.focusAtCommand = before.focusAtCommand;
  }
  return [...(parsed.previousSessions ?? []), ...(parsed.view === undefined ? [] : [parsed.view])];
}

/**
 * The protocol on disk. Written after every change, not only on demand: one of
 * the probed keys is Ctrl+W, which in VS Code closes the window -- a stand that
 * saved only at the end would lose the run that proved the point.
 */
class ProtocolFile {
  private timer: NodeJS.Timeout | undefined;

  public constructor(private readonly directory: string, private readonly fileName: string) {}

  public get filePath(): string {
    return path.join(this.directory, this.fileName);
  }

  public scheduleWrite(protocol: Protocol): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.writeNow(protocol);
    }, RESULTS_DEBOUNCE_MS);
  }

  public writeNow(protocol: Protocol): void {
    const body: Protocol = { ...protocol, writtenAt: new Date().toISOString() };
    fs.mkdirSync(this.directory, { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  }

  public dispose(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

class ProbeBoard implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly protocol: Protocol,
    private readonly file: ProtocolFile,
    private readonly log: vscode.OutputChannel,
  ) {}

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.protocol.view.resolveCount += 1;
    this.log.appendLine(`resolveWebviewView #${String(this.protocol.view.resolveCount)}`);

    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage((message: unknown) => {
      this.onMessage(message);
    });

    view.onDidChangeVisibility(() => {
      this.protocol.view.visibilityChanges.push({
        visible: view.visible,
        at: new Date().toISOString(),
      });
      this.log.appendLine(`visibility -> ${String(view.visible)}`);
      this.file.scheduleWrite(this.protocol);
    });

    this.file.scheduleWrite(this.protocol);
  }

  /** Called from the extension host when one of our keybindings fires. */
  public onCommand(id: string): void {
    const row = this.protocol.rows.find((candidate) => candidate.id === id);
    if (row === undefined) {
      return;
    }
    row.commandFired = true;
    row.blocked = false;
    this.log.appendLine(`command fired: ${id}`);
    void this.view?.webview.postMessage({ type: 'commandFired', id });
    this.file.scheduleWrite(this.protocol);
  }

  public reveal(): void {
    this.view?.show(true);
  }

  private onMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null || !('type' in message)) {
      return;
    }
    const payload = message as Record<string, unknown>;
    switch (payload['type']) {
      case 'ready':
        this.protocol.view.readyAt ??= new Date().toISOString();
        this.log.appendLine('page is alive (ready received)');
        void this.view?.webview.postMessage({ type: 'init', protocol: this.protocol });
        break;
      case 'seen': {
        const row = this.rowOf(payload['id']);
        if (row !== undefined) {
          row.webviewSaw = true;
          row.blocked = false;
        }
        break;
      }
      case 'blocked': {
        const row = this.rowOf(payload['id']);
        if (row !== undefined) {
          row.blocked = true;
        }
        break;
      }
      case 'note': {
        const row = this.rowOf(payload['id']);
        if (row !== undefined && typeof payload['text'] === 'string') {
          row.note = payload['text'];
        }
        break;
      }
      case 'focusAtCommand': {
        const row = this.rowOf(payload['id']);
        if (row !== undefined && typeof payload['where'] === 'string') {
          row.focusAtCommand = payload['where'];
        }
        break;
      }
      case 'metrics':
        this.protocol.metrics = payload['metrics'] as Metrics;
        break;
      case 'raw':
        this.protocol.rawEvents.push(payload['event'] as RawEvent);
        if (this.protocol.rawEvents.length > 400) {
          this.protocol.rawEvents = this.protocol.rawEvents.slice(-400);
        }
        break;
      case 'reset':
        for (const row of this.protocol.rows) {
          row.webviewSaw = false;
          row.commandFired = false;
          row.blocked = false;
          row.note = '';
          row.focusAtCommand = null;
        }
        this.protocol.rawEvents = [];
        break;
      case 'save':
        this.file.writeNow(this.protocol);
        void vscode.window.showInformationMessage(`Spike protocol: ${this.file.filePath}`);
        return;
      default:
        return;
    }
    this.file.scheduleWrite(this.protocol);
  }

  private rowOf(id: unknown): RowState | undefined {
    return typeof id === 'string' ? this.protocol.rows.find((row) => row.id === id) : undefined;
  }

  private html(webview: vscode.Webview): string {
    const key = nonce();
    const terminalConfig = vscode.workspace.getConfiguration('terminal.integrated');
    const editorConfig = vscode.workspace.getConfiguration('editor');
    // `terminal.integrated.fontFamily` defaults to the EMPTY STRING, not to
    // absent, so `??` alone leaves the canvas with `14px ` -- an invalid font
    // that silently falls back to a proportional one and makes the column
    // estimate wrong. Measured here 2026-08-17: charWidth 9.44 px with an empty
    // family. Emptiness has to be treated as absence.
    const firstNonEmpty = (...candidates: (string | undefined)[]): string | undefined =>
      candidates.find((candidate) => candidate !== undefined && candidate.trim().length > 0);
    const fontFamily =
      firstNonEmpty(terminalConfig.get<string>('fontFamily'), editorConfig.get<string>('fontFamily')) ??
      'Consolas, "Courier New", monospace';
    const fontSize = terminalConfig.get<number>('fontSize') ?? editorConfig.get<number>('fontSize') ?? 14;

    // No external resources at all: everything is inline under a nonce, so a CSP
    // violation here can only mean our own mistake.
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${key}'; script-src 'nonce-${key}';">
<style nonce="${key}">
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 6px 10px; }
  .split { display: flex; gap: 10px; align-items: stretch; }
  .left { flex: 1 1 auto; min-width: 0; }
  .right { flex: 0 0 240px; border-left: 1px solid var(--vscode-panel-border); padding-left: 10px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 2px 6px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
  th { position: sticky; top: 0; background: var(--vscode-editor-background); }
  code { font-family: var(--vscode-editor-font-family); }
  .ok { color: var(--vscode-charts-green); font-weight: 600; }
  .via { color: var(--vscode-charts-yellow); font-weight: 600; }
  .no { color: var(--vscode-charts-red); font-weight: 600; }
  .cursorOnly td:first-child::after { content: ' (Cursor)'; opacity: .6; }
  input[type=text] { width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 2px 8px; cursor: pointer; }
  .bar { margin: 6px 0; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .hint { opacity: .75; }
  #board { outline: none; }
  #board:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
</style>
</head>
<body>
<div class="bar">
  <strong>M3.1 keyboard probe</strong>
  <span class="hint" id="metrics"></span>
  <button id="save">Save protocol</button>
  <button id="reset">Reset</button>
</div>
<div class="split">
  <div class="left">
    <div id="board" tabindex="0">
      <p class="hint">Click here, then press the keys one by one. A row turns green when the key reached this
      page, yellow when only our keybinding fired, red when you mark it as taken by the editor.
      <strong>Ctrl+W may close the window</strong> -- the protocol is already on disk.</p>
      <table>
        <thead><tr><th>Key</th><th>What it is for</th><th>Webview</th><th>Command</th><th>Verdict</th><th></th><th>What the editor did</th></tr></thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
  </div>
  <div class="right">
    <p class="hint">This half stands in for the details pane (O6). Put focus in the field below and press
    Escape or an arrow: if a row still turns yellow, <code>focusedView</code> is too wide a guard.</p>
    <input type="text" id="details" placeholder="pretend details pane">
    <p class="hint">Raw keydown log:</p>
    <div id="raw" class="hint"></div>
  </div>
</div>
<script nonce="${key}">
(() => {
  const vscodeApi = acquireVsCodeApi();
  const fontFamily = ${JSON.stringify(fontFamily)};
  const fontSize = ${JSON.stringify(fontSize)};
  let rows = [];

  const post = (message) => { vscodeApi.postMessage(message); };

  const chordOf = (event) => {
    const parts = [];
    if (event.ctrlKey) parts.push('ctrl');
    if (event.shiftKey) parts.push('shift');
    if (event.altKey) parts.push('alt');
    if (event.metaKey) parts.push('meta');
    const named = {
      Escape: 'escape', Tab: 'tab', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left',
      ArrowRight: 'right', Home: 'home', End: 'end', Insert: 'insert', Enter: 'enter',
      Backspace: 'backspace', Delete: 'delete', ' ': 'space',
    };
    const base = named[event.key] ?? (event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase());
    parts.push(base);
    return parts.join('+');
  };

  const isCyrillic = (event) => event.key.length === 1 && /[\\u0400-\\u04FF]/u.test(event.key);

  const activeName = () => {
    const active = document.activeElement;
    if (!active) return 'none';
    return active.id ? '#' + active.id : active.tagName.toLowerCase();
  };

  const render = () => {
    const body = document.getElementById('rows');
    body.textContent = '';
    for (const row of rows) {
      const tr = document.createElement('tr');
      if (row.column === 'cursor') tr.className = 'cursorOnly';
      const cell = (text) => { const td = document.createElement('td'); td.textContent = text; tr.appendChild(td); return td; };
      cell(row.label);
      cell(row.purpose);
      cell(row.webviewSaw ? 'yes' : '-');
      cell(row.commandFired ? 'yes' : (row.chord ? '-' : 'not bound'));
      const verdict = cell('');
      if (row.webviewSaw) { verdict.textContent = 'reaches the page'; verdict.className = 'ok'; }
      else if (row.commandFired) { verdict.textContent = 'only via keybinding'; verdict.className = 'via'; }
      else if (row.blocked) { verdict.textContent = 'taken by the editor'; verdict.className = 'no'; }
      else { verdict.textContent = 'pending'; }
      const actions = document.createElement('td');
      const mark = document.createElement('button');
      mark.textContent = 'did not arrive';
      mark.addEventListener('click', () => { row.blocked = true; row.webviewSaw = false; row.commandFired = false; post({ type: 'blocked', id: row.id }); render(); });
      actions.appendChild(mark);
      tr.appendChild(actions);
      const noteCell = document.createElement('td');
      const note = document.createElement('input');
      note.type = 'text';
      note.value = row.note ?? '';
      note.addEventListener('change', () => { row.note = note.value; post({ type: 'note', id: row.id, text: note.value }); });
      noteCell.appendChild(note);
      tr.appendChild(noteCell);
      body.appendChild(tr);
    }
  };

  const measure = () => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    context.font = fontSize + 'px ' + fontFamily;
    const charWidthPx = context.measureText('W'.repeat(50)).width / 50;
    const charHeightPx = Math.ceil(fontSize * 1.2);
    const widthPx = document.body.clientWidth;
    const heightPx = document.body.clientHeight;
    const metrics = {
      widthPx, heightPx, charWidthPx, charHeightPx,
      cols: Math.max(0, Math.floor(widthPx / charWidthPx)),
      rows: Math.max(0, Math.floor(heightPx / charHeightPx)),
      fontFamily, fontSize, devicePixelRatio: window.devicePixelRatio,
    };
    document.getElementById('metrics').textContent =
      'panel ' + widthPx + 'x' + heightPx + ' px, about ' + metrics.cols + 'x' + metrics.rows + ' cells (estimate, no xterm here)';
    post({ type: 'metrics', metrics });
  };

  const rawBox = document.getElementById('raw');
  const pushRaw = (line) => {
    const div = document.createElement('div');
    div.textContent = line;
    rawBox.prepend(div);
    while (rawBox.childElementCount > 12) rawBox.lastElementChild.remove();
  };

  window.addEventListener('keydown', (event) => {
    const chord = chordOf(event);
    let matched = null;
    for (const row of rows) {
      if (row.chord && row.chord === chord) { matched = row; break; }
      if (row.id === 'cyrillic' && isCyrillic(event)) { matched = row; break; }
    }
    if (matched) { matched.webviewSaw = true; matched.blocked = false; post({ type: 'seen', id: matched.id }); render(); }
    const where = activeName();
    pushRaw(chord + '  (' + event.code + ', focus ' + where + ')' + (matched ? ' -> ' + matched.id : ''));
    post({ type: 'raw', event: { at: Date.now(), chord, key: event.key, code: event.code, activeElement: where, matched: matched ? matched.id : null } });
  }, true);

  window.addEventListener('message', (message) => {
    const data = message.data;
    if (data.type === 'init') {
      rows = data.protocol.rows;
      render();
      measure();
    } else if (data.type === 'commandFired') {
      const row = rows.find((candidate) => candidate.id === data.id);
      if (row) {
        row.commandFired = true;
        row.blocked = false;
        post({ type: 'focusAtCommand', id: row.id, where: activeName() });
        render();
      }
    }
  });

  window.addEventListener('resize', measure);
  document.getElementById('save').addEventListener('click', () => { post({ type: 'save' }); });
  document.getElementById('reset').addEventListener('click', () => {
    for (const row of rows) { row.webviewSaw = false; row.commandFired = false; row.blocked = false; row.note = ''; }
    post({ type: 'reset' });
    render();
  });
  document.getElementById('board').focus();
  post({ type: 'ready' });
})();
</script>
</body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Spike: panel keys');
  context.subscriptions.push(log);

  const chords = readChords(context.extension);
  const rows: RowState[] = PROBES.map((probe) => ({
    id: probe.id,
    label: probe.label,
    purpose: probe.purpose,
    column: probe.column,
    command: probe.command,
    chord: probe.command === null ? null : chords.get(probe.command) ?? null,
    webviewSaw: false,
    commandFired: false,
    blocked: false,
    note: '',
    focusAtCommand: null,
  }));

  // A binding in the manifest with no row here, or a row that claims a command
  // the manifest never binds, is a stand that measures a list it does not have.
  const bound = new Set(chords.keys());
  for (const row of rows) {
    if (row.command !== null && row.chord === null) {
      log.appendLine(`WARNING: ${row.id} names ${row.command}, which the manifest does not bind`);
    }
    if (row.command !== null) {
      bound.delete(row.command);
    }
  }
  for (const orphan of bound) {
    log.appendLine(`WARNING: manifest binds ${orphan}, which no row claims`);
  }

  const retain = vscode.workspace
    .getConfiguration('spikePanelKeys')
    .get<boolean>('retainContextWhenHidden', true);
  const configuredDir = vscode.workspace.getConfiguration('spikePanelKeys').get<string>('resultsDir', '');
  const directory = configuredDir.length > 0 ? configuredDir : path.join(context.extensionPath, 'results');
  // One file per editor, NOT one per activation: a reload has to continue the
  // same protocol, not start a second one the owner would have to fill again.
  const file = new ProtocolFile(
    directory,
    `${sanitize(vscode.env.appName)}-${sanitize(vscode.version)}.json`,
  );
  context.subscriptions.push({ dispose: () => { file.dispose(); } });

  const previousSessions = fs.existsSync(file.filePath) ? restoreRows(file.filePath, rows) : [];
  const restored = rows.filter((row) => row.webviewSaw || row.commandFired || row.blocked).length;
  if (previousSessions.length > 0) {
    log.appendLine(`restored ${String(restored)} answered rows from ${String(previousSessions.length)} earlier session(s)`);
  }

  const protocol: Protocol = {
    writtenAt: new Date().toISOString(),
    editor: {
      appName: vscode.env.appName,
      appHost: vscode.env.appHost,
      version: vscode.version,
      uriScheme: vscode.env.uriScheme,
      language: vscode.env.language,
      remoteName: vscode.env.remoteName,
      isNewAppInstall: vscode.env.isNewAppInstall,
    },
    runtime: {
      node: process.versions.node,
      electron: process.versions['electron'],
      modulesAbi: process.versions.modules,
      v8: process.versions.v8,
      chrome: process.versions['chrome'],
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
    },
    view: {
      startedAt: new Date().toISOString(),
      retainContextWhenHidden: retain,
      resolveCount: 0,
      readyAt: null,
      visibilityChanges: [],
    },
    previousSessions,
    metrics: null,
    rows,
    rawEvents: [],
  };

  const board = new ProbeBoard(context.extensionUri, protocol, file, log);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, board, {
      webviewOptions: { retainContextWhenHidden: retain },
    }),
  );

  for (const row of rows) {
    if (row.command === null) {
      continue;
    }
    const id = row.id;
    context.subscriptions.push(
      vscode.commands.registerCommand(row.command, () => {
        board.onCommand(id);
      }),
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('spikePanelKeys.saveProtocol', () => {
      file.writeNow(protocol);
      void vscode.window.showInformationMessage(`Spike protocol: ${file.filePath}`);
    }),
  );

  file.writeNow(protocol);
  log.appendLine(`protocol file: ${file.filePath}`);
  log.appendLine(`retainContextWhenHidden: ${String(retain)}`);

  // Open our panel tab ourselves. Two reasons, and the second is the point of
  // the step: the board should have focus so that keys go to it, and question
  // zero (does the view render in this editor's bottom panel at all) becomes
  // answerable without a human in front of the screen -- `resolveCount` rises
  // and `readyAt` either fills in or stays null.
  void vscode.commands.executeCommand(`${VIEW_ID}.focus`).then(undefined, (error: unknown) => {
    log.appendLine(`focus command failed: ${String(error)}`);
  });
}

export function deactivate(): void {
  // Nothing to do: every subscription is registered on the context.
}
