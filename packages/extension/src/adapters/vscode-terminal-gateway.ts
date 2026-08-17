import * as vscode from 'vscode';
import { VsCodeEditorStrip } from './vscode-editor-strip';
import { VsCodeQuietShell } from './vscode-quiet-shell';
import type {
  Disposable,
  LaunchLocation,
  Logger,
  TerminalExit,
  TerminalExitReason,
  TerminalGateway,
  TerminalHandle,
  TerminalId,
  TerminalSpec,
} from '@gripterm/core';

/**
 * The place that is not one of the editor's, because the editor has no name for
 * it: a group of the editor area that is ours (M2.24). See `VsCodeEditorStrip`.
 */
const STRIP = 'strip';

/**
 * Our vocabulary against the editor's. Total over `LaunchLocation`, so a fourth
 * place would fail the build here rather than fall back to a default nobody
 * chose -- which is exactly what it did when `group` was added.
 */
const PLACES: Readonly<Record<LaunchLocation, vscode.TerminalLocation | typeof STRIP>> = {
  group: STRIP,
  editor: vscode.TerminalLocation.Editor,
  panel: vscode.TerminalLocation.Panel,
};

/**
 * The only way an extension can rename a terminal it created.
 *
 * A command rather than an API, and one that names no target: it renames the
 * ACTIVE terminal. Read out of the 1.132 bundle -- `{id:
 * "workbench.action.terminal.renameWithArg", args: [{name: "args", schema:
 * {required: ["name"]}}], run: (instance, ..., args) => instance.rename(name)}`
 * -- and measured in a real host by the integration suite, because a command id
 * is not a contract and the next build may drop it.
 */
const RENAME_ACTIVE_TERMINAL = 'workbench.action.terminal.renameWithArg';

/**
 * The editor's word for who ended a terminal, in ours.
 *
 * A total record over the platform's enum, so a sixth member arriving in a later
 * API fails the build here rather than being folded into a case with a rule
 * attached to it. What CANNOT be caught that way is an editor newer than the
 * typings sending a number this build has never seen -- so the read below still
 * falls back, and it falls back to `unknown`, which no rule reads as intent.
 */
const REASONS: Readonly<Record<vscode.TerminalExitReason, TerminalExitReason>> = {
  [vscode.TerminalExitReason.Unknown]: 'unknown',
  [vscode.TerminalExitReason.Shutdown]: 'shutdown',
  [vscode.TerminalExitReason.Process]: 'process',
  [vscode.TerminalExitReason.User]: 'user',
  [vscode.TerminalExitReason.Extension]: 'extension',
};

/**
 * What the editor said about a terminal that has just closed.
 *
 * A terminal with no `exitStatus` at all is not a case the platform documents on
 * this event, and it is read as `unknown` rather than guessed at: every rule
 * downstream treats `unknown` as "nobody established anything", which leaves the
 * record restorable.
 */
function exitOf(terminal: vscode.Terminal): TerminalExit {
  const status = terminal.exitStatus;
  if (status === undefined) {
    return { code: undefined, reason: 'unknown' };
  }
  // `hasOwn` and not `??`: the record is total over the enum, so the compiler
  // believes every read of it succeeds -- which is true of the enum this build
  // was compiled against and not of the editor it is running in.
  return {
    code: status.code,
    reason: Object.hasOwn(REASONS, status.reason) ? REASONS[status.reason] : 'unknown',
  };
}

/**
 * The `TerminalGateway` port on `vscode.window`.
 *
 * Three properties of the platform shape this file, and all three are measured
 * rather than assumed:
 *
 *   * `isTransient: true` on every terminal we create (A3). Our terminals are
 *     sessions, not scrollback: the editor must not revive one on reload, or a
 *     restored shell would sit there wearing the name of a conversation that is
 *     not running in it.
 *   * `onDidCloseTerminal` is a WINDOW-level event, not a per-terminal one, so
 *     the routing to a handle happens here. One subscription for every terminal
 *     we own, and it is disposed with the gateway.
 *   * `exitStatus` says two things and both are carried. `code` is `undefined`
 *     when nothing exited inside -- a terminal the person closed and one we
 *     disposed alike (A15) -- and a number when the process exited, which is
 *     what separates a failed launch from an ordinary end (§4.3). `reason` says
 *     WHO ended it, measured 2026-08-13 (A29), and is what separates a person
 *     closing a terminal from the window taking its transient terminals down at
 *     shutdown (§4.2).
 *
 * WHERE the terminal lands is decided here and not in the domain, because it is
 * a fact about this editor and about nothing else: the spec says what to run.
 * The default is a group of the editor area that is ours alone
 * (`gripterm.launch.location`, `group` -- M2.24), which keeps everything the
 * plain editor area gave us -- no `TERMINAL / PORTS / PROBLEMS / OUTPUT` bar, no
 * shared list of terminals, our display name on the tab -- and adds the one
 * thing the owner asked for: the agents together, in a place of their own,
 * below the code. It is also the carrier the roadmap already names for the
 * workflow view of M5: the canvas is a webview tab BESIDE the terminal, and a
 * terminal that lives in the panel has no beside.
 */
export class VsCodeTerminalGateway implements TerminalGateway, Disposable {
  /**
   * This gateway IS the editor engine, and it says so rather than being asked.
   *
   * The record is stamped from here (M3.4(4)), so after a fallback -- the setting
   * said `own`, the native addon did not load, this object was constructed
   * instead -- the record says `editor` because the object that made the terminal
   * does. Reconciliation reads that field before it ends a process, and under
   * this engine a `claude` outlives the extension host on purpose (M2.16, O1).
   */
  public readonly engine = 'editor';

  private readonly _handles = new Map<string, VsCodeTerminalHandle>();
  private readonly _closeSubscription: vscode.Disposable;
  private readonly _activeSubscription: vscode.Disposable;
  private readonly _location: LaunchLocation;
  private readonly _strip: VsCodeEditorStrip;
  private readonly _quiet: VsCodeQuietShell;
  private readonly _logger: Logger;

  constructor(location: LaunchLocation, logger: Logger) {
    this._location = location;
    this._logger = logger;
    this._strip = new VsCodeEditorStrip(logger);
    this._quiet = new VsCodeQuietShell(logger);
    this._closeSubscription = vscode.window.onDidCloseTerminal((terminal) => {
      this._onClosed(terminal);
    });
    // The other half of `rename`: a name that could not be applied when it
    // arrived is applied the moment the person turns to that terminal.
    this._activeSubscription = vscode.window.onDidChangeActiveTerminal((terminal) => {
      if (terminal === undefined) {
        return;
      }
      for (const handle of this._handles.values()) {
        if (handle.owns(terminal)) {
          handle.applyPendingName();
          return;
        }
      }
    });
  }

  public async create(spec: TerminalSpec): Promise<TerminalHandle> {
    const terminal = vscode.window.createTerminal({
      name: spec.name,
      cwd: spec.cwd,
      env: { ...spec.env },
      shellArgs: [...spec.shellArgs],
      location: await this._place(),
      isTransient: true,
      // `null` means "run the person's own shell" (`gripterm.launch.mode:
      // shell`), and the editor spells that by the key being ABSENT. Writing
      // `shellPath: undefined` is a different thing under
      // `exactOptionalPropertyTypes` and does not compile -- which is the
      // compiler catching the exact confusion this spread avoids.
      ...(spec.shellPath === null ? {} : { shellPath: spec.shellPath }),
    });

    const handle = new VsCodeTerminalHandle(spec.terminalId, terminal, this._quiet);
    this._handles.set(spec.terminalId.value, handle);
    return handle;
  }

  public listKnown(): readonly TerminalHandle[] {
    return [...this._handles.values()];
  }

  /** The handle for a terminal we created, or `undefined` once it has closed. */
  public handleFor(terminalId: TerminalId): TerminalHandle | undefined {
    return this._handles.get(terminalId.value);
  }

  public dispose(): void {
    this._closeSubscription.dispose();
    this._activeSubscription.dispose();
    // The terminals themselves are NOT disposed. Deactivation is not a reason
    // to kill a conversation, and the editor closing takes them anyway --
    // that is what `isTransient` is for.
    this._handles.clear();
  }

  /**
   * Where this terminal opens, decided per launch because the strip is not a
   * constant: it is made when the first terminal needs it and goes when the
   * last one does.
   *
   * A strip that cannot be made costs the person nothing but the strip. Four
   * workbench commands stand behind it, none of them API, and the day one of
   * them is renamed the answer must be a terminal among the editors and a line
   * in the log -- not a button that does nothing.
   */
  private async _place(): Promise<vscode.TerminalLocation | vscode.TerminalEditorLocationOptions> {
    const place = PLACES[this._location];
    if (place !== STRIP) {
      return place;
    }
    try {
      // `preserveFocus`: creating a terminal must not take the person off what
      // they were doing. Revealing it is `show`'s business, and the lifecycle
      // decides when that happens.
      return { viewColumn: await this._strip.column(), preserveFocus: true };
    } catch (cause: unknown) {
      this._logger.warn('a group of our own could not be made, opening among the editors', {
        cause: String(cause),
      });
      return vscode.TerminalLocation.Editor;
    }
  }

  private _onClosed(terminal: vscode.Terminal): void {
    for (const [id, handle] of this._handles) {
      if (handle.owns(terminal)) {
        // Forgotten BEFORE the listeners run, so that a listener asking
        // `listKnown()` -- which is what the attention notifier does to decide
        // whether there is still a terminal to show -- gets the answer that is
        // true after the close rather than the one that was true before it.
        this._handles.delete(id);
        handle.closed(exitOf(terminal));
        return;
      }
    }
  }
}

class VsCodeTerminalHandle implements TerminalHandle {
  public readonly terminalId: TerminalId;

  private readonly _terminal: vscode.Terminal;
  private readonly _quiet: VsCodeQuietShell;
  private readonly _listeners = new Set<(exit: TerminalExit) => void>();
  /** A name this terminal is to take as soon as it is the one being looked at. */
  private _pendingName: string | null = null;

  constructor(terminalId: TerminalId, terminal: vscode.Terminal, quiet: VsCodeQuietShell) {
    this.terminalId = terminalId;
    this._terminal = terminal;
    this._quiet = quiet;
  }

  /**
   * `Terminal.processId` is a promise the editor settles once the process is
   * spawned, and `undefined` when it has none to report -- a terminal whose
   * process never came up, or one the platform lost track of. Both arrive here
   * as `null`: the record stores a pid or the absence of one, and inventing a
   * number would make the restore predicate ask whether a stranger is alive.
   */
  public async processId(): Promise<number | null> {
    return (await this._terminal.processId) ?? null;
  }

  public sendText(text: string, execute: boolean): void {
    this._terminal.sendText(text, execute);
  }

  /**
   * The launch line, held back until this shell is the person's own.
   *
   * The whole difference from `sendText` is the holding back, and it belongs
   * here rather than in the caller: the domain says what to run, and WHEN a
   * particular editor's shell is ready for it is a fact about that editor.
   */
  public runLaunchCommand(commandLine: string): void {
    this._quiet.typeWhenQuiet(this._terminal, commandLine);
  }

  public show(preserveFocus: boolean): void {
    this._terminal.show(preserveFocus);
  }

  /**
   * A new name on the tab.
   *
   * There is no API for it: `Terminal.name` is read-only and the editor exposes
   * renaming only as the command below, which -- read out of the 1.132 bundle
   * and confirmed in a real host -- takes `{name}` and applies it to the
   * ACTIVE terminal, whichever that is. So a rename of a terminal nobody is
   * looking at cannot be done at all without first making it active, and making
   * it active would move the panel under the person's hands for a cosmetic
   * change they did not ask for.
   *
   * It is therefore held and applied when the person turns to that terminal.
   * That is not a compromise about latency: the case this exists for is
   * `/rename` typed INSIDE a terminal (M2.17), and a terminal being typed into
   * is the active one, so the ordinary path renames immediately.
   */
  public rename(name: string): void {
    if (vscode.window.activeTerminal !== this._terminal) {
      this._pendingName = name;
      return;
    }
    this._pendingName = null;
    this._applyName(name);
  }

  /** The held name, once this terminal is the one in front of the person. */
  public applyPendingName(): void {
    const name = this._pendingName;
    if (name === null) {
      return;
    }
    this._pendingName = null;
    this._applyName(name);
  }

  public dispose(): void {
    this._terminal.dispose();
  }

  public onDidClose(listener: (exit: TerminalExit) => void): Disposable {
    this._listeners.add(listener);
    return {
      dispose: (): void => {
        this._listeners.delete(listener);
      },
    };
  }

  public owns(terminal: vscode.Terminal): boolean {
    return this._terminal === terminal;
  }

  public closed(exit: TerminalExit): void {
    for (const listener of this._listeners) {
      listener(exit);
    }
    this._listeners.clear();
  }

  /**
   * The editor's own rename, asked for and not awaited.
   *
   * A rejection is swallowed on purpose: this runs from a registry change with
   * no caller behind it, the command is a command and not an API, and the whole
   * cost of it failing is a tab still wearing its old name beside a row that has
   * the new one. Throwing out of here would take down whatever change was being
   * announced.
   */
  private _applyName(name: string): void {
    void vscode.commands.executeCommand(RENAME_ACTIVE_TERMINAL, { name }).then(undefined, () => {
      // Nothing to do and nobody to tell. See above.
    });
  }
}
