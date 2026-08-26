import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * `tools/cursor-workbench.js`: which WORKBENCH of the fork a run was measured in.
 *
 * **The defect this exists for, and it is measured rather than feared.** Cursor
 * opens a window in one of two workbenches, and its API says which in no way at
 * all. The Cursor strip's numbers are true of one of them and false of the
 * other: measured 2026-08-25 over 33 launches driving `Cursor.exe` directly,
 * `workbench.action.newGroupBelow` missed 10 of 10 attempts in a GLASS window (5
 * launches of 5, every miss a throw) and 0 of 10 outside glass (12 launches of
 * 12 under `--classic`, 6 of 6 with a folder and no flag). Which one the gate's
 * own stage gets is decided today by an argument that is there for something
 * else -- the folder added by commit `6078beb` makes the fork's
 * `hasExplicitFirstWindowIntent` true, no decision about the first window is
 * taken, and on a fresh profile that decision is the only thing that turns glass
 * on. Drop the folder, or let the fork change how it reads its command line, and
 * the stage measures the other workbench WITHOUT SAYING SO: 10 misses out of 10,
 * a red gate, and a person reading it as a defect of the product.
 *
 * **Two signals, because one is one point of being wrong.** A glass window names
 * its per-window log directory `window1_wb0` where a classic one names it
 * `window1`, and the fork's own extension writes `"layout":"glass"` into a
 * structured log beside it. Both were measured on 2026-08-25 and both were
 * predicted before they were measured: the prediction "no folder and no flag
 * gives glass, 48 extensions, ours absent, 10 misses of 10" came back
 * `window1_wb0`, 68 mentions, 48, absent, 10 of 10.
 *
 * **What this file is NOT about**, and it is the point of the whole tool: it does
 * not decide what the stage ought to measure. It decides whether the stage can
 * SAY what it measured. An unknown workbench is refused rather than guessed --
 * the same choice the gate already makes about a missing `rate.json`, which is
 * RED and never silence.
 */

interface Readings {
  readonly at: string | null;
  readonly windows: readonly string[];
  readonly logFiles: number;
  readonly unreadable: number;
  readonly glassMentions: number;
}

interface Answer {
  readonly is: string;
  readonly because: string;
}

/**
 * Loaded through `createRequire` rather than imported, and the reason is the
 * tool's own.
 *
 * `tools/cursor-workbench.js` is CommonJS because three module systems read it:
 * `tools/gate.mjs` is ESM, `tests/cursor/new-group-below.js` is a Mocha file
 * handed straight to an extension host with nothing compiling it, and this is a
 * Jest suite. A `.d.ts` beside it would be a TypeScript file outside
 * `tsconfig.eslint.json`, which is a lint failure rather than a type -- so the
 * shape is declared here, at the one place that consumes it from TypeScript.
 * This is the arrangement `tools/what-fell.js` already uses.
 */
const load = createRequire(__filename);
const { readWorkbench, whichWorkbench, workbenchOf } = load(
  join(__dirname, '..', '..', 'tools', 'cursor-workbench.js')
) as {
  readWorkbench: (userData: string) => Readings;
  whichWorkbench: (readings: Readings) => Answer;
  workbenchOf: (userData: string) => Answer & { read: Readings };
};

/** One editor launch, as the fork's log tree holds it. */
interface Launch {
  /** The run directory, which the fork names by the second it started. */
  readonly at: string;
  /** Files under that directory, by their path inside it. */
  readonly files: Readonly<Record<string, string>>;
}

const made: string[] = [];

/** A user data directory with the given launches logged under it. */
function profileOf(launches: readonly Launch[]): string {
  const root = mkdtempSync(join(tmpdir(), 'gripterm-workbench-'));
  made.push(root);
  for (const launch of launches) {
    const where = join(root, 'logs', launch.at);
    mkdirSync(where, { recursive: true });
    for (const [name, text] of Object.entries(launch.files)) {
      const full = join(where, name);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text, 'utf8');
    }
  }
  return root;
}

const GLASS_LINE = '[info] {"kind":"workbench","layout":"glass"}\n';
const ORDINARY_LINE = '[info] {"kind":"workbench","layout":"editor"}\n';

/** The readings a case bends, so that each case says only what it is about. */
const CLASSIC_READINGS: Readings = {
  at: '20260826T112825',
  windows: ['window1'],
  logFiles: 47,
  unreadable: 0,
  glassMentions: 0,
};

afterEach(() => {
  while (made.length > 0) {
    rmSync(made.pop() ?? '', { recursive: true, force: true });
  }
});

describe('which workbench of the fork a run was measured in', () => {
  describe('read out of the log tree the run left behind', () => {
    it('names a glass workbench when the window directory and the fork`s own log agree', () => {
      const profile = profileOf([
        { at: '20260826T112825', files: { 'main.log': 'nothing', 'window1_wb0/renderer.log': GLASS_LINE } },
      ]);

      expect(workbenchOf(profile).is).toBe('glass');
    });

    it('names a classic workbench when the window directory is plain and nothing mentions glass', () => {
      const profile = profileOf([
        { at: '20260826T112825', files: { 'main.log': 'nothing', 'window1/renderer.log': ORDINARY_LINE } },
      ]);

      expect(workbenchOf(profile).is).toBe('classic');
    });

    /*
     * The whole reason there are two signals. Either one alone would answer
     * here, and answering would be the failure: a run whose two readings
     * disagree has not established anything, and the budget's numbers have
     * nowhere to be filed.
     */
    it('refuses to name one when the two signals disagree, and says both readings', () => {
      const profile = profileOf([
        { at: '20260826T112825', files: { 'window1_wb0/renderer.log': ORDINARY_LINE } },
      ]);

      const answer = workbenchOf(profile);

      expect(answer.is).toBe('unknown');
      expect(answer.because).toContain('window1_wb0');
    });

    it('refuses when the profile has no log tree at all', () => {
      const profile = mkdtempSync(join(tmpdir(), 'gripterm-workbench-'));
      made.push(profile);

      expect(workbenchOf(profile).is).toBe('unknown');
    });

    /*
     * `grep ... || echo 0` printed nought both when there were no matches and
     * when there was no file, and put a false claim in a commit of this
     * repository. Nought mentions across nought log files is that same sentence.
     */
    it('refuses when no log file was read, because nought mentions of nothing is not a reading', () => {
      const profile = profileOf([{ at: '20260826T112825', files: { 'window1/.keep': '' } }]);

      expect(workbenchOf(profile).is).toBe('unknown');
    });

    it('reads the newest launch and not the first one it finds', () => {
      const profile = profileOf([
        { at: '20260826T112825', files: { 'window1_wb0/renderer.log': GLASS_LINE } },
        { at: '20260826T113901', files: { 'window1/renderer.log': ORDINARY_LINE } },
      ]);

      const answer = workbenchOf(profile);

      expect(answer.read.at).toBe('20260826T113901');
      expect(answer.is).toBe('classic');
    });

    /*
     * The readings and not only the conclusion, because a conclusion nobody can
     * recount is a claim. A person opening `rate.json` a month from now has the
     * two numbers the answer was made from and the directory they came out of.
     */
    it('records the readings the answer was made from, so that a reader can recount it', () => {
      const profile = profileOf([
        {
          at: '20260826T112825',
          files: {
            'main.log': 'nothing',
            'window1_wb0/renderer.log': `${GLASS_LINE}${GLASS_LINE}`,
            'window1_wb0/exthost.log': GLASS_LINE,
          },
        },
      ]);

      expect(workbenchOf(profile).read).toStrictEqual({
        at: '20260826T112825',
        windows: ['window1_wb0'],
        logFiles: 3,
        unreadable: 0,
        glassMentions: 3,
      });
    });

    it('counts every occurrence of the line rather than every file holding one', () => {
      const profile = profileOf([
        { at: '20260826T112825', files: { 'window1_wb0/renderer.log': `${GLASS_LINE}${GLASS_LINE}` } },
      ]);

      expect(readWorkbench(profile).glassMentions).toBe(2);
    });
  });

  /*
   * The decision, apart from the reading. It is a pure function of five numbers
   * so that the cases a real profile cannot be made to produce on demand -- a
   * log held open by the process that is writing it, which is what a Windows
   * `.log` is at the moment this runs -- are cases a test can still state.
   */
  describe('the decision, over readings a profile cannot be made to produce on demand', () => {
    it('names glass on a mention it did find, even where some logs could not be opened', () => {
      const answer = whichWorkbench({
        ...CLASSIC_READINGS,
        windows: ['window1_wb0'],
        logFiles: 47,
        unreadable: 12,
        glassMentions: 3,
      });

      expect(answer.is).toBe('glass');
    });

    /*
     * The asymmetry is deliberate and it is the safe direction. A mention FOUND
     * is evidence whatever else went unread; a mention NOT found is evidence
     * only about the files that were actually opened.
     */
    it('refuses when every log was unreadable, because nought mentions is then a reading of nothing', () => {
      const answer = whichWorkbench({ ...CLASSIC_READINGS, logFiles: 47, unreadable: 47 });

      expect(answer.is).toBe('unknown');
      expect(answer.because).toContain('47');
    });

    it('refuses when the launch left no window directory to name', () => {
      expect(whichWorkbench({ ...CLASSIC_READINGS, windows: [] }).is).toBe('unknown');
    });

    it('refuses a window directory shaped like neither, rather than reading it as the ordinary one', () => {
      expect(whichWorkbench({ ...CLASSIC_READINGS, windows: ['window'] }).is).toBe('unknown');
    });

    it('says which two readings it made, whatever it concludes', () => {
      expect(whichWorkbench(CLASSIC_READINGS).because).toContain('window1');
      expect(whichWorkbench(CLASSIC_READINGS).because).toContain('47');
    });
  });
});
