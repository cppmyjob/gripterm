import { setImmediate } from 'node:timers';
import {
  BaseWriter,
  DEFAULT_WRITE_DEBOUNCE_MS,
  HookEventParser,
  SessionId,
  SessionRegistry,
  TerminalId,
  TerminalStateMachine,
  describeDetails,
  type HookEventContext,
  type PreToolUseEvent,
  type StopEvent,
  type TerminalEntry,
  type TerminalRepository,
} from '../../packages/core/src/index';
import { FakeScheduler, FixedClock, RecordingLogger } from '../helpers/port-fakes';
import {
  OBSERVED_AT,
  SESSION_UUID,
  TERMINAL_UUID,
  makeEntry,
  makeOwnerRef,
} from '../helpers/domain-fixtures';

/**
 * The writer is the half of M2.6 that decides WHEN, and every rule in it is
 * about a rate: a burst of events becoming one write, a deliberate act not
 * waiting for a burst that is not there, and two writes of one record never
 * being in flight at once. The other half -- what is written -- is in
 * `file-terminal-repository.test.ts`, against a real file system.
 */

const TERMINAL = TerminalId.fromString(TERMINAL_UUID);
const OTHER_UUID = '11111111-2222-4333-8444-555555555555';
const OTHER = TerminalId.fromString(OTHER_UUID);
const SESSION = SessionId.fromString(SESSION_UUID);

const CONTEXT: Omit<HookEventContext, 'sessionId'> = {
  promptId: null,
  cwd: null,
  transcriptPath: null,
};

function preToolUse(toolName: string): PreToolUseEvent {
  return { kind: 'PreToolUse', sessionId: SESSION, toolName, toolUseId: 'tu-1', ...CONTEXT };
}

function turnEnded(lastAssistantMessage: string | null): StopEvent {
  return { kind: 'Stop', sessionId: SESSION, lastAssistantMessage, ...CONTEXT };
}

/**
 * Lets every microtask that is ready run.
 *
 * Nothing under test here uses a real timer -- the scheduler is a fake -- so one
 * turn of the event loop drains the whole write pass, however many awaits deep
 * it went. Counting `Promise.resolve()`s instead would be a number that quietly
 * stops being enough.
 */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/** A store that records what it was given, and can be held open or made to fail. */
class SlowStore implements TerminalRepository {
  public readonly written: TerminalEntry[] = [];
  /** Records this store was told to discard, in the order it was told. */
  public readonly removed: TerminalId[] = [];
  public attempts = 0;
  public inFlight = 0;
  /** The most that were ever in flight together. Anything above one is a lost ordering. */
  public peak = 0;

  private readonly _waiting: (() => void)[] = [];
  private _held = false;
  private _failWith: Error | null = null;

  public async write(entry: TerminalEntry): Promise<void> {
    await this._visit(() => {
      this.written.push(entry);
    });
  }

  /**
   * Held and failed by the same switches as `write`, because the writer's rules
   * about ordering and about failure are not two rules -- a deletion that
   * overtook a write would leave the record on disk with nothing left to remove
   * it.
   */
  public async remove(id: TerminalId): Promise<void> {
    await this._visit(() => {
      this.removed.push(id);
    });
  }

  /** From here on, writes wait for `release`. */
  public hold(): void {
    this._held = true;
  }

  public async release(): Promise<void> {
    this._held = false;
    for (const resolve of this._waiting.splice(0, this._waiting.length)) {
      resolve();
    }
    await settle();
  }

  public failWith(cause: Error): void {
    this._failWith = cause;
  }

  public forget(): void {
    this.written.length = 0;
    this.removed.length = 0;
    this.attempts = 0;
  }

  public async readOwn(): Promise<readonly TerminalEntry[]> {
    throw new Error('not part of this test');
  }

  public async readAll(): Promise<readonly TerminalEntry[]> {
    throw new Error('not part of this test');
  }

  public async adopt(): Promise<TerminalEntry> {
    throw new Error('not part of this test');
  }

  public watch(): { dispose: () => void } {
    return { dispose: (): void => undefined };
  }

  private async _visit(land: () => void): Promise<void> {
    this.attempts += 1;
    this.inFlight += 1;
    this.peak = Math.max(this.peak, this.inFlight);
    try {
      if (this._held) {
        await new Promise<void>((resolve) => {
          this._waiting.push(resolve);
        });
      }
      if (this._failWith !== null) {
        throw this._failWith;
      }
      land();
    } finally {
      this.inFlight -= 1;
    }
  }

}

interface Stand {
  readonly registry: SessionRegistry;
  readonly store: SlowStore;
  readonly scheduler: FakeScheduler;
  readonly logger: RecordingLogger;
  readonly writer: BaseWriter;
}

function stand(debounceMs?: number): Stand {
  const logger = new RecordingLogger();
  const registry = new SessionRegistry({
    stateMachine: new TerminalStateMachine(),
    reader: new HookEventParser(),
    clock: new FixedClock(OBSERVED_AT),
    logger,
  });
  const store = new SlowStore();
  const scheduler = new FakeScheduler();
  const writer = new BaseWriter({
    repository: store,
    registry,
    scheduler,
    logger,
    ...(debounceMs === undefined ? {} : { debounceMs }),
  });
  return { registry, store, scheduler, logger, writer };
}

function ids(entries: readonly TerminalEntry[]): string[] {
  return entries.map((entry) => entry.terminalId.value);
}

describe('what this window makes of its own records', () => {
  it('writes a registration at once, without waiting for anything', async () => {
    // A terminal created and not yet written is a terminal the next activation
    // cannot restore, and the burst this debounce exists for is not happening:
    // a person creates terminals at human speed.
    const { registry, store, scheduler, writer } = stand();
    writer.start();

    registry.register(makeEntry());
    await settle();

    expect(ids(store.written)).toStrictEqual([TERMINAL_UUID]);
    expect(scheduler.armed).toStrictEqual([]);
  });

  it('takes what the registry already held when it started', async () => {
    // So that "compose the writer before the first terminal" is a property of
    // the class rather than a rule the composition root has to keep.
    const { registry, store, writer } = stand();
    registry.register(makeEntry());
    expect(store.written).toStrictEqual([]);

    writer.start();
    await settle();

    expect(ids(store.written)).toStrictEqual([TERMINAL_UUID]);
  });

  it('subscribes once, however often it is started', async () => {
    const { registry, store, writer } = stand();
    writer.start();
    writer.start();

    registry.register(makeEntry());
    await settle();

    expect(store.attempts).toBe(1);
  });
});

describe('a burst of events', () => {
  it('becomes one write, of the last state and not the first', async () => {
    const { registry, store, scheduler, writer } = stand();
    writer.start();
    registry.register(makeEntry());
    await settle();
    store.forget();

    registry.ingest(TERMINAL, preToolUse('Edit'));
    registry.ingest(TERMINAL, preToolUse('Bash'));
    registry.ingest(TERMINAL, turnEnded('all done'));
    await settle();

    // Nothing yet: the deadline was set by the first of the three.
    expect(store.attempts).toBe(0);
    expect(scheduler.armed).toHaveLength(1);
    expect(scheduler.armed[0]?.ms).toBe(DEFAULT_WRITE_DEBOUNCE_MS);

    scheduler.elapse();
    await settle();

    expect(store.attempts).toBe(1);
    expect(store.written[0]?.observed.state).toBe('idle');
    expect(store.written[0]?.observed.lastAssistantMessage).toBe('all done');
  });

  it('does not push the deadline back, so it fires while the burst is still going', async () => {
    // The measured storm of M2.5 is why: a resetting debounce goes quiet exactly
    // when the store is changing fastest, which is when other windows most need
    // to be told.
    const { registry, store, scheduler, writer } = stand();
    writer.start();
    registry.register(makeEntry());
    await settle();

    for (let event = 0; event < 20; event += 1) {
      registry.ingest(TERMINAL, preToolUse('Edit'));
    }
    await settle();

    expect(scheduler.armed).toHaveLength(1);
    expect(store.attempts).toBe(1);
  });

  it('waits the interval it was given rather than the default one', async () => {
    const { registry, scheduler, writer } = stand(50);
    writer.start();
    registry.register(makeEntry());
    await settle();

    registry.ingest(TERMINAL, preToolUse('Edit'));

    expect(scheduler.armed[0]?.ms).toBe(50);
  });

  it('is written straight away when something deliberate happens meanwhile', async () => {
    // A close is not a thing to keep waiting, and the pass it triggers has no
    // reason to leave another terminal's pending state behind.
    const { registry, store, scheduler, writer } = stand();
    writer.start();
    registry.register(makeEntry());
    registry.register(makeEntry({ terminalId: OTHER }));
    await settle();
    store.forget();

    registry.ingest(TERMINAL, preToolUse('Edit'));
    expect(scheduler.live).toHaveLength(1);

    registry.amend(makeEntry({ terminalId: OTHER }).withClosed(OBSERVED_AT, 'person'));
    await settle();

    expect(ids(store.written).sort()).toStrictEqual([OTHER_UUID, TERMINAL_UUID].sort());
    // Cancelled rather than left to fire on an empty queue.
    expect(scheduler.live).toStrictEqual([]);
  });
});

describe('two writes of one record', () => {
  it('never run at once, and the newer state is the one left on disk', async () => {
    // Not about the cost of the second write. Two in flight can finish in the
    // other order, and the older state would then be what the store keeps, with
    // no event remaining to correct it.
    const { registry, store, writer } = stand();
    writer.start();
    store.hold();

    registry.register(makeEntry());
    await settle();
    expect(store.inFlight).toBe(1);

    registry.ingest(TERMINAL, preToolUse('Edit'));
    registry.ingest(TERMINAL, turnEnded('all done'));
    await settle();
    expect(store.peak).toBe(1);

    await store.release();

    expect(store.written).toHaveLength(2);
    expect(store.written[1]?.observed.state).toBe('idle');
  });
});

describe('records other windows own', () => {
  it('are not written back, whatever the projection says', async () => {
    // We are not their writer (§4.8), and writing one back would be a loop with
    // no exit: our write wakes our own watcher, the watcher re-reads, the
    // re-read replaces the projection, and round it goes.
    const { registry, store, scheduler, writer } = stand();
    writer.start();

    registry.replaceForeign([makeEntry({ owner: makeOwnerRef('another-window') })]);
    await settle();

    expect(store.attempts).toBe(0);
    expect(scheduler.armed).toStrictEqual([]);
  });
});

describe('an event refused as belonging to a conversation the record never had', () => {
  it('is not a write, because nothing about the record moved', async () => {
    // The shape this guards against is a stranded terminal (M2.8): every event
    // of a conversation nobody announced is refused, and a writer that queued
    // the record anyway would put the same bytes back on the disk for each of
    // them -- waking every other window's watcher, once per keystroke, to
    // announce that nothing had happened.
    const { registry, store, scheduler, writer } = stand();
    writer.start();
    registry.register(makeEntry());
    await settle();
    store.forget();

    registry.ingest(TERMINAL, {
      kind: 'Stop',
      sessionId: SessionId.fromString('7f4d2a1c-5b6e-4c8a-9d0f-1a2b3c4d5e6f'),
      lastAssistantMessage: null,
      ...CONTEXT,
    });
    await settle();

    expect(store.attempts).toBe(0);
    expect(scheduler.armed).toStrictEqual([]);
  });
});

describe('when the store refuses a write', () => {
  it('says which terminal and why, and does not try again', async () => {
    // A retry loop would meet a full disk with one attempt every half second for
    // the life of the window. The next change to this terminal queues it again,
    // carrying a newer state than the one that failed.
    const { registry, store, logger, writer } = stand();
    writer.start();
    store.failWith(new Error('ENOSPC: no space left on device'));

    registry.register(makeEntry());
    await settle();

    expect(store.attempts).toBe(1);
    expect(logger.errors[0]?.message).toContain('could not be written to the store');
    expect(logger.errors[0]?.details?.terminalId).toBe(TERMINAL_UUID);
    expect(String(logger.errors[0]?.details?.cause)).toContain('ENOSPC');
  });

  /*
   * The half of a failure a person cannot see, and the reason this line was
   * changed rather than added to (Ш3).
   *
   * `String(cause)` renders the sentence and drops everything else: no `code`,
   * no stack, no chain. `code` is what every branch in this build that reacts to
   * a file system failure reads, so a log written from the string cannot be
   * compared against the decision the code took -- a full disk and a locked
   * file arrive looking like the same kind of sentence.
   */
  it('carries the failure itself, so its code and its stack reach the log', async () => {
    const { registry, store, logger, writer } = stand();
    writer.start();
    store.failWith(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));

    registry.register(makeEntry());
    await settle();

    const rendered = describeDetails(logger.errors[0]?.details);
    expect(rendered).toContain('"code":"ENOSPC"');
    expect(rendered).toContain('"stack":');
    expect(rendered).toContain('no space left on device');
  });
});

describe('when the window goes', () => {
  it('writes what was still waiting for the debounce', async () => {
    // The last thing that happens to a terminal is its close, and a window that
    // left without writing it leaves a record claiming to be at work on a tool
    // that stopped when the editor did.
    const { registry, store, scheduler, writer } = stand();
    writer.start();
    registry.register(makeEntry());
    await settle();
    store.forget();

    registry.ingest(TERMINAL, turnEnded('all done'));
    expect(store.attempts).toBe(0);

    await writer.stop();

    expect(ids(store.written)).toStrictEqual([TERMINAL_UUID]);
    expect(scheduler.live).toStrictEqual([]);
  });

  it('waits for a write that was already in flight', async () => {
    const { registry, store, writer } = stand();
    writer.start();
    store.hold();
    registry.register(makeEntry());
    await settle();

    let finished = false;
    const stopping = writer.stop().then(() => {
      finished = true;
    });
    await settle();
    expect(finished).toBe(false);

    await store.release();
    await stopping;

    expect(finished).toBe(true);
    expect(ids(store.written)).toStrictEqual([TERMINAL_UUID]);
  });

  it('stops listening, so nothing that happens afterwards is written', async () => {
    const { registry, store, scheduler, writer } = stand();
    writer.start();
    registry.register(makeEntry());
    await settle();
    store.forget();

    await writer.stop();
    // Both kinds, and the deliberate one first, because it is the one that
    // proves anything. An event alone would leave a writer that is still
    // listening looking exactly like one that is not: it would arm a timer that
    // this scheduler never fires, and the test would pass on the silence.
    registry.amend(makeEntry().withClosed(OBSERVED_AT, 'person'));
    registry.ingest(TERMINAL, turnEnded(null));
    await settle();

    expect(store.attempts).toBe(0);
    expect(scheduler.armed).toStrictEqual([]);
  });

  it('is safe to stop without having been started, and to stop twice', async () => {
    // It runs from `deactivate`, which is called on paths this class cannot see:
    // an activation that failed halfway, a reload during startup.
    const { store, writer } = stand();

    await writer.stop();
    await writer.stop();

    expect(store.attempts).toBe(0);
  });

  it('cancels a waiting write when disposed, and does not come back', async () => {
    const { registry, store, scheduler, writer } = stand();
    writer.start();
    registry.register(makeEntry());
    await settle();
    store.forget();
    registry.ingest(TERMINAL, preToolUse('Edit'));
    expect(scheduler.live).toHaveLength(1);

    writer.dispose();
    writer.dispose();
    expect(scheduler.live).toStrictEqual([]);

    // A disposed writer does not start again: the window it belonged to is gone.
    writer.start();
    registry.register(makeEntry({ terminalId: OTHER }));
    await settle();

    expect(store.attempts).toBe(0);
  });
});

describe('a record the person threw away', () => {
  it('is discarded from the store at once, without waiting for the debounce', async () => {
    const { registry, store, scheduler, writer } = stand();
    registry.register(makeEntry());
    writer.start();
    await settle();
    store.forget();

    registry.forget(TERMINAL);
    await settle();

    expect(ids(store.written)).toStrictEqual([]);
    expect(store.removed.map((id) => id.value)).toStrictEqual([TERMINAL_UUID]);
    // Nothing left waiting: a deletion is a deliberate act and there is no
    // burst of them to absorb.
    expect(scheduler.live).toStrictEqual([]);
  });

  it('replaces a write of the same record that was still waiting its turn', async () => {
    // The queue holds one thing per terminal, so the only question is which
    // thing. A record stored after it was deleted is a row that comes back.
    const { registry, store, scheduler, writer } = stand();
    registry.register(makeEntry());
    writer.start();
    await settle();
    store.forget();

    registry.ingest(TERMINAL, preToolUse('Bash'));
    expect(scheduler.live).toHaveLength(1);

    registry.forget(TERMINAL);
    await settle();

    expect(ids(store.written)).toStrictEqual([]);
    expect(store.removed.map((id) => id.value)).toStrictEqual([TERMINAL_UUID]);
    // The waiting deadline is cancelled rather than left to fire on a queue the
    // deletion has already emptied.
    expect(scheduler.live).toStrictEqual([]);
  });

  it('does not overtake a write already in flight', async () => {
    const { registry, store, writer } = stand();
    registry.register(makeEntry());
    writer.start();
    store.hold();
    registry.register(makeEntry({ terminalId: OTHER }));

    registry.forget(TERMINAL);
    await store.release();
    await settle();

    expect(store.peak).toBe(1);
    expect(store.removed.map((id) => id.value)).toStrictEqual([TERMINAL_UUID]);
  });

  it('says so when the store refuses, and does not try again', async () => {
    const { registry, store, logger, writer } = stand();
    registry.register(makeEntry());
    writer.start();
    await settle();
    store.forget();
    store.failWith(new Error('EBUSY'));

    registry.forget(TERMINAL);
    await settle();

    expect(store.attempts).toBe(1);
    expect(store.removed).toStrictEqual([]);
    // The consequence is the opposite of a failed write, so it has its own
    // sentence: the record is still there, not missing.
    expect(logger.errors.at(-1)?.message).toContain('still in the store');
    expect(logger.errors.at(-1)?.details?.terminalId).toBe(TERMINAL_UUID);
  });

  it('is discarded by `stop`, when the window went before the pass ran', async () => {
    const { registry, store, writer } = stand();
    registry.register(makeEntry());
    writer.start();
    await settle();
    store.forget();
    store.hold();

    registry.forget(TERMINAL);
    const stopped = writer.stop();
    await store.release();
    await stopped;

    expect(store.removed.map((id) => id.value)).toStrictEqual([TERMINAL_UUID]);
  });
});
