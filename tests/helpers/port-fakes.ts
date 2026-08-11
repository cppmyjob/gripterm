import type {
  Clock,
  Disposable,
  ErrorDetails,
  IdGenerator,
  Logger,
  TerminalExit,
  TerminalGateway,
  TerminalHandle,
  TerminalId,
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
 * `dispose()` deliberately does NOT fire the close listeners. Whether the
 * platform raises `onDidCloseTerminal` for a terminal the extension disposed
 * itself has not been measured, and a fake that guessed would make every test
 * built on it agree with the guess. A test that cares about a close says so by
 * calling `close`.
 */
export class FakeTerminalHandle implements TerminalHandle {
  public readonly terminalId: TerminalId;
  public readonly sent: { readonly text: string, readonly execute: boolean }[] = [];
  /** The `preserveFocus` argument of each `show()`, in order. */
  public readonly shownWith: boolean[] = [];
  public disposed = false;

  private readonly _closeListeners = new Set<(exit: TerminalExit) => void>();

  constructor(terminalId: TerminalId) {
    this.terminalId = terminalId;
  }

  public sendText(text: string, execute: boolean): void {
    this.sent.push({ text, execute });
  }

  public show(preserveFocus: boolean): void {
    this.shownWith.push(preserveFocus);
  }

  public dispose(): void {
    this.disposed = true;
  }

  public onDidClose(listener: (exit: TerminalExit) => void): Disposable {
    this._closeListeners.add(listener);
    return {
      dispose: (): void => {
        this._closeListeners.delete(listener);
      },
    };
  }

  /** Drives a close. `undefined` is the person closing it; a number is the process exiting. */
  public close(code: number | undefined): void {
    for (const listener of this._closeListeners) {
      listener({ code });
    }
  }
}

export class InMemoryTerminalGateway implements TerminalGateway {
  public readonly specs: TerminalSpec[] = [];

  private readonly _handles = new Map<string, FakeTerminalHandle>();

  public async create(spec: TerminalSpec): Promise<TerminalHandle> {
    this.specs.push(spec);
    const handle = new FakeTerminalHandle(spec.terminalId);
    this._handles.set(spec.terminalId.value, handle);
    return handle;
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
