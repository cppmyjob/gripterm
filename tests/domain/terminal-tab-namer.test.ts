import {
  HookEventParser,
  SessionRegistry,
  TerminalId,
  TerminalStateMachine,
  TerminalTabNamer,
} from '../../packages/core/src/index';
import { InMemoryTerminalGateway, FixedClock, RecordingLogger } from '../helpers/port-fakes';
import {
  OBSERVED_AT,
  TERMINAL_UUID,
  makeEntry,
  makeOwnerRef,
  makeTerminalSpec,
} from '../helpers/domain-fixtures';
import type { TerminalEntry } from '../../packages/core/src/index';

const OTHER_TERMINAL = '7f14d5f0-6b1a-4c2e-9d3f-8a7b6c5d4e3f';

interface Stand {
  readonly registry: SessionRegistry;
  readonly gateway: InMemoryTerminalGateway;
  readonly namer: TerminalTabNamer;
  readonly logger: RecordingLogger;
  readonly renames: () => readonly string[];
  readonly rename: (to: string) => void;
}

async function stand(options: { readonly withTerminal?: boolean } = {}): Promise<Stand> {
  const logger = new RecordingLogger();
  const registry = new SessionRegistry({
    stateMachine: new TerminalStateMachine(),
    reader: new HookEventParser(),
    clock: new FixedClock(OBSERVED_AT),
    logger,
  });
  const gateway = new InMemoryTerminalGateway();
  if (options.withTerminal !== false) {
    await gateway.create(makeTerminalSpec());
  }
  const namer = new TerminalTabNamer({ registry, gateway, logger });
  // The order the lifecycle uses: the terminal exists, then the record does.
  registry.register(makeEntry());

  return {
    registry,
    gateway,
    namer,
    logger,
    renames: (): readonly string[] => gateway.handleFor(TerminalId.fromString(TERMINAL_UUID)).renamedTo,
    rename: (to: string): void => {
      const entry = registry.get(TerminalId.fromString(TERMINAL_UUID));
      if (entry === undefined) {
        throw new Error('the record went away');
      }
      registry.amend(entry.withMetadata(entry.metadata.withDisplayName(to)));
    },
  };
}

describe('keeping the editor tab on the same name as the row', () => {
  it('renames the tab when the row is renamed', async () => {
    const world = await stand();

    world.rename('Test 1');

    expect(world.renames()).toEqual(['Test 1']);
  });

  it('renames nothing when the record appears, because the terminal was created with that name', async () => {
    const world = await stand();

    expect(world.renames()).toEqual([]);
  });

  it('renames once however many times the record is amended with the same name', async () => {
    const world = await stand();

    world.rename('Test 1');
    const entry = world.registry.get(TerminalId.fromString(TERMINAL_UUID));
    expect(entry).toBeDefined();
    world.rename('Test 1');

    expect(world.renames()).toEqual(['Test 1']);
  });

  it('follows every distinct name, in order', async () => {
    const world = await stand();

    world.rename('one');
    world.rename('two');
    world.rename('one');

    expect(world.renames()).toEqual(['one', 'two', 'one']);
  });

  it('renames nothing for a record another window owns', async () => {
    const world = await stand();

    world.registry.replaceForeign([
      makeEntry({
        terminalId: TerminalId.fromString(OTHER_TERMINAL),
        owner: makeOwnerRef('window-activation-2'),
      }),
    ]);

    expect(world.renames()).toEqual([]);
  });

  it('says nothing and does nothing when the terminal has already closed', async () => {
    // A record can outlive its terminal by a moment -- the close event and the
    // last amendment race -- and a rename with no tab to put it on is not an
    // error, it is a tab that is gone.
    const world = await stand({ withTerminal: false });

    expect(() => {
      world.rename('Test 1');
    }).not.toThrow();
  });

  it('forgets a record that is deleted, so one that comes back is renamed again', async () => {
    const world = await stand();
    world.rename('Test 1');

    world.registry.forget(TerminalId.fromString(TERMINAL_UUID));
    const back: TerminalEntry = makeEntry();
    world.registry.register(back);
    world.rename('Test 1');

    expect(world.renames()).toEqual(['Test 1', 'Test 1']);
  });

  it('stops following once it is disposed of', async () => {
    const world = await stand();
    world.namer.dispose();

    world.rename('Test 1');

    expect(world.renames()).toEqual([]);
  });
});
