import type {
  Clock,
  Disposable,
  ErrorDetails,
  IdGenerator,
  Logger,
  Scheduler,
  ScreenExit,
  TerminalEngine,
  TerminalExit,
  TerminalExitReason,
  TerminalGateway,
  TerminalHandle,
  TerminalId,
  TerminalScreen,
  TerminalSpec,
} from '../../packages/core/src/index';

/**
 * Test doubles for the ports whose real implementation is not `packages/core`'s
 * to provide: the editor's terminals, the system clock and the system's random
 * ids. They live here rather than in `src/` because `packages/core` is consumed
 * as CommonJS and esbuild cannot tree-shake it -- anything exported from the
 * core index ships inside the extension bundle, test doubles included.
 *
 * `InMemoryTerminalRepository` and `InMemoryOwnerPresence` are NOT here: those
 * two are what M1 actually runs on.
 */

/** A clock that only moves when a test says so. */
export class FixedClock implements Clock {
  private _nowMs: number;

  constructor(at: Date) {
    this._nowMs = at.getTime();
  }

  public now(): Date {
    return new Date(this._nowMs);
  }

  public advance(ms: number): void {
    this._nowMs += ms;
  }
}

/** One waiting call, as `FakeScheduler` keeps it. */
export interface ArmedTimer {
  ms: number;
  action: () => void;
  cancelled: boolean;
}

/**
 * A scheduler a test drives by hand: nothing runs until it is told to run.
 *
 * Here rather than beside its first test because there are two consumers now --
 * `ObservabilityWatch` and `RepositoryWatcher` -- and a second copy of a fake is
 * a second answer to "what does `after` promise". They would drift where nobody
 * looks: one of them cancelling on dispose and the other not.
 */
export class FakeScheduler implements Scheduler {
  public readonly armed: ArmedTimer[] = [];

  public get live(): ArmedTimer[] {
    return this.armed.filter((timer) => !timer.cancelled);
  }

  public after(ms: number, action: () => void): Disposable {
    const timer = { ms, action, cancelled: false };
    this.armed.push(timer);
    return {
      dispose: (): void => {
        timer.cancelled = true;
      },
    };
  }

  /** Lets the wait expire. Throws rather than passing silently if nothing is waiting. */
  public elapse(): void {
    const timer = this.live[0];
    if (timer === undefined) {
      throw new Error('nothing was waiting');
    }
    timer.cancelled = true;
    timer.action();
  }
}

/**
 * Ids that are valid, distinct and readable in a failure message.
 *
 * A fake rather than a stub: it keeps working however many ids are drawn, where
 * `stubIdGenerator` hands out a written-down list and refuses past its end.
 * Both exist because they answer different questions -- this one "does the code
 * cope with a stream of ids", that one "what does it do with exactly this id,
 * including a malformed one".
 */
export class SequentialIdGenerator implements IdGenerator {
  private _issued = 0;

  public newUuid(): string {
    this._issued += 1;
    return `00000000-0000-4000-8000-${this._issued.toString(16).padStart(12, '0')}`;
  }
}

/**
 * A terminal that records what was done to it.
 *
 * `dispose()` DOES fire the close listeners, with no exit code and the reason
 * `extension`. Neither half is a convenience: both are measured in a real VS
 * Code by the integration suite -- the missing code is A15 (2026-08-11), which
 * is why the lifecycle service cannot read intent out of the code and has to
 * know it from what it acted on; the reason is A29 (2026-08-13), which is how
 * the platform separates our own dispose from the person's own close.
 */
export class FakeTerminalHandle implements TerminalHandle {
  public readonly terminalId: TerminalId;
  public readonly sent: { readonly text: string, readonly execute: boolean }[] = [];
  /** Every launch line this terminal was asked to run, in order. */
  public readonly launched: string[] = [];
  /** The `preserveFocus` argument of each `show()`, in order. */
  public readonly shownWith: boolean[] = [];
  /** Every name the tab was asked to take, in order. */
  public readonly renamedTo: string[] = [];
  public disposed = false;
  /** What the editor will say the terminal's process is, or `null` for a platform that does not know. */
  public pid: number | null = null;

  private readonly _closeListeners = new Set<(exit: TerminalExit) => void>();
  /** The resolver of a held `processId()`, so a test can decide what arrives first. */
  private _release: (() => void) | null = null;
  private _holding = false;

  constructor(terminalId: TerminalId) {
    this.terminalId = terminalId;
  }

  public async processId(): Promise<number | null> {
    if (this._holding) {
      await new Promise<void>((resolve) => {
        this._release = resolve;
      });
    }
    return this.pid;
  }

  /** Makes the next `processId()` wait until `releasePid`. */
  public holdPid(): void {
    this._holding = true;
  }

  public releasePid(): void {
    this._holding = false;
    const waiting = this._release;
    this._release = null;
    waiting?.();
  }

  public sendText(text: string, execute: boolean): void {
    this.sent.push({ text, execute });
  }

  /**
   * Recorded apart from `sent`, because the port promises something different
   * about it: the launch line comes after whatever the environment does to a
   * fresh shell (M2.25). A test that could not tell the two apart could not tell
   * a launch from a `/rename` typed into a running agent.
   */
  public runLaunchCommand(commandLine: string): void {
    this.launched.push(commandLine);
  }

  public show(preserveFocus: boolean): void {
    this.shownWith.push(preserveFocus);
  }

  public rename(name: string): void {
    this.renamedTo.push(name);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.close(undefined, 'extension');
  }

  public onDidClose(listener: (exit: TerminalExit) => void): Disposable {
    this._closeListeners.add(listener);
    return {
      dispose: (): void => {
        this._closeListeners.delete(listener);
      },
    };
  }

  /**
   * Drives a close: `undefined` is a terminal nothing exited inside, a number is
   * the process's own exit.
   *
   * The reason is required rather than defaulted, and that is the point of it
   * being here at all. Since A29 the answer to "does this record come back" is
   * read off this field, so a test that did not state who ended the terminal
   * would be a test asserting a rule it never chose an input for.
   */
  public close(code: number | undefined, reason: TerminalExitReason): void {
    for (const listener of this._closeListeners) {
      listener({ code, reason });
    }
  }
}

export class InMemoryTerminalGateway implements TerminalGateway {
  public readonly specs: TerminalSpec[] = [];
  /** The pid every terminal this gateway creates will report. */
  public pid: number | null = null;
  /**
   * Which engine this gateway claims to be. Settable, because the whole point of
   * the field on the port is that the record repeats THIS and not a setting.
   */
  public engine: TerminalEngine = 'editor';

  private readonly _handles = new Map<string, FakeTerminalHandle>();
  private _holdPids = false;

  public async create(spec: TerminalSpec): Promise<TerminalHandle> {
    this.specs.push(spec);
    const handle = new FakeTerminalHandle(spec.terminalId);
    handle.pid = this.pid;
    if (this._holdPids) {
      handle.holdPid();
    }
    this._handles.set(spec.terminalId.value, handle);
    return handle;
  }

  /** Every terminal created from now on holds its pid back until `releasePid`. */
  public holdPid(): void {
    this._holdPids = true;
  }

  public releasePid(): void {
    this._holdPids = false;
    for (const handle of this._handles.values()) {
      handle.releasePid();
    }
  }

  public listKnown(): readonly TerminalHandle[] {
    return [...this._handles.values()];
  }

  /** The handle a test needs in order to drive a close or read what was sent. */
  public handleFor(terminalId: TerminalId): FakeTerminalHandle {
    const handle = this._handles.get(terminalId.value);
    if (handle === undefined) {
      throw new Error(`the gateway never created a terminal ${terminalId.value}`);
    }
    return handle;
  }

  /** Forgets a terminal, as the editor does once it is gone. */
  public forget(terminalId: TerminalId): void {
    this._handles.delete(terminalId.value);
  }
}

/**
 * A terminal's byte channel with no pty behind it: a test writes into it, makes
 * it produce output, and ends it.
 *
 * Here rather than in `packages/core/src` on purpose, and the reason is the one
 * already stated at the top of this file: the core index is consumed as
 * CommonJS and esbuild cannot tree-shake it, so anything exported from there
 * ships inside the extension bundle. `InMemoryTerminalRepository` earns its
 * place there by being what the product actually runs on; a screen with no
 * process behind it never is, and would travel to every user as dead weight.
 *
 * It answers `over` the way a real one does rather than the way a fake finds
 * convenient: after the process has ended, `write` and `resize` are IGNORED and
 * not thrown out of. That is not politeness -- measured 2026-08-17 (M3.2 stage
 * B, §8), node-pty throws `Cannot resize a pty that has already exited`, and a
 * pty exits on its own schedule, so every caller that had to check first would
 * be checking in a race it cannot win.
 */
export class InMemoryTerminalScreen implements TerminalScreen {
  /** Everything written towards the process, in order. */
  public readonly written: string[] = [];
  /** Every size the screen was told to take, in order. */
  public readonly sizes: { readonly cols: number, readonly rows: number }[] = [];
  public disposed = false;

  private readonly _dataListeners = new Set<(chunk: string) => void>();
  private readonly _exitListeners = new Set<(exit: ScreenExit) => void>();
  private _over = false;

  public write(data: string): void {
    if (this._over) {
      return;
    }
    this.written.push(data);
  }

  public resize(cols: number, rows: number): void {
    if (this._over) {
      return;
    }
    this.sizes.push({ cols, rows });
  }

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

  public dispose(): void {
    this.disposed = true;
    this._over = true;
    this._dataListeners.clear();
    this._exitListeners.clear();
  }

  /** Drives output, as the process behind a real screen would. */
  public emit(chunk: string): void {
    if (this._over) {
      return;
    }
    for (const listener of this._dataListeners) {
      listener(chunk);
    }
  }

  /** Ends the process behind the screen. Reports once however often it is called. */
  public end(exit: ScreenExit): void {
    if (this._over) {
      return;
    }
    this._over = true;
    for (const listener of this._exitListeners) {
      listener(exit);
    }
  }
}

/** Keeps every line, so a test can ask what was said rather than watch a console. */
export class RecordingLogger implements Logger {
  public readonly infos: LoggedLine[] = [];
  public readonly warnings: LoggedLine[] = [];
  public readonly errors: LoggedLine[] = [];

  public info(message: string, details?: ErrorDetails): void {
    this.infos.push({ message, details });
  }

  public warn(message: string, details?: ErrorDetails): void {
    this.warnings.push({ message, details });
  }

  public error(message: string, details?: ErrorDetails): void {
    this.errors.push({ message, details });
  }
}

export interface LoggedLine {
  readonly message: string;
  readonly details: ErrorDetails | undefined;
}
