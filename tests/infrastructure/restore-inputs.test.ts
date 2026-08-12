import {
  ObservedState,
  SessionId,
  TerminalId,
  gatherRestoreInputs,
  type AgentListing,
  type Disposable,
  type OwnerId,
  type OwnerLiveness,
  type OwnerPresence,
  type RepositoryListener,
  type SignalProbe,
  type TerminalEntry,
  type TerminalRepository,
  type TranscriptIndex,
} from '../../packages/core/src/index';
import { OBSERVED_AT, makeEntry, makeOwnerRef } from '../helpers/domain-fixtures';
import { RecordingLogger } from '../helpers/port-fakes';

/**
 * The four questions a restore has to ask the world, and one rule over all of
 * them: **every failure answers in the direction of refusal.**
 *
 * That is the whole substance of this file. `planRestore` is pure and can only
 * be as truthful as what it is handed, and each of these answers is the
 * difference between refusing a record -- one click on the explicit adoption of
 * M2.14 -- and starting a second `claude --resume` on a live conversation, which
 * nothing takes back.
 */

const SECOND_UUID = '9a8b7c6d-5e4f-4a3b-8c9d-0e1f2a3b4c5d';
const SECOND_SESSION = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';
const NOW_MS = Date.parse('2026-08-12T10:00:00.000Z');
const UP_FOR = 3600;

const INDEXED: TranscriptIndex = {
  kind: 'indexed',
  sessionIds: new Set(['ac2d74d7-1f3b-4c5e-9a80-0d1e2f3a4b5c']),
  skipped: 0,
};
const LISTED: AgentListing = { kind: 'listed', agents: [], skipped: 0 };

/** Whatever the base was told to hold; nothing here writes. */
class StoredRecords implements TerminalRepository {
  private readonly _entries: readonly TerminalEntry[];

  constructor(entries: readonly TerminalEntry[]) {
    this._entries = entries;
  }

  public async readAll(): Promise<readonly TerminalEntry[]> {
    return this._entries;
  }

  public async readOwn(): Promise<readonly TerminalEntry[]> {
    return [];
  }

  public async write(): Promise<void> {
    // Gathering reads.
  }

  public async adopt(): Promise<TerminalEntry> {
    throw new Error('gathering does not adopt');
  }

  public async remove(): Promise<void> {
    // Gathering removes nothing.
  }

  public watch(_listener: RepositoryListener): Disposable {
    return { dispose: (): void => undefined };
  }
}

/** Windows with the answer each one gives, and a count of who was asked. */
class StoredLiveness implements OwnerPresence {
  public readonly asked: string[] = [];

  private readonly _answers: ReadonlyMap<string, OwnerLiveness>;
  private readonly _unreadable: ReadonlySet<string>;

  constructor(
    answers: ReadonlyMap<string, OwnerLiveness>,
    unreadable: ReadonlySet<string> = new Set()
  ) {
    this._answers = answers;
    this._unreadable = unreadable;
  }

  public async livenessOf(ownerId: OwnerId): Promise<OwnerLiveness> {
    this.asked.push(ownerId.value);
    if (this._unreadable.has(ownerId.value)) {
      throw new Error('the owners directory could not be read');
    }
    return this._answers.get(ownerId.value) ?? 'unknown';
  }

  public async announce(): Promise<void> {
    // Not part of a read.
  }

  public async heartbeat(): Promise<void> {
    // Not part of a read.
  }

  public async survey(): Promise<[]> {
    return [];
  }

  public async collect(): Promise<void> {
    // Not part of a read.
  }

  public async retire(): Promise<void> {
    // Not part of a read.
  }
}

function withPid(pid: number | null): ObservedState {
  return ObservedState.create({
    state: 'working',
    lastEventAt: OBSERVED_AT,
    currentTool: null,
    lastAssistantMessage: null,
    cost: null,
    contextWindow: null,
    pid,
  });
}

function second(observed: ObservedState): TerminalEntry {
  return makeEntry({
    terminalId: TerminalId.fromString(SECOND_UUID),
    sessionId: SessionId.fromString(SECOND_SESSION),
    observed,
  });
}

interface Ask {
  readonly entries?: readonly TerminalEntry[];
  readonly presence?: OwnerPresence;
  readonly probe?: SignalProbe;
  readonly readTranscripts?: () => Promise<TranscriptIndex>;
  readonly readAgents?: () => Promise<AgentListing>;
  readonly logger?: RecordingLogger;
}

async function gather(ask: Ask = {}): ReturnType<typeof gatherRestoreInputs> {
  return await gatherRestoreInputs({
    repository: new StoredRecords(ask.entries ?? [makeEntry()]),
    presence: ask.presence ?? new StoredLiveness(new Map([['window-activation-1', 'dead']])),
    windowFolders: ['D:/Projects/foo'],
    readTranscripts: ask.readTranscripts ?? (async () => INDEXED),
    readAgents: ask.readAgents ?? (async () => LISTED),
    nowMs: NOW_MS,
    uptimeSeconds: UP_FOR,
    logger: ask.logger ?? new RecordingLogger(),
    // Nothing is alive unless a case says so: `process.kill` on a pid this
    // machine happens to hold would make the answer depend on the machine.
    probe: ask.probe ?? ((): void => undefined),
  });
}

describe('gathering what a restore has to know', () => {
  it('hands the planner the records of the whole machine', async () => {
    const entries = [makeEntry(), second(withPid(null))];

    const inputs = await gather({ entries });

    expect(inputs.entries).toStrictEqual(entries);
  });

  it('passes the folders of this window and the two terms of the boot rule through', async () => {
    const inputs = await gather();

    expect(inputs.windowFolders).toStrictEqual(['D:/Projects/foo']);
    expect(inputs.nowMs).toBe(NOW_MS);
    expect(inputs.uptimeSeconds).toBe(UP_FOR);
  });

  it('asks each window once, however many terminals it left behind', async () => {
    const presence = new StoredLiveness(new Map([['window-activation-1', 'dead']]));

    await gather({ entries: [makeEntry(), second(withPid(null))], presence });

    expect(presence.asked).toStrictEqual(['window-activation-1']);
  });

  it('records the answer each window gave', async () => {
    const presence = new StoredLiveness(
      new Map([['window-activation-1', 'dead'], ['other-window', 'live']])
    );
    const entries = [
      makeEntry(),
      makeEntry({
        terminalId: TerminalId.fromString(SECOND_UUID),
        sessionId: SessionId.fromString(SECOND_SESSION),
        owner: makeOwnerRef('other-window'),
      }),
    ];

    const inputs = await gather({ entries, presence });

    expect([...inputs.ownerLiveness]).toStrictEqual([
      ['window-activation-1', 'dead'],
      ['other-window', 'live'],
    ]);
  });

  it('leaves a window it could not ask about unknown, never dead', async () => {
    // `dead` is what permits an adoption. A presence store that threw and was
    // read as "gone" would hand another window's live terminals to this one.
    const logger = new RecordingLogger();
    const presence = new StoredLiveness(new Map(), new Set(['window-activation-1']));

    const inputs = await gather({ presence, logger });

    expect(inputs.ownerLiveness.get('window-activation-1')).toBe('unknown');
    expect(logger.warnings.at(-1)?.message).toContain('could not be asked');
  });
});

describe('the pids a restore establishes to be gone', () => {
  it('holds the ones no process answers for', async () => {
    const gone: SignalProbe = () => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    };

    const inputs = await gather({ entries: [second(withPid(4242))], probe: gone });

    expect([...inputs.deadPids]).toStrictEqual([4242]);
  });

  it('holds nothing it could not settle', async () => {
    // `EPERM` is a process that IS there and belongs to somebody else, and a
    // pid outside the set is one this window will not touch.
    const guarded: SignalProbe = () => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    };

    const inputs = await gather({ entries: [second(withPid(4242))], probe: guarded });

    expect([...inputs.deadPids]).toStrictEqual([]);
  });

  it('asks about a pid once, however many records name it', async () => {
    const asked: number[] = [];
    const counting: SignalProbe = (pid) => {
      asked.push(pid);
    };

    await gather({
      entries: [makeEntry({ observed: withPid(4242) }), second(withPid(4242))],
      probe: counting,
    });

    expect(asked).toStrictEqual([4242]);
  });

  it('asks the operating system itself when nobody hands it a probe', async () => {
    // The default is the real signal 0, and this is the one case that proves
    // it: the pid of the process running the suite is beyond doubt alive, so a
    // set containing it would mean the default probe answers backwards -- and
    // "established gone" is what permits a `claude --resume`.
    const inputs = await gatherRestoreInputs({
      repository: new StoredRecords([second(withPid(process.pid))]),
      presence: new StoredLiveness(new Map()),
      windowFolders: [],
      readTranscripts: async () => INDEXED,
      readAgents: async () => LISTED,
      nowMs: NOW_MS,
      uptimeSeconds: UP_FOR,
      logger: new RecordingLogger(),
    });

    expect([...inputs.deadPids]).toStrictEqual([]);
  });

  it('asks nothing about a record that never told us a pid', async () => {
    // Which is every record on a machine with no `node`: the pid arrives only
    // through the `SessionStart` forwarder (A16, §8.2).
    const asked: number[] = [];
    const counting: SignalProbe = (pid) => {
      asked.push(pid);
    };

    await gather({ entries: [second(withPid(null))], probe: counting });

    expect(asked).toStrictEqual([]);
  });
});

describe('a question a restore could not ask at all', () => {
  it('leaves the transcripts unavailable rather than empty', async () => {
    // An empty index says "this conversation was never spoken in", which M2.13
    // turns into an offer to start it over. That is the one lie this type was
    // invented to prevent.
    const logger = new RecordingLogger();

    const inputs = await gather({
      readTranscripts: async () => {
        throw new Error('the profile directory is not readable');
      },
      logger,
    });

    expect(inputs.transcripts).toStrictEqual({
      kind: 'unavailable',
      reason: 'Error: the profile directory is not readable',
    });
    expect(logger.warnings.at(-1)?.details).toMatchObject({
      what: 'which conversations have a transcript',
    });
  });

  it('leaves the listing unavailable rather than empty', async () => {
    // An empty listing reads as "nothing is running, go ahead" (M2.9).
    const inputs = await gather({
      readAgents: async () => {
        throw new Error('claude is not on the PATH any more');
      },
    });

    expect(inputs.agents).toStrictEqual({
      kind: 'unavailable',
      reason: 'Error: claude is not on the PATH any more',
    });
  });

  it('passes an answer that did arrive through untouched', async () => {
    const inputs = await gather();

    expect(inputs.transcripts).toBe(INDEXED);
    expect(inputs.agents).toBe(LISTED);
  });
});
