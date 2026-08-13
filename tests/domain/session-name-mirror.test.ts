import {
  HookEventParser,
  ObservedState,
  SessionId,
  SessionNameMirror,
  SessionRegistry,
  TerminalId,
  TerminalStateMachine,
} from '../../packages/core/src/index';
import { FakeScheduler, FixedClock, RecordingLogger } from '../helpers/port-fakes';
import { OBSERVED_AT, TERMINAL_UUID, makeEntry, makeOwnerRef } from '../helpers/domain-fixtures';
import type { PersistedTerminalState, TerminalEntry } from '../../packages/core/src/index';

const OTHER_TERMINAL = '7f14d5f0-6b1a-4c2e-9d3f-8a7b6c5d4e3f';
const OTHER_SESSION = '2c9a1b34-5d6e-4f70-8192-a3b4c5d6e7f8';

const PID = 17_100;
const OTHER_PID = 4242;

/** Lets every pending microtask run: the timer's action is not awaitable. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function observed(state: PersistedTerminalState, pid: number | null): ObservedState {
  return ObservedState.create({
    state,
    lastEventAt: OBSERVED_AT,
    currentTool: null,
    lastAssistantMessage: null,
    cost: null,
    contextWindow: null,
    pid,
  });
}

interface Stand {
  readonly registry: SessionRegistry;
  readonly logger: RecordingLogger;
  readonly scheduler: FakeScheduler;
  readonly mirror: SessionNameMirror;
  /** What the CLI will say, by pid. Absent means "the file says nothing a person typed". */
  readonly names: Map<number, string>;
  /** Pids whose file cannot be read at all. */
  readonly broken: Set<number>;
  /** What the conversation itself was told to call itself, in order. */
  readonly told: { readonly terminalId: string, readonly name: string }[];
  /** Runs an action inside the next read, while the pass is in flight. */
  readonly whileReading: (action: () => void) => void;
  /** Makes the conversation stop taking what it is told, as a busy prompt box would. */
  readonly deafen: () => void;
  readonly asked: number[];
  readonly nameOf: (id?: string) => string;
  readonly held: (id?: string) => TerminalEntry;
}

function stand(
  entry: TerminalEntry = makeEntry({ observed: observed('idle', PID) }),
  intervalMs?: number
): Stand {
  const logger = new RecordingLogger();
  const registry = new SessionRegistry({
    stateMachine: new TerminalStateMachine(),
    reader: new HookEventParser(),
    clock: new FixedClock(OBSERVED_AT),
    logger,
  });
  registry.register(entry);

  const names = new Map<number, string>();
  const broken = new Set<number>();
  const told: { readonly terminalId: string, readonly name: string }[] = [];
  let meanwhile: (() => void) | null = null;
  let deaf = false;
  const asked: number[] = [];
  const scheduler = new FakeScheduler();
  const mirror = new SessionNameMirror({
    registry,
    scheduler,
    logger,
    ...(intervalMs === undefined ? {} : { intervalMs }),
    tell: (terminalId: TerminalId, name: string): void => {
      told.push({ terminalId: terminalId.value, name });
      // The conversation takes the name the moment it is told, which is what a
      // real `/rename` does -- the next pass then reads it back. Unless it is
      // deaf: the line can land in a prompt box that was not empty, and then
      // nothing happens at all.
      if (!deaf) {
        names.set(PID, name);
      }
    },
    read: async (pid: number): Promise<string | null> => {
      asked.push(pid);
      if (meanwhile !== null) {
        const action = meanwhile;
        meanwhile = null;
        action();
      }
      if (broken.has(pid)) {
        throw new Error('the sessions directory is not readable');
      }
      return await Promise.resolve(names.get(pid) ?? null);
    },
  });

  const held = (id: string = TERMINAL_UUID): TerminalEntry => {
    const entryNow = registry.get(TerminalId.fromString(id));
    if (entryNow === undefined) {
      throw new Error(`there is no record ${id}`);
    }
    return entryNow;
  };

  return {
    registry,
    logger,
    scheduler,
    mirror,
    names,
    broken,
    told,
    whileReading: (action: () => void): void => {
      meanwhile = action;
    },
    deafen: (): void => {
      deaf = true;
    },
    asked,
    held,
    nameOf: (id: string = TERMINAL_UUID): string => held(id).metadata.displayName,
  };
}

describe('following a conversation renamed inside Claude Code', () => {
  it('puts the name a person typed on the row', async () => {
    const world = stand();
    world.names.set(PID, 'Test 1');

    await world.mirror.pass();

    expect(world.nameOf()).toBe('Test 1');
  });

  it('says so in the log, because the row changed without anybody pressing anything here', async () => {
    const world = stand();
    world.names.set(PID, 'Test 1');

    await world.mirror.pass();

    expect(world.logger.infos.some((line) => line.message.includes('renamed'))).toBe(true);
  });

  it('does it once, however many times it looks', async () => {
    const world = stand();
    world.names.set(PID, 'Test 1');
    await world.mirror.pass();

    const changes: unknown[] = [];
    world.registry.subscribe((change) => changes.push(change));
    await world.mirror.pass();

    expect(changes).toHaveLength(0);
  });

  it('leaves alone a name the person gave here afterwards', async () => {
    // The CLI forgets a name when the conversation is resumed and never learns
    // ours, so the two can disagree for the rest of the terminal's life. The
    // last person to type wins, and typing in our own list is typing.
    const world = stand();
    world.names.set(PID, 'Test 1');
    await world.mirror.pass();

    const entry = world.held();
    world.registry.amend(entry.withMetadata(entry.metadata.withDisplayName('mine')));
    await world.mirror.pass();

    expect(world.nameOf()).toBe('mine');
  });

  it('follows a second rename, because that is a person typing again', async () => {
    const world = stand();
    world.names.set(PID, 'Test 1');
    await world.mirror.pass();
    world.names.set(PID, 'Test 2');

    await world.mirror.pass();

    expect(world.nameOf()).toBe('Test 2');
  });

  it('asks nothing about a record another window owns', async () => {
    const world = stand();
    world.registry.replaceForeign([
      makeEntry({
        terminalId: TerminalId.fromString(OTHER_TERMINAL),
        owner: makeOwnerRef('window-activation-2'),
        observed: observed('idle', OTHER_PID),
      }),
    ]);

    await world.mirror.pass();

    expect(world.asked).toEqual([PID]);
  });

  it('asks nothing about a record with no process on it', async () => {
    const world = stand(makeEntry({ observed: observed('idle', null) }));

    await world.mirror.pass();

    expect(world.asked).toEqual([]);
  });

  it('asks nothing about a conversation that is over', async () => {
    // The pid of a finished terminal belongs to somebody else by now, and the
    // row is not going to be looked at again.
    const world = stand(makeEntry({ observed: observed('ended', PID) }));

    await world.mirror.pass();

    expect(world.asked).toEqual([]);
  });

  it('changes nothing when the file says nothing a person typed', async () => {
    const world = stand();

    await world.mirror.pass();

    expect(world.nameOf()).toBe('auth-refactor');
  });

  it('keeps going when one file cannot be read at all', async () => {
    const world = stand();
    world.broken.add(PID);
    world.registry.register(
      makeEntry({
        terminalId: TerminalId.fromString(OTHER_TERMINAL),
        sessionId: SessionId.fromString(OTHER_SESSION),
        observed: observed('idle', OTHER_PID),
      })
    );
    world.names.set(OTHER_PID, 'the other one');

    await world.mirror.pass();

    expect(world.nameOf(OTHER_TERMINAL)).toBe('the other one');
    expect(world.logger.warnings.some((line) => line.message.includes('name'))).toBe(true);
  });

  it('looks again after the wait, for as long as the window lives', async () => {
    const world = stand();
    world.mirror.start();
    world.names.set(PID, 'Test 1');

    world.scheduler.elapse();
    await flush();

    expect(world.nameOf()).toBe('Test 1');
    expect(world.scheduler.live).toHaveLength(1);
  });

  it('waits the interval it was given, when it was given one', () => {
    const world = stand(undefined, 500);
    world.mirror.start();

    expect(world.scheduler.live.map((timer) => timer.ms)).toEqual([500]);
  });

  it('arms one wait however many times it is told to start', () => {
    const world = stand();
    world.mirror.start();
    world.mirror.start();

    expect(world.scheduler.live).toHaveLength(1);
  });

  it('does not start again once it has been disposed of', () => {
    const world = stand();
    world.mirror.dispose();

    world.mirror.start();

    expect(world.scheduler.live).toHaveLength(0);
  });

  it('goes on looking after a pass that broke', async () => {
    // The reader promises a name a record can take; one that breaks that promise
    // is our own mistake, and a window that quietly stopped watching after it
    // would be a feature that ends with nothing said.
    const world = stand();
    world.names.set(PID, '   ');
    world.mirror.start();

    world.scheduler.elapse();
    await flush();

    expect(world.scheduler.live).toHaveLength(1);
  });

  it('writes nothing when the CLI already calls it what the row does', async () => {
    const world = stand();
    world.names.set(PID, 'auth-refactor');
    const changes: unknown[] = [];
    world.registry.subscribe((change) => changes.push(change));

    await world.mirror.pass();

    expect(changes).toHaveLength(0);
  });

  it('writes nothing when the record goes while its file is being read', async () => {
    const world = stand();
    world.names.set(PID, 'Test 1');
    const gone = new Promise<void>((resolve) => {
      world.registry.subscribe((change) => {
        if (change.kind === 'removed') {
          resolve();
        }
      });
    });

    // The read is where the await is, so this is the whole of the race, made
    // deterministic.
    world.registry.forget(TerminalId.fromString(TERMINAL_UUID));
    await gone;
    await world.mirror.pass();

    expect(world.registry.list()).toHaveLength(0);
  });

  it('stops looking once it is disposed of', () => {
    const world = stand();
    world.mirror.start();

    world.mirror.dispose();

    expect(world.scheduler.live).toHaveLength(0);
  });

  it('forgets a record that has gone, so one that comes back is named again', async () => {
    const world = stand();
    world.names.set(PID, 'Test 1');
    await world.mirror.pass();

    world.registry.forget(TerminalId.fromString(TERMINAL_UUID));
    world.registry.register(makeEntry({ observed: observed('idle', PID) }));
    await world.mirror.pass();

    expect(world.nameOf()).toBe('Test 1');
  });
});

/**
 * The other direction, added in M2.19 because the owner asked for it: a row
 * renamed HERE reaching the conversation itself.
 *
 * There is no channel for it but the one a person has -- typing `/rename` into
 * the terminal -- and that is why every guard below exists. Text typed into a
 * terminal that is not idle does not disappear: it lands in the prompt box and
 * the newline SENDS it, which costs a turn and puts a line nobody wrote into
 * somebody's conversation.
 */
describe('telling the conversation what the row is called now', () => {
  const renameHere = (world: Stand, name: string): void => {
    const entry = world.held();
    world.registry.amend(entry.withMetadata(entry.metadata.withDisplayName(name)));
  };

  it('tells the conversation when the row was renamed here', async () => {
    const world = stand();
    world.names.set(PID, 'Test 1');
    await world.mirror.pass();

    renameHere(world, 'auth work');
    await world.mirror.pass();

    expect(world.told).toEqual([{ terminalId: TERMINAL_UUID, name: 'auth work' }]);
  });

  it('says nothing while the two names agree', async () => {
    const world = stand();
    world.names.set(PID, 'Test 1');

    await world.mirror.pass();
    await world.mirror.pass();

    expect(world.told).toEqual([]);
  });

  it('never types into a terminal that is not idle', async () => {
    // The whole reason this is a guard and not a preference: the newline would
    // send whatever is in the prompt box as a message.
    const world = stand(makeEntry({ observed: observed('working', PID) }));
    world.names.set(PID, 'Test 1');
    await world.mirror.pass();

    renameHere(world, 'auth work');
    await world.mirror.pass();

    expect(world.told).toEqual([]);
  });

  it('tells it once, however many passes go by', async () => {
    const world = stand();
    world.names.set(PID, 'Test 1');
    await world.mirror.pass();

    renameHere(world, 'auth work');
    await world.mirror.pass();
    await world.mirror.pass();
    await world.mirror.pass();

    expect(world.told).toHaveLength(1);
  });

  it('does not tell it a name that came from it in the first place', async () => {
    const world = stand();

    world.names.set(PID, 'Test 1');
    await world.mirror.pass();
    await world.mirror.pass();

    expect(world.nameOf()).toBe('Test 1');
    expect(world.told).toEqual([]);
  });

  it('says nothing when it cannot tell what the CLI calls the conversation', async () => {
    // `launch.mode: shell` is the real case: the pid is the shell, there is no
    // session file under it, and typing into that terminal would be blind.
    const world = stand();

    renameHere(world, 'auth work');
    await world.mirror.pass();

    expect(world.told).toEqual([]);
  });

  it('lets the CLI win when both sides moved between passes', async () => {
    const world = stand();
    world.names.set(PID, 'Test 1');
    await world.mirror.pass();

    renameHere(world, 'ours');
    world.names.set(PID, 'theirs');
    await world.mirror.pass();

    expect(world.nameOf()).toBe('theirs');
    expect(world.told).toEqual([]);
  });

  it('tells it again after the CLI moved, even a name it was told once before', async () => {
    // The memory of what was told is about ONE state of the conversation. Once
    // the CLI has renamed itself, that memory is spent -- and a person putting
    // the old name back here must reach the conversation again.
    const world = stand();
    world.names.set(PID, 'Test 1');
    await world.mirror.pass();

    renameHere(world, 'ours');
    await world.mirror.pass();

    world.names.set(PID, 'theirs');
    await world.mirror.pass();

    renameHere(world, 'ours');
    await world.mirror.pass();

    expect(world.told).toEqual([
      { terminalId: TERMINAL_UUID, name: 'ours' },
      { terminalId: TERMINAL_UUID, name: 'ours' },
    ]);
  });

  it('does not type the same rename again when the conversation did not take it', async () => {
    // We cannot see whether the line arrived: it may have landed in a prompt box
    // that was not empty. Repeating it every two seconds would turn one mistake
    // into a stream of them.
    const world = stand();
    world.names.set(PID, 'Test 1');
    await world.mirror.pass();
    world.deafen();

    renameHere(world, 'ours');
    await world.mirror.pass();
    await world.mirror.pass();
    await world.mirror.pass();

    expect(world.told).toHaveLength(1);
  });

  it('says in the log that a conversation was told, because nobody typed it', async () => {
    const world = stand();
    world.names.set(PID, 'Test 1');
    await world.mirror.pass();

    renameHere(world, 'auth work');
    await world.mirror.pass();

    expect(world.logger.infos.some((line) => line.message.includes('was told'))).toBe(true);
  });
});

describe('a record that goes while the pass is in flight', () => {
  it('is left alone in both directions', async () => {
    // A delete in another command, or another window taking the record over,
    // can land between the read and the write. Amending a remembered entry here
    // would put a deleted record back.
    const world = stand();
    world.names.set(PID, 'Test 1');
    world.whileReading(() => {
      world.registry.forget(TerminalId.fromString(TERMINAL_UUID));
    });

    await world.mirror.pass();

    expect(world.registry.own()).toHaveLength(0);
    expect(world.told).toEqual([]);
  });
});
