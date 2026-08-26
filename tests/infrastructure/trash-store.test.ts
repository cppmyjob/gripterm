import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ConflictError,
  FileOwnerPresence,
  FileTerminalRepository,
  HumanMetadata,
  StorageCleaner,
  StorageLayout,
  TerminalId,
  TrashStore,
  encodePresence,
  writeJsonFile,
} from '../../packages/core/src/index';
import type * as FsPromises from 'node:fs/promises';
import type { OwnerPresence, OwnerLiveness, TerminalEntry, TrashItem } from '../../packages/core/src/index';
import { FakeScheduler, FixedClock, RecordingLogger } from '../helpers/port-fakes';
import { makeEntry, makeOwnerIdentity, makeOwnerRef } from '../helpers/domain-fixtures';

/**
 * The way back out of `trash/`, against a real store on a real file system.
 *
 * A fake would be free to make a copy atomic when it is not, and this is the one
 * class in the build that WRITES INTO the store from the trash -- so the failure
 * it has to be right about is the half-done one: the copy in the trash spent
 * without the record arriving. `trash/` is the only undo this product has, for
 * `remove()`, for the presence sweep and for `forgetClosedTerminals` alike, so a
 * return that eats the copy costs a person the one thing that could have saved
 * them.
 *
 * Every one of the three forms below is made by the REAL thing that makes it --
 * the repository, the cleaner, the presence file sweep -- rather than laid out
 * by hand. A test that built the trash itself would be checking this class
 * against its own idea of what is in there.
 */

const NOW = new Date('2026-08-12T14:33:07.500Z');
const MINE = 'window-mine';

/**
 * Two ids, because the two terminal forms have to be able to sit in ONE batch.
 *
 * The stamp is a second, and a fixed clock makes every act here share it: two
 * records thrown away in the same second land in the same `trash/<stamp>/`, and
 * that is the store as it really is rather than an accident of this suite.
 */
const SWEPT = '11111111-1111-4111-8111-111111111111';
const REMOVED = '22222222-2222-4222-8222-222222222222';
const A_MINUTE_MS = 60_000;
const RETENTION_DAYS = 14;

/** One line of a terminal's journal, so that a copy can be compared byte for byte. */
const JOURNAL_LINE = '{"seq":1}\n';

class StubPresence implements OwnerPresence {
  public async announce(): Promise<void> {
    // Not part of anything here.
  }

  public async heartbeat(): Promise<void> {
    // As above.
  }

  public async livenessOf(): Promise<OwnerLiveness> {
    return 'dead';
  }

  public async survey(): Promise<[]> {
    return [];
  }

  public async collect(): Promise<void> {
    // As above.
  }

  public async retire(): Promise<void> {
    // As above.
  }
}

let base = '';
let layout: StorageLayout;
let clock: FixedClock;
let logger: RecordingLogger;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'gripterm-trash-'));
  layout = new StorageLayout(base);
  clock = new FixedClock(NOW);
  logger = new RecordingLogger();
  await mkdir(layout.terminalsDir, { recursive: true });
});

afterEach(async () => {
  jest.restoreAllMocks();
  await rm(base, { recursive: true, force: true });
});

function trash(): TrashStore {
  return new TrashStore({ layout, logger });
}

function repository(): FileTerminalRepository {
  return new FileTerminalRepository({
    layout,
    owner: makeOwnerRef(MINE),
    presence: new StubPresence(),
    clock,
    logger,
  });
}

function cleaner(): StorageCleaner {
  return new StorageCleaner({
    layout,
    clock,
    scheduler: new FakeScheduler(),
    logger,
    retentionDays: RETENTION_DAYS,
  });
}

function presenceOf(): FileOwnerPresence {
  return new FileOwnerPresence({
    layout,
    clock,
    logger,
    uptimeSeconds: () => 7200,
  });
}

function named(displayName: string, terminalId: string): TerminalEntry {
  return makeEntry({
    terminalId: TerminalId.fromString(terminalId),
    owner: makeOwnerRef(MINE),
    metadata: HumanMetadata.create({
      displayName,
      task: 'Move token validation into its own service',
      notes: [],
      tags: ['backend'],
      color: null,
    }),
  });
}

/** The history and the settings a terminal's folder holds beside its two cards. */
async function withHistory(entry: TerminalEntry): Promise<void> {
  const dir = layout.terminalDir(entry.terminalId);
  await mkdir(join(dir, 'events'), { recursive: true });
  await writeFile(join(dir, 'events', '2026-08-01.ndjson'), JOURNAL_LINE, 'utf8');
  await writeFile(join(dir, 'settings.json'), '{"hooks":{}}', 'utf8');
}

/** Puts a directory far enough back for the cleaner's settle guard to let it go. */
async function settle(path: string): Promise<void> {
  const old = new Date(Date.now() - 10 * A_MINUTE_MS);
  await utimes(path, old, old);
}

/**
 * Form one: the whole folder, as the cleanup and `forgetClosedTerminals` leave it.
 */
async function sweptWhole(displayName = 'a terminal nobody wanted'): Promise<TerminalEntry> {
  const entry = named(displayName, SWEPT);
  await repository().write(entry);
  await withHistory(entry);
  await settle(layout.terminalDir(entry.terminalId));
  await cleaner().sweep([entry.terminalId.value]);
  return entry;
}

/**
 * Form two: the two cards only, with the terminal's own folder left where it is.
 */
async function removedRecord(displayName = 'auth-refactor'): Promise<TerminalEntry> {
  const entry = named(displayName, REMOVED);
  await repository().write(entry);
  await withHistory(entry);
  await repository().remove(entry.terminalId);
  return entry;
}

/** Form three: a presence file, as the reconciler's sweep leaves it. */
async function collectedOwner(name = 'window-that-closed'): Promise<string> {
  await mkdir(layout.ownersDir, { recursive: true });
  await writeJsonFile(
    join(layout.ownersDir, `${name}.json`),
    encodePresence({
      identity: { ...makeOwnerIdentity(name), pid: 4242 },
      startedAt: new Date(NOW.getTime() - A_MINUTE_MS),
      heartbeatAt: new Date(NOW.getTime() - A_MINUTE_MS),
    })
  );
  await presenceOf().collect(`${name}.json`);
  return `${name}.json`;
}

/**
 * The one thing in the trash, or a failure that says how many there really are.
 *
 * A helper rather than `(await list())[0]!`: a listing that grew a second row
 * would otherwise make a test pass against whichever one sorted first.
 */
async function theOnlyOne(): Promise<TrashItem> {
  const listed = await trash().list();
  const [item] = listed;
  if (item === undefined || listed.length !== 1) {
    throw new Error(`the trash holds ${listed.length} things, not one`);
  }
  return item;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Every file under a directory, relative and sorted, with its bytes. */
async function contentsOf(dir: string, prefix = ''): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const child of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix === '' ? child.name : `${prefix}/${child.name}`;
    if (child.isDirectory()) {
      Object.assign(found, await contentsOf(join(dir, child.name), relative));
      continue;
    }
    found[relative] = await readFile(join(dir, child.name), 'utf8');
  }
  return found;
}

describe('what a person can see in the trash', () => {
  it('says nothing at all about a store where nothing was ever thrown away', async () => {
    await expect(trash().list()).resolves.toStrictEqual([]);
  });

  it('tells the three forms apart, because a door that knows one of them is a door that lies', async () => {
    const whole = await sweptWhole();
    const cards = await removedRecord();
    const owner = await collectedOwner();

    const listed = await trash().list();

    expect(listed.map((item) => `${item.form} ${item.name}`).sort()).toStrictEqual(
      [
        `whole-folder ${whole.terminalId.value}`,
        `record-only ${cards.terminalId.value}`,
        `owner-file ${owner}`,
      ].sort()
    );
  });

  it('reads the name off the record, so the list is not a column of uuids', async () => {
    await sweptWhole('the one I meant to keep');

    const item = await theOnlyOne();

    expect(item.displayName).toBe('the one I meant to keep');
  });

  it('leaves a folder somebody else put in the trash alone', async () => {
    await mkdir(join(layout.trashDir, 'my own copy'), { recursive: true });
    await writeFile(join(layout.trashDir, 'my own copy', 'record.json'), '{}', 'utf8');

    await expect(trash().list()).resolves.toStrictEqual([]);
  });
});

describe('bringing back what the trash holds', () => {
  it('brings back a whole folder, and the store reads the record again', async () => {
    const entry = await sweptWhole();
    const item = await theOnlyOne();

    const outcome = await trash().restore(item);

    expect(outcome.restoredTo).toBe(layout.terminalDir(entry.terminalId));
    const back = await repository().readAll();
    expect(back.map((one) => one.metadata.displayName)).toStrictEqual(['a terminal nobody wanted']);
    expect(await contentsOf(layout.terminalDir(entry.terminalId))).toStrictEqual({
      'events/2026-08-01.ndjson': JOURNAL_LINE,
      'observed.json': expect.any(String) as unknown,
      'record.json': expect.any(String) as unknown,
      'settings.json': '{"hooks":{}}',
    });
  });

  it('brings back the two cards into the folder that never left, without colliding with it', async () => {
    const entry = await removedRecord();
    const home = layout.terminalDir(entry.terminalId);
    expect(await exists(home)).toBe(true);

    const item = await theOnlyOne();
    const outcome = await trash().restore(item);

    expect(outcome.restoredTo).toBe(home);
    // The journal and the settings never left, and the two cards land beside
    // them rather than over them: a rename of the folder would have failed here.
    expect(await contentsOf(home)).toStrictEqual({
      'events/2026-08-01.ndjson': JOURNAL_LINE,
      'observed.json': expect.any(String) as unknown,
      'record.json': expect.any(String) as unknown,
      'settings.json': '{"hooks":{}}',
    });
    const back = await repository().readAll();
    expect(back.map((one) => one.metadata.task)).toStrictEqual([
      'Move token validation into its own service',
    ]);
  });

  it('brings back a presence file, and the survey sees that window again', async () => {
    const fileName = await collectedOwner();
    await expect(presenceOf().survey()).resolves.toStrictEqual([]);

    const item = await theOnlyOne();
    const outcome = await trash().restore(item);

    expect(outcome.restoredTo).toBe(join(layout.ownersDir, fileName));
    const surveyed = await presenceOf().survey();
    expect(surveyed.map((row) => row.name)).toStrictEqual(['window-that-closed']);
  });

  it('takes its own copy out of the trash once the record is back, and not before', async () => {
    const entry = await sweptWhole();
    const item = await theOnlyOne();

    const outcome = await trash().restore(item);

    expect(outcome.trashCopyRemoved).toBe(true);
    expect(await exists(item.from)).toBe(false);
    // And the batch it was alone in goes with it, or the list would go on
    // offering a folder that holds nothing.
    await expect(trash().list()).resolves.toStrictEqual([]);
    expect(await repository().readAll()).toHaveLength(1);
    expect(entry.terminalId.value.length).toBeGreaterThan(0);
  });

  it('refuses to write over a record that is in the store now', async () => {
    // The one case where a return would DESTROY something: the id was used
    // again, or the person put the folder back by hand a minute ago.
    const entry = await removedRecord();
    await writeFile(layout.recordFile(entry.terminalId), '{"mine":true}', 'utf8');
    const item = await theOnlyOne();

    await expect(trash().restore(item)).rejects.toThrow(ConflictError);

    expect(await readFile(layout.recordFile(entry.terminalId), 'utf8')).toBe('{"mine":true}');
    expect(await exists(item.from)).toBe(true);
  });

  it('says so rather than inventing an answer when the trash no longer holds it', async () => {
    await sweptWhole();
    const item = await theOnlyOne();
    await rm(item.from, { recursive: true });

    await expect(trash().restore(item)).rejects.toThrow();
  });
});

/*
 * THE POSITIVE CONTROL, and it is the reason this class copies instead of
 * moving.
 *
 * A return that stops half-way must cost nothing: the copy in the trash is the
 * only undo the product has. So the return is dropped deliberately at each of
 * the two points where stopping could eat it -- during the copying, and after
 * the copying but before the trash copy is taken away -- and what is asserted
 * both times is the same thing: the copy in the trash is whole, byte for byte.
 *
 * The drop is injected rather than waited for. The alternative -- a fault the
 * file system produces by itself -- exists on one platform and not the other,
 * and a positive control that runs on Windows only is a control that stops
 * being one the day this is built anywhere else.
 */
describe('a return dropped in the middle spends nothing', () => {
  it('keeps the copy in the trash whole when the copying itself is dropped', async () => {
    const entry = await sweptWhole();
    const item = await theOnlyOne();
    const before = await contentsOf(item.from);
    const fs = jest.requireActual<typeof FsPromises>('node:fs/promises');
    // The real one is held BEFORE the spy replaces it, or the first copy would
    // call the spy again and the drop would land on the first file instead of
    // in the middle -- which is the very thing this is here to distinguish.
    const reallyCopy = fs.copyFile.bind(fs);
    let copies = 0;
    jest.spyOn(fs, 'copyFile').mockImplementation(async (from, to, mode) => {
      copies += 1;
      if (copies > 1) {
        throw Object.assign(new Error('EIO: the machine stopped here'), { code: 'EIO' });
      }
      await reallyCopy(from, to, mode);
    });

    await expect(trash().restore(item)).rejects.toThrow();

    expect(copies).toBe(2);
    // One file had already landed, so this really is the middle of the copying.
    expect(await contentsOf(layout.terminalDir(entry.terminalId))).toStrictEqual({
      'events/2026-08-01.ndjson': JOURNAL_LINE,
    });
    // And what it was copied FROM is untouched: the way back is still there.
    expect(await contentsOf(item.from)).toStrictEqual(before);
    // The record itself never landed. It is copied LAST, so a store that
    // stopped here has no row wearing a history that never arrived.
    expect(await exists(layout.recordFile(entry.terminalId))).toBe(false);
  });

  it('keeps the copy in the trash whole when the drop comes after the copying', async () => {
    const entry = await sweptWhole();
    const item = await theOnlyOne();
    const before = await contentsOf(item.from);
    const fs = jest.requireActual<typeof FsPromises>('node:fs/promises');
    jest.spyOn(fs, 'rm').mockRejectedValue(
      Object.assign(new Error('EBUSY: the machine stopped here'), { code: 'EBUSY' })
    );

    const outcome = await trash().restore(item);

    expect(outcome.trashCopyRemoved).toBe(false);
    expect(await contentsOf(item.from)).toStrictEqual(before);
    // The half that was wanted did happen: the record is in the store.
    expect((await repository().readAll()).map((one) => one.terminalId.value)).toStrictEqual([
      entry.terminalId.value,
    ]);
    expect(logger.warnings.map((line) => line.message)).toContain(
      'a record was brought back, but its copy could not be taken out of the trash'
    );
  });
});
