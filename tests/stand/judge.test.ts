import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUDGET, judge } from './judge';
import { FILE_OPENED, parseRecording } from './recording';
import type { Answer, Verdict } from './judge';
import type { GridNode, StandGroup, StandRecording, StandSitting, StandSnapshot } from './recording';

/**
 * The judge of the two-sitting stand, over recordings and nothing else.
 *
 * The stand is cut in two so that this file can exist: the MEASURER starts a
 * real editor several times over one project folder and writes down what it
 * saw, and the JUDGE is a function from those sightings to a verdict. Only the
 * first half needs a machine with an editor on it.
 *
 * The cut is what makes the acceptance of ??5 possible at all. A stand judged
 * only by "it goes red on the staircase" is satisfied by a stand that is red
 * unconditionally, and the two cannot be told apart from outside. So both halves
 * are asserted here, over two recordings that are as different as the question
 * needs:
 *
 *   * `staircase-2026-08-23.ndjson` -- seven real sittings in Cursor, in which
 *     the editor groups went 2, 2, 4, 5, 6, 7, 8 and no record ever came back
 *     through `--resume`;
 *   * `healthy-substituted.ndjson` -- a window that was never launched, written
 *     by hand to be what a healthy one would have looked like.
 *
 * Neither of them needs an editor to run, which is why they run here.
 */

const FIXTURES = join(__dirname, 'fixtures');

function fixture(name: string): StandRecording {
  return parseRecording(readFileSync(join(FIXTURES, `${name}.ndjson`), 'utf8'));
}

function answerTo(verdict: Verdict, point: number): Answer {
  const found = verdict.findings.find((one) => one.point === point);
  if (found === undefined) {
    throw new Error(`the verdict says nothing about point ${point}`);
  }
  return found.answer;
}

function saidAbout(verdict: Verdict, point: number): string {
  const found = verdict.findings.find((one) => one.point === point);
  return found === undefined ? '' : found.because;
}

/** The healthy recording with one sitting's snapshots put through `change`. */
function healthyBut(
  sitting: number,
  change: (snapshots: readonly StandSnapshot[]) => readonly StandSnapshot[]
): StandRecording {
  const recording = fixture('healthy-substituted');
  return {
    ...recording,
    sittings: recording.sittings.map((one) =>
      one.sitting === sitting ? { ...one, snapshots: change(one.snapshots) } : one
    ),
  };
}

/** The healthy recording with one sitting's summary put through `change`. */
function healthySummaryBut(
  sitting: number,
  change: (summary: StandSitting) => StandSitting
): StandRecording {
  const recording = fixture('healthy-substituted');
  return {
    ...recording,
    sittings: recording.sittings.map((one) =>
      one.sitting === sitting && one.summary !== null
        ? { ...one, summary: change(one.summary) }
        : one
    ),
  };
}

/** A column of the grid, spelled the way the recording spells one. */
function leaf(size: number): GridNode {
  return { size, groups: null };
}

/** A node of the grid that holds other nodes, laid out across the axis of its level. */
function family(size: number, ...groups: readonly GridNode[]): GridNode {
  return { size, groups };
}

function withGroups(
  snapshot: StandSnapshot,
  groups: readonly StandGroup[]
): StandSnapshot {
  return { ...snapshot, groups };
}

describe('the recording a stand writes', () => {
  test('a recording with no head line is refused, not read', () => {
    expect(() => parseRecording('{"kind":"snapshot","sitting":1}\n')).toThrow(/head/u);
  });

  test('a line that is not JSON names itself', () => {
    expect(() => parseRecording('{"kind":"stand","version":1}\nnot json\n')).toThrow(/line 2/u);
  });

  test('a sighting says whether the window held the keyboard while it was taken', () => {
    // The three points that read the editor's own layout rest on one sighting
    // each, and the editor answers about the part its ACTIVE group is in. A
    // window that has not got the keyboard is a window whose active group
    // belongs to whatever took it -- so a recording that never says which it
    // was cannot say what its numbers are about.
    const recording = parseRecording(
      `${JSON.stringify({ kind: 'stand', version: 1 })}\n` +
        `${JSON.stringify({ kind: 'snapshot', sitting: 1, ordinal: 1, what: 'settled', groups: [], focused: false })}\n`
    );
    expect(recording.sittings[0]?.snapshots[0]?.focused).toBe(false);
  });

  test('the seven measured sittings are read as seven', () => {
    expect(fixture('staircase-2026-08-23').sittings.map((one) => one.sitting)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
  });
});

describe('a healthy window', () => {
  test('every one of the nine points is green', () => {
    const verdict = judge(fixture('healthy-substituted'), BUDGET);
    expect(verdict.findings.map((one) => `${String(one.point)}:${one.answer}`)).toEqual([
      '0:green', '1:green', '2:green', '3:green', '4:green',
      '5:green', '6:green', '7:green', '8:green',
    ]);
    expect(verdict.red).toBe(false);
  });

  test('the strip under a NESTED column is read as a third of ITS family, not of the window', () => {
    // The healthy fixture is two columns with our strip under the right-hand
    // one: 114 of the 343 that column holds is a third, and 114 of the 743 the
    // window holds is not. A judge that read only the top level of the grid
    // would see 343/743 and call it 46 per cent. That is the defect the
    // prototype had, and the number below is what tells the two readings apart.
    expect(saidAbout(judge(fixture('healthy-substituted'), BUDGET), 3)).toMatch(/0\.33/u);
  });
});

describe('the staircase of 2026-08-23, measured', () => {
  const verdict = judge(fixture('staircase-2026-08-23'), BUDGET);

  test('point 1 is red, and says the staircase in numbers', () => {
    expect(answerTo(verdict, 1)).toBe('red');
    expect(saidAbout(verdict, 1)).toMatch(/2, 2, 4, 5, 6, 7, 8/u);
  });

  test('point 6 is red: every record came back as a new conversation', () => {
    expect(answerTo(verdict, 6)).toBe('red');
    expect(saidAbout(verdict, 6)).toMatch(/resume/u);
  });

  test('the whole recording is red', () => {
    expect(verdict.red).toBe(true);
  });

  test('what that recording never measured is `unmeasured`, and never green', () => {
    // The prototype recorded tab LABELS and never asked whether a tab was a
    // terminal, and it never read the workspace storage key. A judge that
    // answered those green would be answering about nothing.
    expect([0, 2, 3, 4, 5].map((point) => answerTo(verdict, point))).toEqual([
      'unmeasured', 'unmeasured', 'unmeasured', 'unmeasured', 'unmeasured',
    ]);
  });
});

describe('a recording the measurer really wrote', () => {
  /*
   * The one place the two halves of the stand are held against each other.
   * Everything else here is a recording written by hand or converted from an
   * older instrument; this one came out of `tests/stand/run.mjs` and the
   * observer beside it -- four sittings in Cursor across the midnight of
   * 2026-08-25, whose own `recordedAt` says 22:12Z -- and it is
   * here so that a change to what the measurer writes cannot pass while the
   * judge still reads yesterday's shape.
   *
   * What it deliberately does NOT assert is WHICH points were red that day.
   * Those are facts about one build, and pinning them here would turn fixing
   * any of them into a failing test.
   *
   * One field of it was rewritten by hand and it is said here rather than
   * hidden: `head.editor` held the full path to the .exe, which names whoever
   * owns the machine it ran on, and it was replaced by its own basename. The
   * runner writes exactly that today, for exactly that reason. Every other byte
   * is the run's own.
   */
  const recording = fixture('four-sittings-2026-08-26');

  test('parses, and every one of the nine points gets an answer with a reason', () => {
    const verdict = judge(recording, BUDGET);
    expect(verdict.findings.map((one) => one.point)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(verdict.findings.filter((one) => one.because.length === 0)).toEqual([]);
  });

  test('came out of a real editor, over four sittings on one folder', () => {
    expect(recording.head.editor).toMatch(/Cursor\.exe|Code\.exe/u);
    expect(recording.sittings.map((one) => one.sitting)).toEqual([1, 2, 3, 4]);
    expect(recording.sittings.filter((one) => one.summary === null)).toEqual([]);
  });

  test('every sighting of it says whether the window held the keyboard', () => {
    // The observer's half of the rule three points now rest on. It cannot be
    // held by anything but a recording a real window wrote: `vscode.window.state`
    // exists only inside an editor, so a test with no editor can check that the
    // judge READS the flag and never that the measurer WRITES it.
    const said = recording.sittings.flatMap((one) => one.snapshots.map((snapshot) => snapshot.focused));
    expect(said).not.toHaveLength(0);
    expect(said.filter((one) => one === null)).toEqual([]);
  });

  test('says which folder the editor kept the window`s memory under, and says it once', () => {
    // The defect this holds, found by running the stand and not by reading it:
    // `context.storageUri` ends in the EXTENSION's identity, so the first run
    // recorded `gripterm-stand.gripterm-stand-observer` as the key for the
    // folder -- the same string in every window ever opened -- and point 0 was
    // green about a constant.
    const keys = [
      ...new Set(recording.sittings.flatMap((one) => one.snapshots.map((snapshot) => snapshot.workspaceStorage))),
    ];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^[0-9a-f]{16,}$/u);
  });
});

describe('the nine points, one at a time', () => {
  test('0 -- a workspace storage key that changed is red', () => {
    const changed = healthyBut(3, (snapshots) =>
      snapshots.map((one) => ({ ...one, workspaceStorage: 'a-different-key' }))
    );
    expect(answerTo(judge(changed, BUDGET), 0)).toBe('red');
  });

  test('1 -- one more group than the sitting before is red', () => {
    const grown = healthyBut(3, (snapshots) =>
      snapshots.map((one) =>
        one.what === 'settled'
          ? withGroups(one, [...one.groups, { column: 4, active: false, tabs: [], terminals: 0 }])
          : one
      )
    );
    expect(answerTo(judge(grown, BUDGET), 1)).toBe('red');
  });

  test('1 -- fewer than three sittings cannot answer it, and that is red', () => {
    const recording = fixture('healthy-substituted');
    const two = { ...recording, sittings: recording.sittings.slice(0, 2) };
    const verdict = judge(two, BUDGET);
    expect(answerTo(verdict, 1)).toBe('red');
    expect(saidAbout(verdict, 1)).toMatch(/fewer than 3/u);
  });

  test('1 -- a sitting whose first sighting is not the observer own cannot answer it', () => {
    // Written in the REFACTOR phase, after the change it holds: point 1 used to
    // read `snapshots[0]` and now reads the sighting NAMED `activated`. The
    // difference is the whole of the earliest-sighting mechanism -- a recording
    // with no such line has no earliest sighting, whatever stands first in it.
    const nameless = healthyBut(2, (snapshots) =>
      snapshots.map((one) => (one.what === 'activated' ? { ...one, what: 'something else' } : one))
    );
    expect(answerTo(judge(nameless, BUDGET), 1)).toBe('unmeasured');
  });

  test('1 -- an observer that arrived after the product is red, not green', () => {
    // The point of the earliest snapshot: the activation order of two
    // extensions in one host is not guaranteed, so a clean first sighting means
    // nothing if the product had already tidied up before it was taken.
    const late = healthyBut(2, (snapshots) =>
      snapshots.map((one) => ({ ...one, productAlreadyActive: true }))
    );
    const verdict = judge(late, BUDGET);
    expect(answerTo(verdict, 1)).toBe('red');
    expect(saidAbout(verdict, 1)).toMatch(/in time/u);
  });

  test('2 -- two groups holding terminals of ours is red', () => {
    const twoStrips = healthyBut(3, (snapshots) =>
      snapshots.map((one) =>
        one.what === 'settled'
          ? withGroups(one, [
            { column: 1, active: false, tabs: ['project 3'], terminals: 1 },
            ...one.groups.slice(1),
          ])
          : one
      )
    );
    expect(answerTo(judge(twoStrips, BUDGET), 2)).toBe('red');
  });

  test('3 -- a strip over the budget is red', () => {
    const tall = healthyBut(3, (snapshots) =>
      snapshots.map((one) =>
        one.what === 'settled'
          ? {
            ...one,
            grid: { orientation: 0, groups: [leaf(400), family(343, leaf(70), leaf(273))] },
          }
          : one
      )
    );
    const verdict = judge(tall, BUDGET);
    expect(answerTo(verdict, 3)).toBe('red');
    expect(saidAbout(verdict, 3)).toMatch(/0\.79/u);
  });

  test('3 -- a strip with empty groups BELOW it is red however small it is', () => {
    // Exactly the shape sittings three onward of the staircase were in: the
    // strip sits second of seven rows, with five empty ones under it.
    const notAtTheEnd = healthyBut(3, (snapshots) =>
      snapshots.map((one) =>
        one.what === 'settled'
          ? {
            ...one,
            grid: { orientation: 1, groups: [leaf(300), leaf(243), leaf(200)] },
            groups: [
              { column: 1, active: false, tabs: ['design.md'], terminals: 0 },
              { column: 2, active: true, tabs: ['project', 'project 2'], terminals: 2 },
              { column: 3, active: false, tabs: [], terminals: 0 },
            ],
          }
          : one
      )
    );
    const verdict = judge(notAtTheEnd, BUDGET);
    expect(answerTo(verdict, 3)).toBe('red');
    expect(saidAbout(verdict, 3)).toMatch(/under|below/u);
  });

  test('4 -- a file that landed IN the strip is red', () => {
    const intoTheStrip = healthyBut(3, (snapshots) =>
      snapshots.map((one) =>
        one.what === 'a file opened'
          ? withGroups(one, [
            { column: 1, active: false, tabs: ['design.md'], terminals: 0 },
            { column: 2, active: false, tabs: ['notes.md'], terminals: 0 },
            { column: 3, active: true, tabs: ['project', 'project 2', 'README.md'], terminals: 2 },
          ])
          : one
      )
    );
    expect(answerTo(judge(intoTheStrip, BUDGET), 4)).toBe('red');
  });

  test('4 -- a strip whose share moved when a file opened is red', () => {
    const resized = healthyBut(3, (snapshots) =>
      snapshots.map((one) =>
        one.what === 'a file opened'
          ? {
            ...one,
            grid: { orientation: 0, groups: [leaf(400), family(343, leaf(143), leaf(200))] },
          }
          : one
      )
    );
    expect(answerTo(judge(resized, BUDGET), 4)).toBe('red');
  });

  test('5 -- a strip alone in the editor area is red', () => {
    const alone = healthyBut(3, (snapshots) =>
      snapshots.map((one) =>
        one.what === 'settled'
          ? {
            ...one,
            grid: { orientation: 1, groups: [leaf(743)] },
            groups: [{ column: 1, active: true, tabs: ['project', 'project 2'], terminals: 2 }],
          }
          : one
      )
    );
    expect(answerTo(judge(alone, BUDGET), 5)).toBe('red');
  });

  test('6 -- a record that did not come back at all is red', () => {
    const missing = healthySummaryBut(3, (summary) => ({
      ...summary,
      records: summary.records.slice(0, 1),
    }));
    const verdict = judge(missing, BUDGET);
    expect(answerTo(verdict, 6)).toBe('red');
    expect(saidAbout(verdict, 6)).toMatch(/came back/u);
  });

  test('6 -- every record starting a NEW conversation is red', () => {
    const allLaunched = healthySummaryBut(3, (summary) => ({
      ...summary,
      records: summary.records.map((one) => ({
        ...one,
        starts: one.starts.map((start) => ({ ...start, intent: start.intent === null ? null : 'launch' })),
      })),
    }));
    expect(answerTo(judge(allLaunched, BUDGET), 6)).toBe('red');
  });

  test('7 -- the tabs of the strip in another order is red', () => {
    const swapped = healthyBut(3, (snapshots) =>
      snapshots.map((one) =>
        one.what === 'settled'
          ? withGroups(one, [
            ...one.groups.slice(0, 2),
            { column: 3, active: true, tabs: ['project 2', 'project'], terminals: 2 },
          ])
          : one
      )
    );
    expect(answerTo(judge(swapped, BUDGET), 7)).toBe('red');
  });

  test('7 -- a record whose place in the order moved is red', () => {
    const moved = healthySummaryBut(3, (summary) => ({
      ...summary,
      records: summary.records.map((one, at) => (at === 0 ? { ...one, placement: 9 } : one)),
    }));
    expect(answerTo(judge(moved, BUDGET), 7)).toBe('red');
  });

  test('8 -- a sitting that took longer than the budget is red', () => {
    const slow = healthySummaryBut(3, (summary) => ({
      ...summary,
      restoredMs: BUDGET.restoredMs + 1,
    }));
    const verdict = judge(slow, BUDGET);
    expect(answerTo(verdict, 8)).toBe('red');
    expect(saidAbout(verdict, 8)).toMatch(new RegExp(String(BUDGET.restoredMs), 'u'));
  });

  test('8 -- the first sitting is not held to the budget, because nothing came back in it', () => {
    const slowFirst = healthySummaryBut(1, (summary) => ({
      ...summary,
      restoredMs: BUDGET.restoredMs * 10,
    }));
    expect(answerTo(judge(slowFirst, BUDGET), 8)).toBe('green');
  });
});

describe('what a verdict refuses to be read from', () => {
  test('a sitting with no settled sighting cannot be judged, and is not green', () => {
    const never = healthyBut(3, (snapshots) => snapshots.filter((one) => one.what !== 'settled'));
    const verdict = judge(never, BUDGET);
    expect(answerTo(verdict, 1)).toBe('red');
    expect(saidAbout(verdict, 1)).toMatch(/settle/u);
  });

  test('a grid the editor refused to answer is not read as an empty one', () => {
    // `vscode.getEditorLayout` answers `Canceled: Canceled` while a window is
    // going down, every time it was measured. A judge that took that for a grid
    // would call the last sighting of every sitting a window with no groups.
    const refused = healthyBut(3, (snapshots) =>
      snapshots.map((one) =>
        one.what === 'settled'
          ? { ...one, grid: null, gridRefused: 'Canceled: Canceled' }
          : one
      )
    );
    const verdict = judge(refused, BUDGET);
    expect(answerTo(verdict, 3)).toBe('red');
    expect(saidAbout(verdict, 3)).toMatch(/Canceled/u);
  });

  /*
   * THE WINDOW WITHOUT THE KEYBOARD, and the three points that rest on a
   * reading of a layout.
   *
   * `vscode.getEditorLayout` answers for the part of the editor its ACTIVE
   * group is in -- measured 2026-08-25, twelve settled sightings of twelve, on
   * a window carrying Cursor's own agent editor. A window that has not got the
   * keyboard is a window whose active group belongs to whatever took it, so
   * what the editor answered there is not a reading of the window a person is
   * looking at.
   *
   * The three tests below put the flag on a recording that would otherwise be
   * RED at that point, not on a green one. That is the half that matters: a
   * refusal only worth having is one that outranks a red, because a red is what
   * a reading taken in the wrong window looks like from outside.
   *
   * What is deliberately NOT claimed here is that losing the keyboard CAUSES
   * the answer to move: 2026-08-21 measured a live suite failing while its
   * window held the keyboard throughout, so the two are not the same fact. The
   * claim is only that a point which cannot vouch for its own reading says so.
   */
  function withoutTheKeyboard(
    change: (snapshots: readonly StandSnapshot[]) => readonly StandSnapshot[]
  ): StandRecording {
    return healthyBut(3, (snapshots) =>
      change(snapshots).map((one) =>
        one.what === 'settled' || one.what === FILE_OPENED ? { ...one, focused: false } : one
      )
    );
  }

  test('1 -- groups counted while the window did not hold the keyboard are unmeasured', () => {
    const grown = withoutTheKeyboard((snapshots) =>
      snapshots.map((one) =>
        one.what === 'settled'
          ? withGroups(one, [...one.groups, { column: 4, active: false, tabs: [], terminals: 0 }])
          : one
      )
    );
    const verdict = judge(grown, BUDGET);
    expect(answerTo(verdict, 1)).toBe('unmeasured');
    expect(saidAbout(verdict, 1)).toMatch(/keyboard/u);
  });

  test('3 -- a grid read while the window did not hold the keyboard is unmeasured, not red', () => {
    const tall = withoutTheKeyboard((snapshots) =>
      snapshots.map((one) =>
        one.what === 'settled'
          ? { ...one, grid: { orientation: 0, groups: [leaf(400), family(343, leaf(70), leaf(273))] } }
          : one
      )
    );
    const verdict = judge(tall, BUDGET);
    expect(answerTo(verdict, 3)).toBe('unmeasured');
    expect(saidAbout(verdict, 3)).toMatch(/keyboard/u);
  });

  test('4 -- a file opened while the window did not hold the keyboard is unmeasured, not red', () => {
    const intoTheStrip = withoutTheKeyboard((snapshots) =>
      snapshots.map((one) =>
        one.what === FILE_OPENED
          ? withGroups(one, [
            { column: 1, active: false, tabs: ['design.md'], terminals: 0 },
            { column: 2, active: false, tabs: ['notes.md'], terminals: 0 },
            { column: 3, active: true, tabs: ['project', 'project 2', 'README.md'], terminals: 2 },
          ])
          : one
      )
    );
    const verdict = judge(intoTheStrip, BUDGET);
    expect(answerTo(verdict, 4)).toBe('unmeasured');
    expect(saidAbout(verdict, 4)).toMatch(/keyboard/u);
  });

  test('a recording that never asked about the keyboard is judged exactly as it was', () => {
    // Every recording taken before 2026-08-26, the two the acceptance of the
    // stand rests on included. `null` is "this recording does not say", and a
    // rule that read it as "the window had lost it" would turn three points of
    // every one of them unmeasured -- which is not a stricter stand, it is one
    // that has stopped answering.
    const verdict = judge(fixture('four-sittings-2026-08-25'), BUDGET);
    expect([1, 3, 4].map((point) => answerTo(verdict, point))).toEqual(['green', 'red', 'red']);
  });
});

/**
 * The number a budget can be held to.
 *
 * `because` carries the numbers for a reader; nothing can compare two of them.
 * `violations` is the same fact as an integer -- how many named things went
 * wrong at that point -- and it exists so that `gate/allowed-red.json` can admit
 * a point UP TO A NUMBER rather than admit it outright. Its contract is small
 * and is stated here rather than inferred: green is nought, red is one or more,
 * unmeasured is nothing at all, and two different points' numbers are not
 * comparable with each other.
 */
describe('the number beside each answer', () => {
  test('is nought wherever the answer is green', () => {
    const verdict = judge(fixture('healthy-substituted'), BUDGET);
    expect(verdict.findings.map((one) => one.answer)).not.toContain('red');
    expect(verdict.findings.map((one) => one.violations)).toStrictEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  test('is nothing at all where the recording could not say', () => {
    const verdict = judge(fixture('staircase-2026-08-23'), BUDGET);
    const unmeasured = verdict.findings.filter((one) => one.answer === 'unmeasured');
    expect(unmeasured.length).toBeGreaterThan(0);
    expect(unmeasured.map((one) => one.violations)).toStrictEqual(unmeasured.map(() => null));
  });

  test('counts the sittings a red point failed in, rather than repeating that it failed', () => {
    // Six of the seven sittings of the staircase came back with no resume in
    // them; the first is the one nothing came back in. A number that said `1`
    // here would let a budget written for one broken sitting admit six.
    const verdict = judge(fixture('staircase-2026-08-23'), BUDGET);
    expect(answerTo(verdict, 6)).toBe('red');
    expect(verdict.findings.find((one) => one.point === 6)?.violations).toBe(6);
  });

  test('is one where a red answer names a single thing rather than a list', () => {
    const tooShort: StandRecording = {
      ...fixture('healthy-substituted'),
      sittings: fixture('healthy-substituted').sittings.slice(0, 1),
    };
    const verdict = judge(tooShort, BUDGET);
    expect(answerTo(verdict, 1)).toBe('red');
    expect(verdict.findings.find((one) => one.point === 1)?.violations).toBe(1);
  });
});
