import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { KEPT_TRACES, keepRun, runDirectories, whatIsCopied } from './keepsake';
import type { RunPlaces } from './keepsake';

/**
 * That the trace of a red run outlives the run that comes after it.
 *
 * **The defect this exists for, and it cost a day.** On 2026-08-25 the full gate
 * went red on the stand, an agent was sent to take that run apart, and it could
 * not: `prepare()` empties three directories at the start of every run -- the
 * recording and the verdict, the store the product wrote in, and the editor's
 * own logs with `exthost.log` in them. The agent proved the mechanism on ITS
 * run, which is a different run. And the second run always happens, because the
 * first thing a person does when they see red is run it again.
 *
 * **Why the check is worth writing down at all.** "Keep the red ones" is easy to
 * write and easy to write in a place the next run reaches anyway. So the claim
 * here is not "something was copied": it is that after the emptying THE NEXT RUN
 * REALLY DOES -- `runDirectories`, the same list `prepare()` deletes, not an
 * imitation of it -- the trace still reads. Nothing below simulates the next
 * run; it calls the function the next run calls.
 *
 * Every tree here is built by this suite under the system's temporary directory
 * and deleted after. Nothing reads, writes or names the store the owner of this
 * machine keeps their own terminals in.
 */

/** Long enough ago to be plainly not this run, and a fixed point for the names. */
const A_MOMENT = new Date('2026-08-25T19:08:33.123Z');

/** The same layout `tests/stand/run.mjs` builds its constants out of. */
function placesUnder(home: string, label: string): RunPlaces {
  const base = join(home, '.vscode-test');
  return {
    base,
    userData: join(base, `user-data-${label}`),
    store: join(base, `store-${label}`),
    output: join(base, `${label}-output`),
    keepsakes: join(base, `${label}-red`),
  };
}

interface Written {
  readonly what: string;
  readonly where: string;
  readonly text: string;
}

/** What a run of the stand leaves behind it, in the places it leaves it. */
function aRunThatHappened(options: { verdict: boolean } = { verdict: true }): {
  places: RunPlaces;
  written: readonly Written[];
  home: string;
} {
  const home = mkdtempSync(join(tmpdir(), 'gripterm-keepsake-'));
  const places = placesUnder(home, 'stand');
  const written: Written[] = [
    { what: 'the recording', where: join(places.output, 'recording.ndjson'), text: '{"kind":"stand","version":1}\n' },
    { what: 'the product log', where: join(places.store, 'logs', 'a0b1c2d3.log'), text: 'the product said something\n' },
    { what: 'a record', where: join(places.store, 'terminals', 'one', 'record.json'), text: '{"order":null}\n' },
    {
      what: 'the extension host log',
      where: join(places.userData, 'logs', '20260825T190609', 'window1', 'exthost', 'exthost.log'),
      text: 'the host said something\n',
    },
    { what: 'what the window was told', where: join(places.userData, 'User', 'settings.json'), text: '{"gripterm.storage.path":"somewhere"}\n' },
  ];
  if (options.verdict) {
    written.push({ what: 'the verdict', where: join(places.output, 'verdict.json'), text: '{"red":true}\n' });
  }
  for (const one of written) {
    mkdirSync(join(one.where, '..'), { recursive: true });
    writeFileSync(one.where, one.text, 'utf8');
  }
  // The forty megabytes of caches an editor leaves beside its logs, so that a
  // rule which copied the user data directory wholesale would be visible here
  // rather than on somebody's disk three weeks later.
  mkdirSync(join(places.userData, 'Cache'), { recursive: true });
  writeFileSync(join(places.userData, 'Cache', 'data_0'), 'x'.repeat(200_000), 'utf8');
  mkdirSync(join(places.userData, 'User', 'workspaceStorage', 'deadbeef'), { recursive: true });
  writeFileSync(join(places.userData, 'User', 'workspaceStorage', 'deadbeef', 'state.vscdb'), 'y'.repeat(200_000), 'utf8');
  return { places, written, home };
}

/** What the next run does to the places this one worked in, by calling what it calls. */
function theNextRunStarts(places: RunPlaces): void {
  for (const directory of runDirectories(places)) {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Every file under a directory, by its path relative to it. */
function filesUnder(directory: string): readonly string[] {
  const found: string[] = [];
  const walk = (at: string, prefix: string): void => {
    for (const entry of readdirSync(at)) {
      const path = join(at, entry);
      if (statSync(path).isDirectory()) {
        walk(path, `${prefix}${entry}/`);
      } else {
        found.push(`${prefix}${entry}`);
      }
    }
  };
  walk(directory, '');
  return found.sort();
}

describe('the trace of a run that was not green', () => {
  it('still reads after the next run has emptied everything the run worked in', () => {
    const { places, written, home } = aRunThatHappened();
    try {
      const kept = keepRun(places, 'red', A_MOMENT);
      expect(kept).not.toBeNull();

      theNextRunStarts(places);
      for (const one of written) {
        expect(existsSync(one.where)).toBe(false);
      }

      const at = kept?.at ?? '';
      expect(readFileSync(join(at, 'output', 'recording.ndjson'), 'utf8')).toBe('{"kind":"stand","version":1}\n');
      expect(readFileSync(join(at, 'output', 'verdict.json'), 'utf8')).toBe('{"red":true}\n');
      expect(readFileSync(join(at, 'store', 'logs', 'a0b1c2d3.log'), 'utf8')).toBe('the product said something\n');
      expect(readFileSync(join(at, 'store', 'terminals', 'one', 'record.json'), 'utf8')).toBe('{"order":null}\n');
      expect(
        readFileSync(join(at, 'editor-logs', '20260825T190609', 'window1', 'exthost', 'exthost.log'), 'utf8')
      ).toBe('the host said something\n');
      expect(readFileSync(join(at, 'settings.json'), 'utf8')).toBe('{"gripterm.storage.path":"somewhere"}\n');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('says in the directory name which run it belongs to, and what became of it', () => {
    const { places, home } = aRunThatHappened();
    try {
      const red = keepRun(places, 'red', A_MOMENT);
      const later = keepRun(places, 'red', new Date('2026-08-25T19:14:00.000Z'));
      // No colon: a name is a directory on a file system that has no colons in
      // them. Fixed width, so that sorting the names sorts the runs.
      expect(basename(red?.at ?? '')).toBe('2026-08-25T19-08-33.123Z-red');
      expect(basename(later?.at ?? '')).toBe('2026-08-25T19-14-00.000Z-red');
      expect(readdirSync(places.keepsakes)).toHaveLength(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('is kept for a run that died before there was a verdict at all', () => {
    const { places, home } = aRunThatHappened({ verdict: false });
    try {
      const kept = keepRun(places, 'died', A_MOMENT);
      expect(basename(kept?.at ?? '')).toBe('2026-08-25T19-08-33.123Z-died');
      expect(readFileSync(join(kept?.at ?? '', 'output', 'recording.ndjson'), 'utf8')).toBe('{"kind":"stand","version":1}\n');
      expect(existsSync(join(kept?.at ?? '', 'output', 'verdict.json'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('says what it holds, in the trace, without naming the machine it was measured on', () => {
    const { places, home } = aRunThatHappened();
    try {
      const kept = keepRun(places, 'red', A_MOMENT);
      const said = readFileSync(join(kept?.at ?? '', 'kept.json'), 'utf8');
      expect(JSON.parse(said)).toMatchObject({
        outcome: 'red',
        startedAt: A_MOMENT.toISOString(),
      });
      // Relative to `.vscode-test` and no further up: a trace is a thing people
      // paste into reports, and the tree above it is somebody's home.
      expect(said).not.toContain(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('what a trace holds and what it deliberately leaves behind', () => {
  it('copies the four named places and nothing else out of the run', () => {
    const { places, home } = aRunThatHappened();
    try {
      expect(whatIsCopied(places).map((one) => one.as)).toEqual(['output', 'store', 'editor-logs', 'settings.json']);
      const kept = keepRun(places, 'red', A_MOMENT);
      const held = filesUnder(kept?.at ?? '');
      expect(held).not.toContain('Cache/data_0');
      expect(held.some((one) => one.includes('workspaceStorage'))).toBe(false);
      expect(held.some((one) => one.includes('state.vscdb'))).toBe(false);
      // Under a megabyte, against the forty an editor's user data directory is.
      expect(kept?.bytes ?? Infinity).toBeLessThan(1_000_000);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('holds no more than the newest KEPT_TRACES of them, and says which it took away', () => {
    const { places, home } = aRunThatHappened();
    try {
      const made: string[] = [];
      for (let minute = 0; minute < KEPT_TRACES + 2; minute += 1) {
        const at = new Date(A_MOMENT.getTime() + minute * 60_000);
        const kept = keepRun(places, 'red', at);
        made.push(basename(kept?.at ?? ''));
      }
      const left = readdirSync(places.keepsakes).sort();
      expect(left).toHaveLength(KEPT_TRACES);
      expect(left).toEqual(made.slice(-KEPT_TRACES).sort());
      const last = keepRun(places, 'red', new Date(A_MOMENT.getTime() + 60_000 * (KEPT_TRACES + 2)));
      expect(last?.removed).toEqual([made[2]]);
      expect(last?.traces).toBe(KEPT_TRACES);
      // All of them together and not just this one. It is the number the ceiling
      // is read from, and a ceiling read off a single trace would never be
      // reached by a count of them growing.
      expect(last?.keptBytes ?? 0).toBeGreaterThan((last?.bytes ?? 0) * (KEPT_TRACES - 1));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps nothing for a green run, and takes nothing away from a red one', () => {
    const { places, home } = aRunThatHappened();
    try {
      const red = keepRun(places, 'red', A_MOMENT);
      const held = filesUnder(red?.at ?? '');
      expect(keepRun(places, 'green', new Date(A_MOMENT.getTime() + 60_000))).toBeNull();
      expect(readdirSync(places.keepsakes)).toEqual([basename(red?.at ?? '')]);
      expect(filesUnder(red?.at ?? '')).toEqual(held);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('the refusal that stands in front of every path this touches', () => {
  it('refuses to keep anything when the tree it was handed is not a `.vscode-test`', () => {
    const home = mkdtempSync(join(tmpdir(), 'gripterm-keepsake-'));
    try {
      const places = { ...placesUnder(home, 'stand'), base: home };
      expect(() => keepRun(places, 'red', A_MOMENT)).toThrow(/\.vscode-test/u);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    ['store', 'the store it would copy'],
    ['output', 'the record it would copy'],
    ['userData', 'the editor logs it would copy'],
    ['keepsakes', 'the place it would write'],
  ])('refuses when %s is not under that tree', (which) => {
    const { places, home } = aRunThatHappened();
    try {
      const elsewhere = { ...places, [which]: join(home, 'somewhere-else') };
      expect(() => keepRun(elsewhere, 'red', A_MOMENT)).toThrow(/is not under/u);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('refuses a directory beside the tree whose name merely starts with it', () => {
    const { places, home } = aRunThatHappened();
    try {
      const beside = { ...places, output: `${places.base}-elsewhere` };
      expect(() => keepRun(beside, 'red', A_MOMENT)).toThrow(/is not under/u);
      expect(() => runDirectories(beside)).toThrow(/is not under/u);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('names, as the list the next run empties, the three directories a run works in', () => {
    const { places, home } = aRunThatHappened();
    try {
      expect(runDirectories(places)).toEqual([places.userData, places.store, places.output]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
