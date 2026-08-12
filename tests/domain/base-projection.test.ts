import {
  BaseProjection,
  HookEventParser,
  InMemoryTerminalRepository,
  SessionRegistry,
  TerminalId,
  TerminalStateMachine,
} from '../../packages/core/src/index';
import type { TerminalEntry, TerminalRepository } from '../../packages/core/src/index';
import { FixedClock, RecordingLogger } from '../helpers/port-fakes';
import { OBSERVED_AT, TERMINAL_UUID, makeEntry, makeOwnerRef } from '../helpers/domain-fixtures';

/**
 * The joint between the base and the list. Everything it does is about a read
 * TAKING TIME -- two of them finishing out of order, one finishing after the
 * window has gone, one failing -- so every test here holds a read open on
 * purpose.
 */

const OTHER = TerminalId.fromString('11111111-2222-4333-8444-555555555555');
const THIRD = TerminalId.fromString('9d5f8e21-4a3b-4c6d-8e7f-0a1b2c3d4e5f');

function foreign(terminalId: TerminalId): TerminalEntry {
  return makeEntry({ terminalId, owner: makeOwnerRef('another-window') });
}

/** A repository whose reads finish when the test says so. */
class HeldRepository implements TerminalRepository {
  public reads = 0;
  public answers: TerminalEntry[][] = [];

  private readonly _pending: (() => void)[] = [];
  private _failWith: Error | null = null;

  public async readAll(): Promise<readonly TerminalEntry[]> {
    const index = this.reads;
    this.reads += 1;
    await new Promise<void>((resolve) => {
      this._pending.push(resolve);
    });
    if (this._failWith !== null) {
      throw this._failWith;
    }
    return this.answers[index] ?? [];
  }

  /** Lets every read so far finish. */
  public async release(): Promise<void> {
    const waiting = this._pending.splice(0, this._pending.length);
    for (const resolve of waiting) {
      resolve();
    }
    // Two turns: one for the read to return, one for the projection to hand it on.
    await Promise.resolve();
    await Promise.resolve();
  }

  public failNext(cause: Error): void {
    this._failWith = cause;
  }

  public async readOwn(): Promise<readonly TerminalEntry[]> {
    throw new Error('not part of this test');
  }

  public async write(): Promise<void> {
    throw new Error('not part of this test');
  }

  public async adopt(): Promise<TerminalEntry> {
    throw new Error('not part of this test');
  }

  public async remove(): Promise<void> {
    throw new Error('not part of this test');
  }

  public watch(): { dispose: () => void } {
    return { dispose: (): void => undefined };
  }
}

interface Stand {
  readonly registry: SessionRegistry;
  readonly logger: RecordingLogger;
  readonly projection: BaseProjection;
}

function stand(repository: TerminalRepository): Stand {
  const logger = new RecordingLogger();
  const registry = new SessionRegistry({
    stateMachine: new TerminalStateMachine(),
    reader: new HookEventParser(),
    clock: new FixedClock(OBSERVED_AT),
    logger,
  });
  return {
    registry,
    logger,
    projection: new BaseProjection({ repository, registry, owner: makeOwnerRef(), logger }),
  };
}

function listed(registry: SessionRegistry): string[] {
  return registry.list().map((entry) => entry.terminalId.value);
}

describe('the base, projected into the list', () => {
  it('reads everything and hands it to the registry', async () => {
    const repository = new InMemoryTerminalRepository(makeOwnerRef('another-window'));
    await repository.write(foreign(OTHER));
    const { registry, projection } = stand(repository);

    await projection.refresh();

    expect(listed(registry)).toStrictEqual([OTHER.value]);
  });

  it('leaves this window own records where they are', async () => {
    // The base is behind by however long the write debounce is (M2.6), so a
    // record we hold must not be replaced by the copy on disk.
    const repository = new InMemoryTerminalRepository(makeOwnerRef());
    await repository.write(makeEntry());
    const { registry, projection } = stand(repository);
    registry.register(makeEntry());

    await projection.refresh();

    expect(listed(registry)).toStrictEqual([TERMINAL_UUID]);
    expect(registry.knows(TerminalId.fromString(TERMINAL_UUID))).toBe(true);
  });
});

describe('two reads at once', () => {
  /*
   * The reason this class has any state at all. Two reads in flight can finish
   * in the other order, and the older answer would then overwrite the newer one
   * -- leaving a list that is wrong with no event left to correct it, which is
   * exactly what the watcher exists to prevent.
   */
  it('never runs two, and runs exactly one more for everything asked meanwhile', async () => {
    const repository = new HeldRepository();
    repository.answers = [[foreign(OTHER)], [foreign(OTHER), foreign(THIRD)]];
    const { registry, projection } = stand(repository);

    const first = projection.refresh();
    await projection.refresh();
    await projection.refresh();
    await projection.refresh();
    expect(repository.reads).toBe(1);

    await repository.release();
    await repository.release();
    await first;

    expect(repository.reads).toBe(2);
    expect(listed(registry)).toStrictEqual([OTHER.value, THIRD.value]);
  });

  it('starts a fresh read for what happens after the last one finished', async () => {
    const repository = new HeldRepository();
    repository.answers = [[foreign(OTHER)], [foreign(THIRD)]];
    const { registry, projection } = stand(repository);
    const first = projection.refresh();
    await repository.release();
    await first;

    const second = projection.refresh();
    await repository.release();
    await second;

    expect(repository.reads).toBe(2);
    expect(listed(registry)).toStrictEqual([THIRD.value]);
  });
});

describe('when the window goes', () => {
  it('drops a read that finished after the window did', async () => {
    const repository = new HeldRepository();
    repository.answers = [[foreign(OTHER)]];
    const { registry, projection } = stand(repository);
    const reading = projection.refresh();

    projection.dispose();
    await repository.release();
    await reading;

    expect(listed(registry)).toStrictEqual([]);
  });
});

describe('when the base cannot be read', () => {
  it('says so and does not throw at the callback that asked', async () => {
    // Its callers are event handlers that nobody awaits: a rejection escaping
    // here is an unhandled one in the extension host, which the person sees as
    // the editor complaining about us.
    const repository = new HeldRepository();
    repository.failNext(new Error('EPERM: the profile is on a network share'));
    const { registry, logger, projection } = stand(repository);
    registry.register(makeEntry());

    const reading = projection.refresh();
    await repository.release();
    await expect(reading).resolves.toBeUndefined();

    expect(logger.errors[0]?.message).toContain('the store could not be read');
    // The window still shows what it holds itself.
    expect(listed(registry)).toStrictEqual([TERMINAL_UUID]);
  });
});

describe('a record this window wrote', () => {
  it('is never taken back from the base, even when the list no longer holds it', async () => {
    // The gap this closes is small and reachable: between a person deleting a
    // record and the removal reaching the files, the record is held by nobody
    // and the base still has it. Without the owner filter a read landing there
    // hands it back as somebody else's terminal, in the window that threw it
    // away.
    const repository = new InMemoryTerminalRepository(makeOwnerRef());
    await repository.write(makeEntry());
    const { registry, projection } = stand(repository);

    await projection.refresh();

    expect(listed(registry)).toStrictEqual([]);
  });

  it('is taken back once another window has adopted it, because it is theirs now', async () => {
    const repository = new InMemoryTerminalRepository(makeOwnerRef('another-window'));
    await repository.write(makeEntry({ owner: makeOwnerRef('another-window') }));
    const { registry, projection } = stand(repository);

    await projection.refresh();

    expect(listed(registry)).toStrictEqual([TERMINAL_UUID]);
  });
});
