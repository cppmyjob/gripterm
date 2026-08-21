import { LaunchError, exitVerdict, terminalEnvironment } from '@gripterm/core';
import type { IPty } from 'node-pty';
import type {
  Disposable,
  EditorIdentity,
  Logger,
  ScreenExit,
  TerminalAudience,
  TerminalExit,
  TerminalExitCause,
  TerminalGateway,
  TerminalHandle,
  TerminalId,
  TerminalScreen,
  TerminalSpec,
} from '@gripterm/core';
import type { NodePtyModule } from './node-pty-module';

/**
 * What `TERM` says to the program inside.
 *
 * A value we choose rather than a variable we leave alone, and that is a fact
 * about the library rather than a preference: node-pty writes `TERM` into every
 * child regardless (`env.TERM = opt.name || env.TERM || 'xterm'`, in both
 * `unixTerminal.js` and `windowsTerminal.js` of 1.1.0). So the question was never
 * whether the child gets a `TERM` but which one, and `xterm` -- the library's
 * default -- would announce eight colours to an agent we are about to draw on
 * xterm.js in 24-bit colour. This is also what the editor's own terminals carry
 * (measured, M3.2 stage B).
 */
const TERM_NAME = 'xterm-256color';

/**
 * The size a terminal starts at, before anything can tell us the real one.
 *
 * There is no view yet -- it arrives in M3.6, and with it the resize that comes
 * from a person dragging a border. Until then this is a stated default and not a
 * measurement: a TUI asks the pty how wide it is, so a number has to exist before
 * the first byte, and 80x30 is what the measurement stand of M3.2 ran `claude`
 * under.
 */
/**
 * How long a pty is left alone after its first output before a size that was
 * waiting for it is applied.
 *
 * A measured platform fact and not a preference (2026-08-18): applied ON that
 * first output, or one frame after it, the resize is LOST -- ConPTY puts no
 * `ESC[8;rows;cols t` in the output stream and the client console keeps the size
 * it was spawned with, so an agent draws every frame at a width nobody has.
 * Sixteen milliseconds was still too early; a quarter of a second takes, every
 * time. It is spent once per terminal, before there is anything on the screen
 * to resize.
 */
const RESIZE_AFTER_FIRST_OUTPUT_MS = 250;

const INITIAL_COLS = 80;
const INITIAL_ROWS = 30;

export interface PtyTerminalGatewayOptions {
  readonly pty: NodePtyModule;
  /** What the editor calls itself to a program inside one of its terminals. */
  readonly editor: EditorIdentity;
  readonly logger: Logger;
  /**
   * Whether the agent may reach the Claude Code extension of this editor.
   *
   * The person's answer, carried from `gripterm.terminal.ideChannel` and handed
   * to the rule that builds the environment, where both sides of the trade are
   * written down.
   */
  readonly ideChannel: boolean;
  /**
   * Whoever is going to draw these terminals, or `null` when nobody is.
   *
   * `null` is not a degenerate case: the contract suite makes gateways with no
   * view at all, and a window whose panel has not been built yet is the same
   * shape. A terminal with no audience runs exactly as it did before M3.7 --
   * unseen -- which is the behaviour the setting's own description promised
   * while there was nothing to show it in.
   */
  readonly audience?: TerminalAudience | null;
}

/**
 * The `TerminalGateway` port on a pty of our own.
 *
 * The second engine behind the same port, and everything specific to it comes
 * from one difference: there is no editor in the middle. That buys the bytes --
 * `TerminalScreen` on every handle, which the editor's API cannot give at all --
 * and it costs the two things the editor was doing for us, a place to show a
 * terminal and a tab to write a name on. Both arrive in M3.6, and until they do
 * this class keeps what it was told rather than pretending to have applied it.
 *
 * **It knows nothing about `vscode`, deliberately.** Everything editor-shaped
 * comes in through `EditorIdentity` and the spec, so the whole engine can be run
 * -- and is run -- outside an Extension Host. That is not tidiness: the contract
 * suite has to be able to hold both engines to the same assertions, and one of
 * them needs a real editor.
 *
 * **What this engine does NOT do yet, said here rather than found later.** Its
 * `dispose` kills the ptys it made, so nothing of ours is left running by a
 * window that went away -- but the SECOND half of that, the synchronous kill by
 * recorded pid at `deactivate` and the reconciler's right to end somebody else's
 * orphan, is M3.5. Until then a pty that ignores its kill is a process nobody
 * ends.
 */
export class PtyTerminalGateway implements TerminalGateway, Disposable {
  /**
   * This gateway IS the own engine, and the record is stamped from here.
   *
   * The value a person configured is NOT this: a window that asked for `own` and
   * could not load the addon holds a `VsCodeTerminalGateway`, which answers
   * `editor`, and the record it stamps says `editor` too. That is the whole
   * mechanism by which reconciliation cannot end a live conversation through the
   * door of a fallback (M3.4).
   */
  public readonly engine = 'own';

  private readonly _handles = new Map<string, PtyTerminalHandle>();
  private readonly _pty: NodePtyModule;
  private readonly _editor: EditorIdentity;
  private readonly _ideChannel: boolean;
  private readonly _logger: Logger;
  private readonly _audience: TerminalAudience | null;

  constructor(options: PtyTerminalGatewayOptions) {
    this._pty = options.pty;
    this._editor = options.editor;
    this._ideChannel = options.ideChannel;
    this._logger = options.logger;
    this._audience = options.audience ?? null;
  }

  public async create(spec: TerminalSpec): Promise<TerminalHandle> {
    if (spec.shellPath === null) {
      // `null` means "run the person's own shell and type the command in
      // afterwards" -- `gripterm.launch.mode: shell`, which this engine refuses
      // at the point where the engine is chosen (`chooseEngine`). Reaching here
      // is a wiring mistake, and it is louder as a refused launch than as a pty
      // running a shell nobody asked for.
      throw new LaunchError(
        'a terminal of our own cannot run the shell launch mode, and the engine choice should have refused it already',
        { details: { terminalId: spec.terminalId.value } }
      );
    }

    /*
     * The environment is built HERE and in full, because a pty replaces the
     * environment rather than adding to it: `null` in the spec means "remove",
     * and node-pty has no way to say that. `{...process.env, ...spec.env}` would
     * hand the CLI `CLAUDE_CODE_CHILD_SESSION="null"`, and with that variable
     * present in any form the CLI writes neither transcript nor history (A28).
     */
    const env = terminalEnvironment({
      host: process.env,
      delta: spec.env,
      editor: this._editor,
      ideChannel: this._ideChannel,
      // Windows does not tell `Path` from `PATH`; Unix does. An argument rather
      // than a check inside the rule, because the rule lives in the core and the
      // platform does not.
      caseInsensitiveNames: process.platform === 'win32',
    });

    let child: IPty;
    try {
      child = this._pty.spawn(spec.shellPath, [...spec.shellArgs], {
        name: TERM_NAME,
        cols: INITIAL_COLS,
        rows: INITIAL_ROWS,
        cwd: spec.cwd,
        env,
      });
    } catch (cause: unknown) {
      // A `require` that succeeded proves nothing about the addon (measured
      // 2026-08-17): the `.node` file is not touched until a spawn. So this is
      // where a broken copy actually surfaces, and it surfaces as one refused
      // launch with a sentence rather than as a window with no terminals.
      throw new LaunchError('the native terminal could not start the process', {
        cause,
        details: { terminalId: spec.terminalId.value, shellPath: spec.shellPath },
      });
    }

    const key = spec.terminalId.value;
    const handle = new PtyTerminalHandle({
      terminalId: spec.terminalId,
      name: spec.name,
      child,
      logger: this._logger,
      audience: this._audience,
      // Forgotten BEFORE the close listeners run, so that a listener asking
      // `listKnown()` -- which is what the attention notifier does to decide
      // whether there is still a terminal to show -- gets the answer that is true
      // after the close rather than the one that was true before it.
      forget: () => {
        this._handles.delete(key);
      },
    });
    this._handles.set(key, handle);
    // After the map, so that whoever starts keeping this terminal's output can
    // already find it by id; before the return, so that no byte the process
    // produces reaches nobody. A pty starts talking the instant it is spawned,
    // and the first thing an agent prints is the reason it is about to fail.
    this._audience?.opened(handle);
    return await Promise.resolve(handle);
  }

  public listKnown(): readonly TerminalHandle[] {
    return [...this._handles.values()];
  }

  /** The handle for a terminal we created, or `undefined` once it has closed. */
  public handleFor(terminalId: TerminalId): TerminalHandle | undefined {
    return this._handles.get(terminalId.value);
  }

  /**
   * Ends the ptys this gateway made.
   *
   * The opposite of what `VsCodeTerminalGateway` does, and for a reason rather
   * than by preference: its terminals are the editor's, marked transient, and the
   * editor takes them down itself. Ours belong to nobody else. A gateway that let
   * them go on running would leave a `claude` per terminal behind every disabled
   * extension and every closed window.
   *
   * `we-are-shutting-down` and not `we-disposed`: the two are the same act to a
   * pty and opposite acts to a record. A window leaving must not stamp `closedAt`
   * on conversations it is expected to bring back (П7).
   */
  public dispose(): void {
    for (const handle of [...this._handles.values()]) {
      handle.endBecauseWeAreLeaving();
    }
    this._handles.clear();
  }
}

interface PtyTerminalHandleOptions {
  readonly terminalId: TerminalId;
  readonly name: string;
  readonly child: IPty;
  readonly logger: Logger;
  readonly audience: TerminalAudience | null;
  readonly forget: () => void;
}

/**
 * One terminal of our own: the handle the domain holds, and the screen beside it.
 *
 * Both faces of one pty. `dispose` on either of them is the same act, which is
 * why the end is reported from one place and reported once -- the end of a pty
 * reaches an adapter from more than one direction (the event, and the kill that
 * provoked it), and a record written twice is two deaths for one dying.
 */
export class PtyTerminalHandle implements TerminalHandle {
  public readonly terminalId: TerminalId;
  /** Always present on this engine -- a line of the contract, not a discovery (§4.1). */
  public readonly screen: TerminalScreen;

  private readonly _child: IPty;
  private readonly _logger: Logger;
  private readonly _audience: TerminalAudience | null;
  private readonly _forget: () => void;
  private readonly _closeListeners = new Set<(exit: TerminalExit) => void>();
  private readonly _dataListeners = new Set<(chunk: string) => void>();
  private readonly _exitListeners = new Set<(exit: ScreenExit) => void>();
  private _name: string;
  private _shownPreservingFocus: boolean | null = null;
  private _over = false;
  /**
   * Whether this pty has already been told to die.
   *
   * Separate from `_over`, which means the exit has been HEARD, and the gap
   * between them is where a real crash lived: `dispose()` on a handle and
   * `dispose()` on the gateway a moment later both reached `kill()` on the same
   * `IPty`, because the exit event had not arrived yet. Measured 2026-08-21 in a
   * live run -- the extension host died with `code -1073740940`, which is
   * `STATUS_HEAP_CORRUPTION`, immediately after a suite disposed a terminal and
   * then its gateway.
   *
   * Killing twice is not a retry either way: node-pty's `kill` is asynchronous
   * by construction (M3.5), and the second, SYNCHRONOUS attempt this build makes
   * is by pid in `deactivate` -- not through this object.
   */
  private _killed = false;
  private _cause: TerminalExitCause = 'exited';
  /** Whether this pty has produced anything yet. See `resize`. */
  private _spoke = false;
  /** A size asked for before it did, to be applied when it does. */
  private _wantedSize: { readonly cols: number, readonly rows: number } | null = null;

  constructor(options: PtyTerminalHandleOptions) {
    this.terminalId = options.terminalId;
    this._child = options.child;
    this._logger = options.logger;
    this._audience = options.audience;
    this._forget = options.forget;
    this._name = options.name;
    this.screen = new PtyTerminalScreen(this);

    this._child.onData((chunk) => {
      this._itSpoke();
      for (const listener of this._dataListeners) {
        listener(chunk);
      }
    });
    this._child.onExit(({ exitCode, signal }) => {
      this._ended(exitCode, signal);
    });
  }

  /**
   * The name this terminal would be wearing if there were a tab to wear it on.
   *
   * Kept rather than applied, and kept rather than dropped: the strip of tabs
   * arrives in M3.6 and will read exactly this. Until then the port's promise
   * holds either way -- `rename` says nothing about WHEN a name lands.
   */
  public get name(): string {
    return this._name;
  }

  /** How the last `show` asked to be shown, or `null` if nobody has asked. See `show`. */
  public get shownPreservingFocus(): boolean | null {
    return this._shownPreservingFocus;
  }

  /**
   * The pid of the process we started -- `claude` itself on the default path.
   *
   * Measured (M3.2(8)) rather than trusted: under ConPTY the console host is a
   * process too, and its pid would pass every test that only asked for a number
   * while breaking restoration and the orphan sweep on a real machine. node-pty
   * reports the process's own.
   *
   * A promise because the port's is, and it is answered at once because we have
   * the number the moment `spawn` returns.
   */
  public async processId(): Promise<number | null> {
    return await Promise.resolve(this._child.pid);
  }

  /**
   * Bytes towards the process, with `\r` appended only when asked to execute.
   *
   * After the process has ended this is ignored rather than thrown out of, which
   * is the screen port's rule applied to the other door into the same pty: a
   * caller cannot avoid the race by asking first, because there is no instant
   * between the question and the call in which the answer is guaranteed to hold.
   */
  public sendText(text: string, execute: boolean): void {
    this.write(execute ? `${text}\r` : text);
  }

  /**
   * The launch line -- refused here, out loud, and that refusal is the pair to
   * the one in `chooseEngine`.
   *
   * It exists for `gripterm.launch.mode: shell`: a line typed into the person's
   * own shell once that shell has gone quiet. A terminal of ours has no shell in
   * it and nobody to ask about quiet, so there is nothing to hold this line back
   * until. Refused rather than typed: typing it into a live agent's prompt is
   * exactly the accident A12 is about.
   *
   * A log line and not a throw. The port promises nothing about when this lands
   * and returns nothing, so a caller has no place to catch anything -- and the
   * pairing in `chooseEngine` means this method is unreachable through the
   * product's own path anyway.
   */
  public runLaunchCommand(commandLine: string): void {
    this._logger.error(
      'a terminal of our own cannot type a launch line into a shell it does not have, so nothing was typed',
      {
        terminalId: this.terminalId.value,
        setting: 'gripterm.launch.mode',
        engine: 'own',
        commandLine,
      }
    );
  }

  /**
   * Puts this terminal in front of the person -- or remembers that somebody
   * wanted it there, when there is nobody to tell.
   *
   * `preserveFocus` travels through untouched, and the difference it carries is
   * П7: a window bringing six terminals back must not take the cursor six times,
   * while a person who pressed "new terminal" is asking for exactly that.
   *
   * Kept as well as passed on. A window whose panel has never been opened has no
   * audience yet, and the answer to "which terminal should the view show when it
   * is finally built" is this field.
   */
  public show(preserveFocus: boolean): void {
    this._shownPreservingFocus = preserveFocus;
    this._audience?.shown(this.terminalId, preserveFocus);
  }

  public rename(name: string): void {
    this._name = name;
  }

  /** Ends this terminal because somebody meant to end it: the cross, a command, or us. */
  public dispose(): void {
    this._kill('we-disposed');
  }

  /** Ends this terminal because the window is going away. Not the same act to a record. */
  public endBecauseWeAreLeaving(): void {
    this._kill('we-are-shutting-down');
  }

  public onDidClose(listener: (exit: TerminalExit) => void): Disposable {
    this._closeListeners.add(listener);
    return {
      dispose: (): void => {
        this._closeListeners.delete(listener);
      },
    };
  }

  /** The screen's half of the port. See `PtyTerminalScreen`, which is the face of it. */
  public onData(listener: (chunk: string) => void): Disposable {
    this._dataListeners.add(listener);
    return {
      dispose: (): void => {
        this._dataListeners.delete(listener);
      },
    };
  }

  public onExit(listener: (exit: ScreenExit) => void): Disposable {
    this._exitListeners.add(listener);
    return {
      dispose: (): void => {
        this._exitListeners.delete(listener);
      },
    };
  }

  public write(data: string): void {
    if (this._over) {
      return;
    }
    try {
      this._child.write(data);
    } catch (cause: unknown) {
      // The same race as `resize`: the pty can end between the check and the
      // call. Nothing to tell anybody -- the bytes were for a process that is
      // gone.
      this._logger.info('bytes were written to a terminal that had just ended', {
        terminalId: this.terminalId.value,
        cause: String(cause),
      });
    }
  }

  /**
   * The new size, when it is a size at all.
   *
   * Two guards, and both are somebody else's measured behaviour. node-pty throws
   * `Cannot resize a pty that has already exited` -- observed four times out of
   * five while a resize was in flight against a stream that was finishing (M3.2
   * stage B §8) -- so the end is caught rather than avoided. And `FitAddon` of
   * xterm.js proposes `NaN` for a terminal that is hidden with `display: none`
   * (xterm.js#3029), which is a number this process would hand to a native call.
   */
  public resize(cols: number, rows: number): void {
    if (this._over) {
      return;
    }
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
      this._logger.warn('a terminal was asked to take a size that is not one, so it kept the one it had', {
        terminalId: this.terminalId.value,
        cols,
        rows,
      });
      return;
    }
    if (!this._spoke) {
      /*
       * Held until this pty has produced something, and that is a measured
       * platform fact rather than caution (2026-08-17, node-pty 1.1.0 on
       * Windows). `WindowsTerminal` queues `write`, `resize` and `kill` until
       * `_isReady`, and `_isReady` is set by the FIRST DATA EVENT from the pty's
       * socket -- not by the spawn. A resize queued before that runs whenever
       * the data finally comes, and if the process has exited by then node-pty
       * throws `Cannot resize a pty that has already exited` from inside its own
       * socket callback, where no `try` of ours can reach it: it becomes an
       * uncaught exception in the extension host. Seen doing exactly that while
       * this step was being written.
       *
       * So the queue is ours instead, under the guard that already exists: a
       * terminal that ends before it speaks is simply never resized.
       */
      this._wantedSize = { cols, rows };
      return;
    }
    try {
      this._child.resize(cols, rows);
    } catch (cause: unknown) {
      this._logger.info('a terminal that had just ended was asked to resize', {
        terminalId: this.terminalId.value,
        cause: String(cause),
      });
    }
  }

  /**
   * Holds the process's output back at the source, and lets it go again.
   *
   * node-pty pauses the SOCKET it reads the pty through, so the back-pressure
   * reaches the process the way an unread pipe does -- there is no buffer of
   * ours in the middle growing while it does. What that means on Windows is
   * measured rather than assumed: `tests/integration/terminal-in-view.test.ts`
   * runs a flood, stops acknowledging it, and asserts that the arrivals STOP.
   *
   * Both are guarded by the same rule as `write` and `resize`, and here it
   * matters most: a pause thrown out of would abandon the flood it was called
   * to stop, and a resume thrown out of would leave the process held back for
   * good.
   */
  public pause(): void {
    if (this._over) {
      return;
    }
    try {
      this._child.pause();
    } catch (cause: unknown) {
      this._logger.info('a terminal that had just ended was asked to hold its output back', {
        terminalId: this.terminalId.value,
        cause: String(cause),
      });
    }
  }

  public resume(): void {
    if (this._over) {
      return;
    }
    try {
      this._child.resume();
    } catch (cause: unknown) {
      this._logger.info('a terminal that had just ended was let go of', {
        terminalId: this.terminalId.value,
        cause: String(cause),
      });
    }
  }

  /**
   * The first thing this pty ever printed: from here, calls to it are not
   * queued -- but the size that was waiting goes a beat later.
   *
   * **The beat is a measured platform fact (2026-08-18).** A resize applied in
   * the same turn as the pseudoconsole's first data event is lost, and so is one
   * applied a frame later: ConPTY acknowledges nothing in the output stream and
   * the client console keeps the size it was spawned with, so the agent draws
   * its first frame -- and every frame after it -- at a width nobody has. The
   * same call a quarter of a second later takes, every time.
   *
   * The condition for taking this out: a ConPTY that answers a resize made on
   * top of its first output. Until then the number is in
   * `RESIZE_AFTER_FIRST_OUTPUT_MS`, where it is explained rather than tuned.
   */
  private _itSpoke(): void {
    if (this._spoke) {
      return;
    }
    this._spoke = true;
    const wanted = this._wantedSize;
    this._wantedSize = null;
    if (wanted === null) {
      return;
    }
    setTimeout(() => {
      // Still worth doing if the terminal has gone in the meantime: `resize`
      // refuses for an ended pty by itself, and refuses out loud.
      this.resize(wanted.cols, wanted.rows);
    }, RESIZE_AFTER_FIRST_OUTPUT_MS);
  }

  private _kill(cause: TerminalExitCause): void {
    if (this._over || this._killed) {
      return;
    }
    this._killed = true;
    // Recorded BEFORE the kill: the exit event can arrive inside `kill()`, and a
    // cause written afterwards would be written after it had been read.
    this._cause = cause;
    try {
      /*
       * node-pty's own kill also forks `conpty_console_list_agent` to end the
       * console's other processes, and that pass is broken by a race of its own
       * (measured 2026-08-17): the pseudoconsole is closed before the fork
       * attaches, so the agent dies with `AttachConsole failed`. What actually
       * takes the descendants down is ConPTY itself -- closing the pseudoconsole
       * ends everything attached to it, measured for a grandchild as well. M3.5
       * is where a pid that survives all that gets a second, synchronous kill.
       */
      this._child.kill();
    } catch (killed: unknown) {
      this._logger.info('a terminal was killed after it had already ended', {
        terminalId: this.terminalId.value,
        cause: String(killed),
      });
    }
  }

  private _ended(code: number, signal: number | undefined): void {
    if (this._over) {
      return;
    }
    this._over = true;
    this._forget();

    for (const listener of this._exitListeners) {
      listener({ code, signal });
    }
    this._exitListeners.clear();

    // The pair a record is written from. The number survives only when the
    // program finished and said it: under a kill the code belongs to the program
    // rather than to the killing (`claude` 1, `cmd` -1073741510, measured), and
    // passing it through would report a failed launch for every terminal ended
    // while it was still starting.
    const exit = exitVerdict(code, signal, this._cause);
    for (const listener of this._closeListeners) {
      listener(exit);
    }
    this._closeListeners.clear();
  }
}

/**
 * The screen face of a terminal of our own.
 *
 * A separate object because the port is separate: `TerminalScreen` is optional
 * beside a handle, so a consumer may hold this and nothing else. Everything it
 * does is the handle's, which is where the one pty lives.
 */
class PtyTerminalScreen implements TerminalScreen {
  private readonly _handle: PtyTerminalHandle;

  constructor(handle: PtyTerminalHandle) {
    this._handle = handle;
  }

  public write(data: string): void {
    this._handle.write(data);
  }

  public resize(cols: number, rows: number): void {
    this._handle.resize(cols, rows);
  }

  public pause(): void {
    this._handle.pause();
  }

  public resume(): void {
    this._handle.resume();
  }

  public onData(listener: (chunk: string) => void): Disposable {
    return this._handle.onData(listener);
  }

  public onExit(listener: (exit: ScreenExit) => void): Disposable {
    return this._handle.onExit(listener);
  }

  /**
   * Lets the screen go -- which for this engine is the same act as disposing the
   * handle, because there is one pty behind both. Idempotent: a second call is
   * not an error, and `dispose` already answers to a terminal that has ended.
   */
  public dispose(): void {
    this._handle.dispose();
  }
}
