import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  ConflictError,
  FileTerminalRepository,
  HumanMetadata,
  NotFoundError,
  ObservedState,
  OwnerId,
  OwnerRef,
  SessionId,
  StorageLayout,
  TerminalId,
  encodeRecord,
} from '../../packages/core/src/index';
import type {
  Logger,
  OwnerLiveness,
  OwnerPresence,
  PersistedTerminalState,
  TerminalEntry,
} from '../../packages/core/src/index';
import { NEXT_SESSION_UUID, TERMINAL_UUID, makeEntry, makeOwnerRef } from '../helpers/domain-fixtures';
import { FixedClock } from '../helpers/port-fakes';

/**
 * The base as several windows actually meet it: a directory, on a real file
 * system, written by more than one writer.
 *
 * A fake would be free to make the exclusive create atomic when it is not, and
 * the compare-and-swap is the one thing here whose failure is invisible --
 * two windows both winning means two `claude --resume` on one conversation,
 * which shows up as an interleaved transcript hours later.
 */

const MINE = 'window-mine';
const THEIRS = 'window-theirs';
const OTHER_TERMINAL = '9f6b1a20-4d2e-4c88-b3f1-2a7c9e5d0011';

/** The moment a discarded record is stamped with, so its trash path is known. */
const DISCARDED_AT = new Date('2026-08-12T14:33:07.500Z');

class StubPresence implements OwnerPresence {
  private readonly _liveness = new Map<string, OwnerLiveness>();

  public say(ownerId: string, liveness: OwnerLiveness): void {
    this._liveness.set(ownerId, liveness);
  }

  public async announce(): Promise<void> {
    // Presence is M2.4; this stub exists to answer one question.
  }

  public async heartbeat(): Promise<void> {
    // As above.
  }

  public async livenessOf(ownerId: OwnerId): Promise<OwnerLiveness> {
    return this._liveness.get(ownerId.value) ?? 'unknown';
  }

  public async survey(): Promise<[]> {
    return [];
  }

  public async collect(): Promise<void> {
    // Not part of a read.
  }

  public async retire(): Promise<void> {
    // As above.
  }
}

function silentLogger(): Logger & { readonly lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (message: string): void => {
      lines.push(`info: ${message}`);
    },
    warn: (message: string): void => {
      lines.push(`warn: ${message}`);
    },
    error: (message: string): void => {
      lines.push(`error: ${message}`);
    },
  };
}

let base = '';
let layout: StorageLayout;
let presence: StubPresence;
let logger: ReturnType<typeof silentLogger>;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'gripterm-repo-'));
  layout = new StorageLayout(base);
  presence = new StubPresence();
  logger = silentLogger();
  await mkdir(layout.terminalsDir, { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function repositoryFor(ownerId: string): FileTerminalRepository {
  return new FileTerminalRepository({
    layout,
    owner: makeOwnerRef(ownerId),
    presence,
    clock: new FixedClock(DISCARDED_AT),
    logger,
  });
}

function entryOwnedBy(ownerId: string, overrides: Parameters<typeof makeEntry>[0] = {}): TerminalEntry {
  return makeEntry({ owner: makeOwnerRef(ownerId), ...overrides });
}

function observedIn(state: PersistedTerminalState): ObservedState {
  return ObservedState.create({
    state,
    lastEventAt: new Date('2026-08-12T10:00:00.000Z'),
    currentTool: null,
    lastAssistantMessage: null,
    cost: null,
    contextWindow: null,
    pid: null,
  });
}

function renamedTo(displayName: string): HumanMetadata {
  return HumanMetadata.create({ displayName, task: null, notes: [], tags: [], color: null });
}

/** Puts a record on disk without going through the repository's own rules. */
async function plant(entry: TerminalEntry): Promise<void> {
  const directory = layout.terminalDir(entry.terminalId);
  await mkdir(directory, { recursive: true });
  await writeFile(layout.recordFile(entry.terminalId), JSON.stringify(encodeRecord(entry)), 'utf8');
}

describe('writing', () => {
  it('stores an entry and reads it back through a different instance', async () => {
    const entry = entryOwnedBy(MINE);

    await repositoryFor(MINE).write(entry);
    const [read] = await repositoryFor(THEIRS).readAll();

    expect(read?.terminalId.value).toBe(entry.terminalId.value);
    expect(read?.metadata.equals(entry.metadata)).toBe(true);
    expect(read?.observed).toStrictEqual(entry.observed);
  });

  /*
   * The single-writer rule enforced by the REPOSITORY, not by a convention the
   * caller is trusted to remember. The whole store rests on it: two writers on
   * one record is the situation nothing downstream can repair.
   */
  it('refuses an entry this window does not own', async () => {
    await expect(repositoryFor(MINE).write(entryOwnedBy(THEIRS))).rejects.toThrow(ConflictError);
    expect(await readdir(layout.terminalsDir)).toStrictEqual([]);
  });

  it('writes the record last, so a crash cannot point it at a snapshot that never arrived', async () => {
    const entry = entryOwnedBy(MINE);

    await repositoryFor(MINE).write(entry);

    expect((await readdir(layout.terminalDir(entry.terminalId))).sort()).toStrictEqual([
      'observed.json',
      'record.json',
    ]);
  });

  /*
   * The half of M2.6 that lives here. The observed snapshot is written on every
   * debounced pass; `record.json` is the same bytes on almost all of them, and
   * writing a file whose content did not change is a no-op with side effects --
   * every other window's watcher fires and answers by re-reading the base, and
   * the file it re-reads is the one holding the task and the notes, which is the
   * only thing in this store nothing can rebuild.
   *
   * A sentinel on disk rather than a timestamp: mtime resolution is coarse
   * enough on this platform to make a passing test mean nothing.
   */
  it('leaves the record alone when only the observed half moved', async () => {
    const entry = entryOwnedBy(MINE);
    const repository = repositoryFor(MINE);
    await repository.write(entry);
    await writeFile(layout.recordFile(entry.terminalId), '{"sentinel":true}', 'utf8');

    await repository.write(entry.withObserved(observedIn('working')));

    expect(await readFile(layout.recordFile(entry.terminalId), 'utf8')).toBe('{"sentinel":true}');
    const snapshot = JSON.parse(
      await readFile(layout.observedFile(entry.terminalId), 'utf8')
    ) as { state: string };
    expect(snapshot.state).toBe('working');
  });

  it('writes the record again as soon as its own content moves', async () => {
    const entry = entryOwnedBy(MINE);
    const repository = repositoryFor(MINE);
    await repository.write(entry);
    await writeFile(layout.recordFile(entry.terminalId), '{"sentinel":true}', 'utf8');

    await repository.write(entry.withMetadata(renamedTo('something else')));

    const record = JSON.parse(
      await readFile(layout.recordFile(entry.terminalId), 'utf8')
    ) as { metadata: { displayName: string } };
    expect(record.metadata.displayName).toBe('something else');
  });

  it('remembers only what it managed to write', async () => {
    // A record remembered as stored and then not stored would be skipped for as
    // long as this window lives -- the one way this optimisation could lose
    // somebody's task and notes rather than merely save a write.
    const entry = entryOwnedBy(MINE);
    const repository = repositoryFor(MINE);
    // A directory where the file goes: `rename` cannot land on it, so the record
    // half fails while the observed half has already succeeded.
    await mkdir(layout.recordFile(entry.terminalId), { recursive: true });
    await expect(repository.write(entry)).rejects.toThrow();

    await rm(layout.recordFile(entry.terminalId), { recursive: true });
    await repository.write(entry);

    expect((await repository.readAll()).length).toBe(1);
  });

  it('forgets what it wrote when the record is removed', async () => {
    // Otherwise a record written again under the same id and the same content --
    // which is what restoring one looks like -- would be recognised as already
    // there and never written back.
    const entry = entryOwnedBy(MINE);
    const repository = repositoryFor(MINE);
    await repository.write(entry);
    await repository.remove(entry.terminalId);

    await repository.write(entry);

    expect((await repository.readAll()).length).toBe(1);
  });

  it('tells its listeners, so a window redraws without polling itself', async () => {
    const repository = repositoryFor(MINE);
    let told = 0;
    const subscription = repository.watch(() => {
      told += 1;
    });

    await repository.write(entryOwnedBy(MINE));
    subscription.dispose();
    await repository.write(entryOwnedBy(MINE));

    expect(told).toBe(1);
  });
});

describe('reading', () => {
  it('returns only this owner\'s entries from readOwn, and everybody\'s from readAll', async () => {
    await plant(entryOwnedBy(MINE));
    await plant(entryOwnedBy(THEIRS, { terminalId: TerminalId.fromString(OTHER_TERMINAL) }));

    const repository = repositoryFor(MINE);

    expect((await repository.readOwn(OwnerId.fromString(MINE))).length).toBe(1);
    expect((await repository.readAll()).length).toBe(2);
  });

  /*
   * The failure this project has already met in somebody else's store: one
   * malformed file emptying the whole list. The neighbours must survive it.
   */
  it('isolates a malformed record and still returns its neighbours', async () => {
    await plant(entryOwnedBy(MINE));
    const broken = TerminalId.fromString(OTHER_TERMINAL);
    await mkdir(layout.terminalDir(broken), { recursive: true });
    await writeFile(layout.recordFile(broken), '{ this is not json', 'utf8');

    const entries = await repositoryFor(MINE).readAll();

    expect(entries.length).toBe(1);
    expect(logger.lines.some((line) => line.startsWith('warn:'))).toBe(true);
  });

  it('isolates a record that is JSON but not a record', async () => {
    const broken = TerminalId.fromString(OTHER_TERMINAL);
    await mkdir(layout.terminalDir(broken), { recursive: true });
    await writeFile(layout.recordFile(broken), '{"terminalId":"nope"}', 'utf8');

    expect(await repositoryFor(MINE).readAll()).toStrictEqual([]);
    expect(logger.lines.some((line) => line.includes('malformed'))).toBe(true);
  });

  /*
   * M1 left a dozen of these on the machine this is developed on: a terminal
   * directory holding nothing but `settings.json`. It is not a fault and must
   * not be reported as one.
   */
  it('passes over a directory that has no record without complaining', async () => {
    const leftover = TerminalId.fromString(OTHER_TERMINAL);
    await mkdir(layout.terminalDir(leftover), { recursive: true });
    await writeFile(layout.settingsFile(leftover), '{"hooks":{}}', 'utf8');

    expect(await repositoryFor(MINE).readAll()).toStrictEqual([]);
    expect(logger.lines.filter((line) => line.startsWith('warn:'))).toStrictEqual([]);
  });

  it('passes over a directory whose name is not a terminal id', async () => {
    await mkdir(join(layout.terminalsDir, 'notes'), { recursive: true });
    await writeFile(join(layout.terminalsDir, 'notes', 'record.json'), '{}', 'utf8');

    expect(await repositoryFor(MINE).readAll()).toStrictEqual([]);
  });

  it('reads an empty base rather than failing when there is no terminals directory', async () => {
    await rm(layout.terminalsDir, { recursive: true, force: true });

    expect(await repositoryFor(MINE).readAll()).toStrictEqual([]);
  });

  it('brings a terminal back without its observed state rather than losing it', async () => {
    const entry = entryOwnedBy(MINE);
    await plant(entry);

    const [read] = await repositoryFor(MINE).readAll();

    expect(read?.observed.state).toBe('degraded');
    expect(logger.lines.some((line) => line.includes('without its observed state'))).toBe(true);
  });
});

describe('adopting', () => {
  it('takes over the entry of an owner established as gone', async () => {
    const theirs = entryOwnedBy(THEIRS);
    await plant(theirs);
    presence.say(THEIRS, 'dead');

    const adopted = await repositoryFor(MINE).adopt(theirs.terminalId, theirs.revision);

    expect(adopted.owner.ownerId.value).toBe(MINE);
    // The revision advances in the aggregate, which is what makes a second
    // adopter's compare-and-swap fail.
    expect(adopted.revision).toBe(theirs.revision + 1);
    const [onDisk] = await repositoryFor(THEIRS).readAll();
    expect(onDisk?.owner.ownerId.value).toBe(MINE);
    expect(onDisk?.revision).toBe(theirs.revision + 1);
  });

  it('leaves no claim file behind', async () => {
    const theirs = entryOwnedBy(THEIRS);
    await plant(theirs);
    presence.say(THEIRS, 'dead');

    await repositoryFor(MINE).adopt(theirs.terminalId, theirs.revision);

    expect((await readdir(layout.terminalDir(theirs.terminalId))).sort()).toStrictEqual([
      'observed.json',
      'record.json',
    ]);
  });

  it('never displaces a living owner', async () => {
    const theirs = entryOwnedBy(THEIRS);
    await plant(theirs);
    presence.say(THEIRS, 'live');

    await expect(
      repositoryFor(MINE).adopt(theirs.terminalId, theirs.revision)
    ).rejects.toThrow(ConflictError);
  });

  /*
   * `unknown` is a live window with a stale heartbeat -- what every window looks
   * like after the machine wakes from sleep. Adopting one starts a second
   * `claude --resume` on a conversation that already has one, so it is refused
   * as firmly as `live` until a person says they have looked.
   */
  it('refuses an owner whose liveness is merely unknown, unless forced', async () => {
    const theirs = entryOwnedBy(THEIRS);
    await plant(theirs);
    presence.say(THEIRS, 'unknown');

    await expect(
      repositoryFor(MINE).adopt(theirs.terminalId, theirs.revision)
    ).rejects.toThrow(ConflictError);

    const forced = await repositoryFor(MINE).adopt(theirs.terminalId, theirs.revision, {
      force: true,
    });
    expect(forced.owner.ownerId.value).toBe(MINE);
  });

  it('refuses when the revision has moved since the caller read it', async () => {
    const theirs = entryOwnedBy(THEIRS, { revision: 4 });
    await plant(theirs);
    presence.say(THEIRS, 'dead');

    await expect(repositoryFor(MINE).adopt(theirs.terminalId, 3)).rejects.toThrow(ConflictError);
  });

  it('refuses an id that is not in the store', async () => {
    await expect(
      repositoryFor(MINE).adopt(TerminalId.fromString(OTHER_TERMINAL), 0)
    ).rejects.toThrow(NotFoundError);
  });

  /*
   * THE test of this milestone, and it has to be PARALLEL. A sequential version
   * -- read the old revision, then adopt, then get a ConflictError -- exercises
   * the error branch and says nothing about the race, which is the only thing
   * the exclusive create is there for.
   */
  it('lets exactly one of several windows adopt the same entry at once', async () => {
    const theirs = entryOwnedBy(THEIRS);
    await plant(theirs);
    presence.say(THEIRS, 'dead');

    const contenders = ['window-a', 'window-b', 'window-c', 'window-d'];
    const outcomes = await Promise.allSettled(
      contenders.map(async (who) => await repositoryFor(who).adopt(theirs.terminalId, theirs.revision))
    );

    const winners = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    expect(winners.length).toBe(1);
    for (const loser of outcomes.filter((outcome) => outcome.status === 'rejected')) {
      expect((loser).reason).toBeInstanceOf(ConflictError);
    }

    const [onDisk] = await repositoryFor(MINE).readAll();
    expect(contenders).toContain(onDisk?.owner.ownerId.value);
    expect(onDisk?.revision).toBe(theirs.revision + 1);
  });

  it('refuses while another window holds the claim', async () => {
    const theirs = entryOwnedBy(THEIRS);
    await plant(theirs);
    presence.say(THEIRS, 'dead');
    presence.say('window-holder', 'live');
    await writeFile(
      join(layout.terminalDir(theirs.terminalId), 'adopting.json'),
      JSON.stringify({ ownerId: 'window-holder', pid: 1 }),
      'utf8'
    );

    await expect(
      repositoryFor(MINE).adopt(theirs.terminalId, theirs.revision)
    ).rejects.toThrow(ConflictError);
  });

  /*
   * The half that makes this a claim rather than a lock: no timeout, no stale
   * policy. §4.8 turned `proper-lockfile` down because its 120-second window
   * means a crashed editor blocks adoption for two minutes; a claim held by a
   * DEAD owner is simply not a claim.
   */
  it('takes over a claim left behind by a window that has since died', async () => {
    const theirs = entryOwnedBy(THEIRS);
    await plant(theirs);
    presence.say(THEIRS, 'dead');
    presence.say('window-crashed', 'dead');
    await writeFile(
      join(layout.terminalDir(theirs.terminalId), 'adopting.json'),
      JSON.stringify({ ownerId: 'window-crashed', pid: 1 }),
      'utf8'
    );

    const adopted = await repositoryFor(MINE).adopt(theirs.terminalId, theirs.revision);

    expect(adopted.owner.ownerId.value).toBe(MINE);
    expect(logger.lines.some((line) => line.includes('left behind by a dead window'))).toBe(true);
  });

  it.each([
    ['is not JSON', 'not json at all'],
    ['is JSON but not an object', '"held"'],
    ['names no owner', '{"pid":1}'],
    ['names a blank owner', '{"ownerId":"   "}'],
  ])('refuses rather than guessing when the claim file %s', async (_name, content) => {
    const theirs = entryOwnedBy(THEIRS);
    await plant(theirs);
    presence.say(THEIRS, 'dead');
    await writeFile(
      join(layout.terminalDir(theirs.terminalId), 'adopting.json'),
      content,
      'utf8'
    );

    await expect(
      repositoryFor(MINE).adopt(theirs.terminalId, theirs.revision)
    ).rejects.toThrow(ConflictError);
  });
});

/** Every file under `dir`, as paths relative to it, sorted. */
async function tree(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const item of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (item.isFile()) {
      found.push(relative(dir, join(item.parentPath, item.name)).replaceAll('\\', '/'));
    }
  }
  return found.sort();
}

describe('removing', () => {
  /*
   * The journal is the one thing in this store no later version can go back
   * for (§10.1а). A command that takes a row out of a list has no business
   * destroying it -- `Clean Up Storage` (M2.15) sweeps the trash, and even that
   * does not delete.
   */
  it('forgets the record and keeps the history', async () => {
    const entry = entryOwnedBy(MINE);
    await repositoryFor(MINE).write(entry);
    const journal = join(layout.terminalDir(entry.terminalId), 'events.ndjson');
    await writeFile(journal, '{"v":1}\n', 'utf8');

    await repositoryFor(MINE).remove(entry.terminalId);

    expect(await repositoryFor(MINE).readAll()).toStrictEqual([]);
    expect(await readFile(journal, 'utf8')).toBe('{"v":1}\n');
  });

  it('refuses an id that is not in the store', async () => {
    await expect(
      repositoryFor(MINE).remove(TerminalId.fromString(OTHER_TERMINAL))
    ).rejects.toThrow(NotFoundError);
  });

  it('tells its listeners', async () => {
    const repository = repositoryFor(MINE);
    const entry = entryOwnedBy(MINE);
    await repository.write(entry);
    let told = 0;
    repository.watch(() => {
      told += 1;
    });

    await repository.remove(entry.terminalId);

    expect(told).toBe(1);
  });

  /*
   * The three below are §I.3 in one place: the record holds the task, the notes
   * and the tags, which nothing can rebuild, so it is MOVED rather than
   * destroyed and the way back is tested rather than argued.
   */
  it('moves the two files to the trash instead of deleting them', async () => {
    const entry = entryOwnedBy(MINE);
    await repositoryFor(MINE).write(entry);

    await repositoryFor(MINE).remove(entry.terminalId);

    const home = layout.discardedTerminalDir(DISCARDED_AT, entry.terminalId);
    expect((await readdir(home)).sort()).toStrictEqual(['observed.json', 'record.json']);
    expect(await repositoryFor(MINE).readAll()).toStrictEqual([]);
  });

  it('can be undone by moving them back, with no tool and no format to understand', async () => {
    const entry = entryOwnedBy(MINE, {
      metadata: HumanMetadata.create({
        displayName: 'auth-refactor',
        task: 'Move token validation into its own service',
        notes: [],
        tags: ['backend'],
        color: 'terminal.ansiCyan',
      }),
    });
    await repositoryFor(MINE).write(entry);
    await repositoryFor(MINE).remove(entry.terminalId);

    // Exactly what a person does with a file manager: the two files back into
    // the terminal's own directory, which never left.
    const id = entry.terminalId;
    await rename(layout.discardedRecordFile(DISCARDED_AT, id), layout.recordFile(id));
    await rename(layout.discardedObservedFile(DISCARDED_AT, id), layout.observedFile(id));

    const back = await repositoryFor(MINE).readAll();
    expect(back).toHaveLength(1);
    expect(back[0]?.metadata.task).toBe('Move token validation into its own service');
    expect(back[0]?.metadata.tags).toStrictEqual(['backend']);
    expect(back[0]?.observed.state).toBe(entry.observed.state);
  });

  it('goes ahead when there is no snapshot to move, and says so quietly', async () => {
    // The observed half is a cache whose loss costs nothing, so refusing to
    // delete a record over it would leave the person with a row they asked
    // twice to be rid of. A record planted by hand has no `observed.json`,
    // which is also what a record restored from the trash by hand looks like.
    const entry = entryOwnedBy(MINE);
    await plant(entry);

    await repositoryFor(MINE).remove(entry.terminalId);

    expect(await repositoryFor(MINE).readAll()).toStrictEqual([]);
    expect(await readdir(layout.discardedTerminalDir(DISCARDED_AT, entry.terminalId))).toStrictEqual(
      ['record.json']
    );
    expect(logger.lines).toContain('info: a discarded record left its observed snapshot behind');
  });

  it('touches nothing but the two files of the record it was asked about', async () => {
    // The acceptance criterion of M2.7 read as a file-system fact: deleting a
    // row does not delete the conversation. The decoys stand for the two things
    // a person fears losing -- the CLI's own store, which this codebase never
    // writes to, and our journal.
    const entry = entryOwnedBy(MINE);
    const neighbour = entryOwnedBy(MINE, { terminalId: TerminalId.fromString(OTHER_TERMINAL) });
    await repositoryFor(MINE).write(entry);
    await repositoryFor(MINE).write(neighbour);

    const conversation = join(base, 'projects', 'D--Projects-foo');
    await mkdir(conversation, { recursive: true });
    await writeFile(join(conversation, `${entry.sessionId.value}.jsonl`), '{"type":"user"}\n', 'utf8');
    await mkdir(layout.eventsDir(entry.terminalId), { recursive: true });
    await writeFile(layout.journalFile(entry.terminalId, DISCARDED_AT), '{"v":1}\n', 'utf8');
    await writeFile(layout.settingsFile(entry.terminalId), '{}', 'utf8');

    const before = await tree(base);
    await repositoryFor(MINE).remove(entry.terminalId);
    const after = await tree(base);

    const id = entry.terminalId.value;
    expect(before.filter((path) => !after.includes(path))).toStrictEqual([
      `terminals/${id}/observed.json`,
      `terminals/${id}/record.json`,
    ]);
    // And what appeared is the same two files, in the trash and nowhere else.
    expect(after.filter((path) => !before.includes(path)).every((path) => path.startsWith('trash/'))).toBe(true);
  });
});

describe('what a round trip keeps', () => {
  it('carries the human metadata a person put there, unchanged', async () => {
    const entry = entryOwnedBy(MINE, {
      metadata: HumanMetadata.create({
        displayName: 'auth-refactor',
        task: 'Move token validation into its own service',
        notes: [],
        tags: ['backend', 'urgent'],
        color: 'terminal.ansiCyan',
      }),
      sessionIdHistory: [],
    });

    await repositoryFor(MINE).write(entry);
    const [read] = await repositoryFor(MINE).readAll();

    expect(read?.metadata.task).toBe('Move token validation into its own service');
    expect(read?.metadata.tags).toStrictEqual(['backend', 'urgent']);
    expect(read?.metadata.color).toBe('terminal.ansiCyan');
  });

  it('keeps the owner a foreign entry belongs to, which is what readOwn filters on', async () => {
    const owner = OwnerRef.create({
      kind: 'window',
      ownerId: OwnerId.fromString(THEIRS),
      editorKind: 'cursor',
      workspaceFolder: null,
    });
    await plant(makeEntry({ owner }));

    const [read] = await repositoryFor(MINE).readAll();

    expect(read?.owner.editorKind).toBe('cursor');
    expect(read?.owner.workspaceFolder).toBeNull();
    expect(await repositoryFor(MINE).readOwn(OwnerId.fromString(MINE))).toStrictEqual([]);
  });

  it('does not confuse two terminals of the same window', async () => {
    await repositoryFor(MINE).write(entryOwnedBy(MINE));
    await repositoryFor(MINE).write(
      entryOwnedBy(MINE, {
        terminalId: TerminalId.fromString(OTHER_TERMINAL),
        sessionId: SessionId.fromString(NEXT_SESSION_UUID),
      })
    );

    const ids = (await repositoryFor(MINE).readAll()).map((entry) => entry.terminalId.value).sort();

    expect(ids).toStrictEqual([OTHER_TERMINAL, TERMINAL_UUID].sort());
  });
});
