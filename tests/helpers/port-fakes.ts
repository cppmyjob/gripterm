import type {
  Clock,
  Disposable,
  ErrorDetails,
  IdGenerator,
  Logger,
  Scheduler,
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
 * `dispose()` DOES fire the close listeners, with no exit code. That is not a
 * convenience: it is A15, measured on 2026-08-11 in a real VS Code 1.132.0 by
 * the integration suite, after being carried as an open question since M1.5.
 * The platform reports a terminal we destroyed ourselves exactly as it reports
 * one a person closed -- `exitStatus.code` is `undefined` either way -- so the
 * lifecycle service (M1.12) cannot tell the two apart from the event and must
 * know from the intent it acted on.
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
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.close(undefined);
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
