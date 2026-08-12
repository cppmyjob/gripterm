import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ConflictError,
  FileOwnerPresence,
  OwnerId,
  StorageLayout,
  ValidationError,
  encodePresence,
  writeJsonFile,
} from '../../packages/core/src/index';
import type { OwnerIdentity, PresenceDocument, SignalProbe } from '../../packages/core/src/index';
import { FixedClock, RecordingLogger } from '../helpers/port-fakes';
import { makeOwnerIdentity } from '../helpers/domain-fixtures';

/**
 * The object that decides whether another window's terminals may be taken.
 *
 * Its mistakes are not symmetric, and every test here is written from that
 * asymmetry: calling a LIVE window dead authorises a second `claude --resume` on
 * a conversation that already has one, while calling a dead window `unknown`
 * costs a person one confirmation click. So the interesting rows of the table
 * are the ones where a naive implementation would say `dead` -- `EPERM`, and a
 * heartbeat that has merely gone stale.
 */

const NOW = new Date('2026-08-12T10:00:00.000Z');
const STARTED = new Date('2026-08-12T09:00:00.000Z');

/** The machine booted two hours before `NOW`, so nothing here trips the boot rule by accident. */
const BOOTED_HOURS_AGO_S = 7200;

const MINE = 'window-activation-1';
const A_MINUTE_MS = 60_000;
/** Exactly one freshness window back, which the table calls stale. */
const NOW_A_MINUTE_AGO = new Date(NOW.getTime() - A_MINUTE_MS);

interface Parts {
  readonly probe?: SignalProbe;
  readonly uptimeSeconds?: () => number;
}

let base = '';
let layout: StorageLayout;
let clock: FixedClock;
let logger: RecordingLogger;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'gripterm-presence-'));
  layout = new StorageLayout(base);
  clock = new FixedClock(NOW);
  logger = new RecordingLogger();
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function presenceOf(parts: Parts = {}): FileOwnerPresence {
  return new FileOwnerPresence({
    layout,
    clock,
    logger,
    uptimeSeconds: () => BOOTED_HOURS_AGO_S,
    ...parts,
  });
}

/** A probe that fails the way `process.kill` does, with the code that matters. */
function refusing(code: string): SignalProbe {
  return (): never => {
    throw Object.assign(new Error(`kill: ${code}`), { code });
  };
}

function identityWith(pid: number, ownerId = MINE): OwnerIdentity {
  return { ...makeOwnerIdentity(ownerId), pid };
}

function documentFor(heartbeatAt: Date, pid = process.pid, ownerId = MINE): PresenceDocument {
  return encodePresence({ identity: identityWith(pid, ownerId), startedAt: STARTED, heartbeatAt });
}

async function writeOwnerFile(name: string, document: unknown): Promise<void> {
  await mkdir(layout.ownersDir, { recursive: true });
  await writeJsonFile(join(layout.ownersDir, `${name}.json`), document);
}

/** A probe that answers ESRCH for one pid and nothing for the rest. */
function goneFor(gone: number): SignalProbe {
  return (pid): void => {
    if (pid === gone) {
      throw Object.assign(new Error('kill: ESRCH'), { code: 'ESRCH' });
    }
  };
}

async function readOwnerFile(ownerId: string): Promise<PresenceDocument> {
  const text = await readFile(join(layout.ownersDir, `${ownerId}.json`), 'utf8');
  return JSON.parse(text) as PresenceDocument;
}

describe('the liveness table of §4.8', () => {
  it('calls a window with no file dead, because only retiring removes one', async () => {
    await expect(presenceOf().livenessOf(OwnerId.fromString(MINE))).resolves.toBe('dead');
  });

  it('calls a running process with a fresh heartbeat live', async () => {
    // No probe passed: this row goes through the real `process.kill(pid, 0)`
    // against the pid of the process running the test, which is the one pid a
    // test can be certain about.
    await writeOwnerFile(MINE, documentFor(NOW));

    await expect(presenceOf().livenessOf(OwnerId.fromString(MINE))).resolves.toBe('live');
  });

  it('calls a running process with a stale heartbeat unknown, never dead', async () => {
    // This is the window that woke from sleep, or the one whose extension host
    // is busy. `dead` here would hand its conversations to another window.
    await writeOwnerFile(MINE, documentFor(new Date(NOW.getTime() - A_MINUTE_MS - 1000)));

    await expect(presenceOf().livenessOf(OwnerId.fromString(MINE))).resolves.toBe('unknown');
  });

  it('treats a heartbeat exactly sixty seconds old as already stale', async () => {
    await writeOwnerFile(MINE, documentFor(new Date(NOW.getTime() - A_MINUTE_MS)));

    await expect(presenceOf().livenessOf(OwnerId.fromString(MINE))).resolves.toBe('unknown');
  });

  it('calls ESRCH dead', async () => {
    await writeOwnerFile(MINE, documentFor(NOW, 4242));

    const presence = presenceOf({ probe: refusing('ESRCH') });

    await expect(presence.livenessOf(OwnerId.fromString(MINE))).resolves.toBe('dead');
  });

  /*
   * The row this file exists for. Measured on this machine: `process.kill` on a
   * process belonging to another user throws `EPERM`, not `ESRCH` -- the process
   * is THERE and merely not ours to signal. A `catch { return false }` would
   * call an editor started as administrator dead while it is running, and both
   * of them share one `~/.gripterm`.
   */
  it('calls EPERM alive, because a process we may not signal is still a process', async () => {
    await writeOwnerFile(MINE, documentFor(NOW, 4242));

    const presence = presenceOf({ probe: refusing('EPERM') });

    await expect(presence.livenessOf(OwnerId.fromString(MINE))).resolves.toBe('live');
  });

  it('calls EPERM with a stale heartbeat unknown, and still not dead', async () => {
    await writeOwnerFile(MINE, documentFor(new Date(NOW.getTime() - A_MINUTE_MS), 4242));

    const presence = presenceOf({ probe: refusing('EPERM') });

    await expect(presence.livenessOf(OwnerId.fromString(MINE))).resolves.toBe('unknown');
  });

  it('calls a heartbeat older than the machine booted dead, whatever the pid answers', async () => {
    // The rule that removes the whole cross-boot class of pid reuse. The pid
    // here is a process that really is running -- ours -- and the answer is
    // still `dead`, because no process alive now wrote that heartbeat.
    await writeOwnerFile(MINE, documentFor(new Date(NOW.getTime() - 5 * A_MINUTE_MS)));

    const presence = presenceOf({ uptimeSeconds: () => 60 });

    await expect(presence.livenessOf(OwnerId.fromString(MINE))).resolves.toBe('dead');
  });

  it('applies the boot rule against the real uptime of this machine', async () => {
    // Neither the uptime nor the probe is injected here, so the two system
    // readings this class makes are exercised as themselves at least once. A
    // heartbeat stamped at the epoch is before any boot of any machine.
    await writeOwnerFile(MINE, documentFor(new Date(0)));

    const presence = new FileOwnerPresence({ layout, clock, logger });

    await expect(presence.livenessOf(OwnerId.fromString(MINE))).resolves.toBe('dead');
  });
});

describe('a presence file that cannot be trusted', () => {
  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
  ])('refuses a %s pid rather than answering about it', async (_name, pid) => {
    // Refused where it enters, because neither answer would be true: `kill(0, 0)`
    // signals the process GROUP and never throws, so zero would read as alive
    // forever, while a negative pid gives ESRCH and would read as adoptable.
    await writeOwnerFile(MINE, { ...documentFor(NOW), pid });

    await expect(presenceOf().livenessOf(OwnerId.fromString(MINE))).resolves.toBe('unknown');
  });

  it.each([
    ['kind', 'kind'],
    ['editorKind', 'editorKind'],
    ['editorVersion', 'editorVersion'],
    ['workspaceFolders', 'workspaceFolders'],
    ['startedAt', 'startedAt'],
    ['heartbeatAt', 'heartbeatAt'],
    ['ownerId', 'ownerId'],
  ])('refuses a file with no %s', async (_name, field) => {
    const good: Record<string, unknown> = { ...documentFor(NOW) };
    const without = Object.fromEntries(Object.entries(good).filter(([key]) => key !== field));

    await writeOwnerFile(MINE, without);

    await expect(presenceOf().livenessOf(OwnerId.fromString(MINE))).resolves.toBe('unknown');
  });

  it.each([
    ['an owner kind', { kind: 'daemon' }],
    ['an editor', { editorKind: 'emacs' }],
  ])('refuses a file naming %s this build does not know', async (_name, override) => {
    await writeOwnerFile(MINE, { ...documentFor(NOW), ...override });

    await expect(presenceOf().livenessOf(OwnerId.fromString(MINE))).resolves.toBe('unknown');
  });

  it('refuses a file that is not a JSON object at all', async () => {
    await writeOwnerFile(MINE, [documentFor(NOW)]);

    await expect(presenceOf().livenessOf(OwnerId.fromString(MINE))).resolves.toBe('unknown');
  });

  it('refuses a file that is not JSON, and says which file', async () => {
    await mkdir(layout.ownersDir, { recursive: true });
    await writeFile(join(layout.ownersDir, `${MINE}.json`), '{ half a fil', 'utf8');

    await expect(presenceOf().livenessOf(OwnerId.fromString(MINE))).resolves.toBe('unknown');
    expect(logger.warnings[0]?.message).toContain('could not be read');
    expect(logger.warnings[0]?.details?.path).toContain(`${MINE}.json`);
  });

  /*
   * The failure M2.1's refusal of unsafe owner ids was written against, met from
   * the reading side: a file that is not about the window it is named for. On a
   * case-folding file system two ids can land in one file, and the window whose
   * heartbeat goes into somebody else's file looks dead while it is running.
   */
  it('refuses a file whose contents belong to a different window', async () => {
    await writeOwnerFile(MINE, documentFor(NOW, process.pid, 'window-activation-2'));

    await expect(presenceOf().livenessOf(OwnerId.fromString(MINE))).resolves.toBe('unknown');
    expect(logger.warnings[0]?.details?.reason).toContain('window-activation-2');
  });

  it('answers unknown for an id that could never name a file, and touches no disk', async () => {
    const presence = presenceOf();

    await expect(presence.livenessOf(OwnerId.fromString('../CON'))).resolves.toBe('unknown');
    expect(logger.warnings[0]?.message).toContain('could not name a presence file');
  });
});

describe('announcing this window', () => {
  it('writes a file a person can read, stamped now on both times', async () => {
    const presence = presenceOf();

    await presence.announce(identityWith(process.pid));

    expect(await readOwnerFile(MINE)).toStrictEqual({
      ownerId: MINE,
      kind: 'window',
      pid: process.pid,
      editorKind: 'vscode',
      editorVersion: '1.132.0',
      workspaceFolders: ['D:/Projects/foo'],
      startedAt: NOW.getTime(),
      heartbeatAt: NOW.getTime(),
    });
  });

  it('creates owners/ when the store has never held one', async () => {
    const presence = presenceOf();

    await presence.announce(identityWith(process.pid));

    await expect(presence.livenessOf(OwnerId.fromString(MINE))).resolves.toBe('live');
  });

  it('refuses an id that cannot be a file name, and stays un-announced', async () => {
    const presence = presenceOf();

    await expect(presence.announce(identityWith(process.pid, 'CON'))).rejects.toThrow(
      ValidationError
    );
    // The refusal has to leave the object where it was: a heartbeat that
    // believed the announcement had happened would write nothing, forever,
    // while reporting nothing at all.
    await expect(presence.heartbeat()).rejects.toThrow(ConflictError);
  });
});

describe('the heartbeat', () => {
  it('moves the beat and leaves the start where it was', async () => {
    const presence = presenceOf();
    await presence.announce(identityWith(process.pid));

    clock.advance(A_MINUTE_MS);
    await presence.heartbeat();

    expect(await readOwnerFile(MINE)).toMatchObject({
      startedAt: NOW.getTime(),
      heartbeatAt: NOW.getTime() + A_MINUTE_MS,
    });
  });

  it('brings a window that had gone stale back, with no record of the gap', async () => {
    // The reverse transition is free by construction: `detached` is never
    // written down (§4.3), so a fresh beat restores the picture by itself.
    const presence = presenceOf();
    await presence.announce(identityWith(process.pid));
    clock.advance(5 * A_MINUTE_MS);

    await expect(presence.livenessOf(OwnerId.fromString(MINE))).resolves.toBe('unknown');
    await presence.heartbeat();
    await expect(presence.livenessOf(OwnerId.fromString(MINE))).resolves.toBe('live');
  });

  it('refuses to beat before the window has announced itself', async () => {
    await expect(presenceOf().heartbeat()).rejects.toThrow(ConflictError);
  });

  it('refuses to beat after the window has retired, and does not recreate the file', async () => {
    const presence = presenceOf();
    await presence.announce(identityWith(process.pid));
    await presence.retire();

    await expect(presence.heartbeat()).rejects.toThrow(ConflictError);
    await expect(presence.livenessOf(OwnerId.fromString(MINE))).resolves.toBe('dead');
  });
});

describe('retiring', () => {
  it('removes the file, which is what makes this window dead to the others', async () => {
    const presence = presenceOf();
    await presence.announce(identityWith(process.pid));

    await presence.retire();

    await expect(presence.livenessOf(OwnerId.fromString(MINE))).resolves.toBe('dead');
    await expect(presence.survey()).resolves.toStrictEqual([]);
  });

  it('can be called twice, because a disposal path runs more than once', async () => {
    const presence = presenceOf();
    await presence.announce(identityWith(process.pid));

    await presence.retire();

    await expect(presence.retire()).resolves.toBeUndefined();
  });

  it('refuses before the window has announced itself', async () => {
    await expect(presenceOf().retire()).rejects.toThrow(ConflictError);
  });

  it('is undone by announcing again', async () => {
    const presence = presenceOf();
    await presence.announce(identityWith(process.pid));
    await presence.retire();

    await presence.announce(identityWith(process.pid));

    await expect(presence.livenessOf(OwnerId.fromString(MINE))).resolves.toBe('live');
    await expect(presence.heartbeat()).resolves.toBeUndefined();
  });
});

/*
 * The directory as its collector meets it, which is a different question from
 * `livenessOf` and not a convenience over it. The reconciler (M2.12) has to see
 * the files it cannot READ -- those are exactly the ones liveness can never
 * settle, and therefore the only ones nothing else would ever take away.
 */
describe('surveying the windows on this machine', () => {
  it('says nobody rather than failing when no window has ever announced', async () => {
    await expect(presenceOf().survey()).resolves.toStrictEqual([]);
    expect(logger.infos[0]?.message).toContain('no window has announced itself');
  });

  it('gives every file the same verdict `livenessOf` would', async () => {
    // One file per row of the table, in one pass. The point is not that the
    // verdicts are right -- that is the table's own suite above -- but that
    // asking about the whole directory answers the same as asking one by one.
    await writeOwnerFile(MINE, documentFor(NOW));
    await writeOwnerFile('window-asleep', documentFor(NOW_A_MINUTE_AGO, process.pid, 'window-asleep'));
    await writeOwnerFile('window-that-closed', documentFor(NOW, 4242, 'window-that-closed'));

    const presence = presenceOf({ probe: goneFor(4242) });
    const surveyed = await presence.survey();

    expect(surveyed.map((row) => [row.name, row.liveness])).toStrictEqual([
      [MINE, 'live'],
      ['window-asleep', 'unknown'],
      ['window-that-closed', 'dead'],
    ]);
    for (const row of surveyed) {
      await expect(presence.livenessOf(OwnerId.fromString(row.name))).resolves.toBe(row.liveness);
    }
  });

  it('applies the boot rule here too: a heartbeat older than the boot is dead at any pid', async () => {
    // The pid is this very process, so the probe cannot be what settles it.
    await writeOwnerFile(MINE, documentFor(new Date(NOW.getTime() - BOOTED_HOURS_AGO_S * 1000 - 1)));

    const surveyed = await presenceOf().survey();

    expect(surveyed.map((row) => row.liveness)).toStrictEqual(['dead']);
  });

  it('shows a file it cannot read, with no identity and nothing established', async () => {
    await writeOwnerFile(MINE, documentFor(NOW));
    await writeOwnerFile('window-activation-2', { ...documentFor(NOW), pid: 0 });

    const surveyed = await presenceOf().survey();

    expect(surveyed.map((row) => [row.name, row.identity === null, row.liveness])).toStrictEqual([
      [MINE, false, 'live'],
      ['window-activation-2', true, 'unknown'],
    ]);
    expect(logger.warnings[0]?.details?.path).toContain('window-activation-2.json');
  });

  it('shows a file named for one window that says it is another as unreadable', async () => {
    // The check M2.1's refusal of unsafe ids exists for, met from the reading
    // side: a file whose name and contents disagree is a file nothing may be
    // concluded from, including that its window is gone.
    await writeOwnerFile('window-activation-2', documentFor(NOW, process.pid, MINE));

    const surveyed = await presenceOf().survey();

    expect(surveyed.map((row) => [row.name, row.identity === null])).toStrictEqual([
      ['window-activation-2', true],
    ]);
  });

  it('ignores what is not an owner file: a subdirectory, and a file of another kind', async () => {
    await writeOwnerFile(MINE, documentFor(NOW));
    await mkdir(join(layout.ownersDir, 'window-activation-2.json'), { recursive: true });
    await writeFile(join(layout.ownersDir, 'notes.txt'), 'not ours', 'utf8');

    const surveyed = await presenceOf().survey();

    expect(surveyed.map((row) => row.name)).toStrictEqual([MINE]);
  });
});

/*
 * Collection is the only operation here that destroys anything, so it goes
 * through the trash rather than through `rm` (§I.3). The file it takes away is
 * usually worthless -- but the two cases that make the rule are the ones where
 * it is not: a file that fails to decode may be failing because of a defect in
 * OUR decoder, and deleting every instance of the evidence is how such a defect
 * survives its own report; or because a newer build wrote it, in which case it
 * belongs to a window that is running.
 */
describe('collecting a presence file', () => {
  it('moves it to the trash rather than deleting it, and it is readable there', async () => {
    await writeOwnerFile('window-that-closed', documentFor(NOW, 4242, 'window-that-closed'));

    await presenceOf().collect('window-that-closed.json');

    await expect(presenceOf().survey()).resolves.toStrictEqual([]);
    const discarded = layout.discardedOwnerFile(NOW, 'window-that-closed.json');
    await expect(readFile(discarded, 'utf8')).resolves.toContain('window-that-closed');
  });

  it('takes a file that does not decode, since that is the whole point of it', async () => {
    await mkdir(layout.ownersDir, { recursive: true });
    await writeFile(join(layout.ownersDir, 'window-half-written.json'), '{not json', 'utf8');

    await presenceOf().collect('window-half-written.json');

    await expect(presenceOf().survey()).resolves.toStrictEqual([]);
  });

  it('is silent about a file that is already gone', async () => {
    await expect(presenceOf().collect('window-never-was.json')).resolves.toBeUndefined();
  });

  it('reports any other refusal instead of swallowing it', async () => {
    // Absence is the ONE failure that means agreement. Everything else -- a
    // locked file, a directory in the way -- has to reach the caller, or a
    // machine where collection can never succeed sweeps silently for ever.
    await writeOwnerFile('window-that-closed', documentFor(NOW, 4242, 'window-that-closed'));
    const occupied = layout.discardedOwnerFile(NOW, 'window-that-closed.json');
    await mkdir(occupied, { recursive: true });
    await writeFile(join(occupied, 'in-the-way'), 'not a place for a file', 'utf8');

    await expect(presenceOf().collect('window-that-closed.json')).rejects.toThrow();
  });

  it('refuses a name that is a path rather than a file', async () => {
    // The names it is called with come from `readdir`, so they are single
    // components by construction -- which is exactly why the guard is here and
    // not argued about: the day one arrives from somewhere else, it refuses.
    await expect(presenceOf().collect('../version')).rejects.toThrow(ValidationError);
    await expect(presenceOf().collect('nested/thing.json')).rejects.toThrow(ValidationError);
    await expect(presenceOf().collect('')).rejects.toThrow(ValidationError);
  });

  it('refuses to collect the file this window is announcing itself with', async () => {
    // A window that removes its own presence file goes on beating into nothing
    // and looks dead to everybody, which is the one mistake in this class that
    // hands its own conversations away.
    const presence = presenceOf();
    await presence.announce(identityWith(process.pid));

    await expect(presence.collect(`${MINE}.json`)).rejects.toThrow(ConflictError);
    await expect(presence.livenessOf(OwnerId.fromString(MINE))).resolves.toBe('live');
  });
});
