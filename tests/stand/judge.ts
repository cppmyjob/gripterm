import { ACTIVATED, FILE_OPENED, SETTLED } from './recording';
import type { Grid, GridNode, StandGroup, StandRecording, StandSnapshot, SittingRecording } from './recording';

/**
 * The judge of the two-sitting stand: a function from what was seen to a
 * verdict, and nothing else.
 *
 * It starts nothing, opens nothing and waits for nothing, which is the point of
 * cutting the stand here. The half that needs a machine with an editor on it
 * writes a recording; this half reads one. So the acceptance of ??5 -- red on
 * the measured staircase AND green on a healthy window -- is settled by
 * `judge.test.ts` in under a second, and the measurer is left answering for one
 * thing only: that the sightings are real.
 *
 * **Three answers, not two.** `unmeasured` is not a pass. A stand that reports
 * green for a question its recording never asked is worse than one that does
 * not run, so `red` below is `any answer that is not green`: the runner exits
 * non-zero on an unmeasured point exactly as it does on a failed one. What
 * `unmeasured` buys is a reader who can tell "this build is wrong" from "this
 * recording cannot say".
 *
 * **The keyboard is one of the things it can fail to measure.** Points 1, 3 and
 * 4 rest on a reading of the editor's own layout, and the editor answers that
 * for the part its ACTIVE group is in. A window that has not got the keyboard is
 * a window whose active group belongs to whatever took it -- so those three
 * answer `unmeasured` there rather than red. The run still fails; what changes
 * is that it stops saying "this build laid the window out wrong" about a window
 * nobody can prove it was looking at.
 */

export type Answer = 'green' | 'red' | 'unmeasured';

export interface Finding {
  /** Its number in the table of ??5, nought through eight. */
  readonly point: number;
  /** What the point asserts, in the words the plan asserts it in. */
  readonly says: string;
  readonly answer: Answer;
  /** Why that answer, with the numbers that produced it. */
  readonly because: string;
  /**
   * How many named things went wrong at this point: nought when green, one or
   * more when red, and nothing at all when the recording could not say.
   *
   * It exists so that a budget can admit a point AT A NUMBER rather than admit
   * it outright (`gate/allowed-red.json`). `because` carries the magnitudes a
   * person needs -- 0.906 of a family, 5 831 ms -- and nothing can compare two
   * of those; this is the same fact as an integer that a machine can.
   *
   * **What it does not promise.** It is not a magnitude and it is not a score:
   * two different points' numbers mean different things and do not compare with
   * each other. It moves when a defect spreads to another sitting or leaves
   * one, and it does NOT move when the same sitting gets worse -- a strip at
   * 0.906 and a strip at 0.400 are both `1` here.
   */
  readonly violations: number | null;
}

export interface Verdict {
  readonly findings: readonly Finding[];
  /** True when anything at all is not green -- including a point nothing measured. */
  readonly red: boolean;
}

export interface Budget {
  /** The most of the space it shares our strip may hold. */
  readonly share: number;
  /** How long a sitting after the first may take to bring everything back. */
  readonly restoredMs: number;
  /** The fewest sittings that can answer whether groups accumulate. */
  readonly sittings: number;
}

/**
 * The numbers the stand is held to, each with the measurement behind it.
 *
 * `share` is the third the strip asks for when it is made
 * (`vscode-editor-strip.ts`, `A_THIRD`) with a shade over it, because the editor
 * rounds to whole pixels and a family of three splits 743 into 247.5.
 *
 * `restoredMs` is set from the seven sittings of 2026-08-23, in which everything
 * was back between 3 232 ms and 5 831 ms of the observer's activation. Twenty
 * seconds is three times the slowest of them: far enough that the machine being
 * busy cannot turn it red, close enough that "it never came back" cannot pass.
 *
 * `sittings` is three because the defect this stand exists for does not show in
 * two. Measured: the groups went 2, 2, 4, 5, 6, 7, 8, so a stand that sat down
 * twice would have been green.
 */
export const BUDGET: Budget = {
  share: 0.34,
  restoredMs: 20_000,
  sittings: 3,
};

/** How far the strip's share may drift while a file is opened above it. */
const SHARE_DRIFT = 0.01;

/** `0` lays a family out in columns, `1` in rows. Nested levels alternate. */
const COLUMNS = 0;
const ROWS = 1;

export function judge(recording: StandRecording, budget: Budget): Verdict {
  const findings = [
    theSameFolder(recording),
    groupsDoNotAccumulate(recording, budget),
    oneStripOfOurs(recording),
    theStripIsAThirdAndUnderTheEditors(recording, budget),
    theFileSatAbove(recording, budget),
    theStripIsNeverAlone(recording),
    everythingCameBackAndOneResumed(recording),
    theSameOrder(recording),
    withinTheBudget(recording, budget),
  ];
  return { findings, red: findings.some((one) => one.answer !== 'green') };
}

// --- 0 ----------------------------------------------------------------------

/**
 * The same folder throughout.
 *
 * The stand's own emptiness test. The editor keys what it remembers about a
 * window -- the grid included -- by a workspace storage id, and a project folder
 * made afresh between sittings gets a new one. A stand that did that would open
 * a virgin window every time, find one clean group in it, and report that
 * nothing accumulates.
 */
function theSameFolder(recording: StandRecording): Finding {
  const seen = recording.sittings.map((one) => ({
    sitting: one.sitting,
    keys: [...new Set(one.snapshots.map((snapshot) => snapshot.workspaceStorage).filter(isText))],
  }));
  const silent = seen.filter((one) => one.keys.length === 0);
  if (silent.length > 0) {
    return finding(0, 'the workspace storage key is the one sitting 1 had', 'unmeasured',
      `no sighting of sitting${silent.length === 1 ? '' : 's'} ${silent.map((one) => String(one.sitting)).join(', ')} read the editor's key for this folder`);
  }
  const all = [...new Set(seen.flatMap((one) => one.keys))];
  if (all.length !== 1) {
    const wanted = seen[0]?.keys ?? [];
    const elsewhere = seen.filter((one) => JSON.stringify(one.keys) !== JSON.stringify(wanted));
    return finding(0, 'the workspace storage key is the one sitting 1 had', 'red',
      `the sittings did not sit on one folder: ${seen.map((one) => `${String(one.sitting)} -> ${one.keys.join('/')}`).join(', ')}`,
      elsewhere.length);
  }
  return finding(0, 'the workspace storage key is the one sitting 1 had', 'green',
    `every sitting opened the folder the editor knows as ${all.join('')}`);
}

// --- 1 ----------------------------------------------------------------------

/**
 * The groups do not accumulate.
 *
 * The defect the stand was built for, and the one that cannot be seen in a
 * single sitting: measured on 2026-08-23, seven sittings over one folder went
 * 2, 2, 4, 5, 6, 7, 8 groups, and the second of them was clean.
 *
 * Four refusals stand in front of the comparison, and each of them is a way the
 * comparison would otherwise be about nothing: too few sittings to see a slope,
 * a sitting the measurer never called settled, an observer that arrived after
 * the product had already tidied the window -- the one the plan names -- and a
 * window that had not got the keyboard when it was counted.
 */
function groupsDoNotAccumulate(recording: StandRecording, budget: Budget): Finding {
  const says = 'the groups after sitting N are no more than after N-1';
  if (recording.sittings.length < budget.sittings) {
    return finding(1, says, 'red',
      `this recording holds ${String(recording.sittings.length)} sitting(s), and the accumulation does not show in fewer than ${String(budget.sittings)} -- sitting 2 of the measured staircase was clean`,
      1);
  }

  const late = recording.sittings.filter((one) => earliestOf(one)?.productAlreadyActive === true);
  if (late.length > 0) {
    return finding(1, says, 'red',
      `the observer did not get there in time in sitting${late.length === 1 ? '' : 's'} ${late.map((one) => String(one.sitting)).join(', ')}: the product had already activated when its first line ran, so the earliest sighting is of a window somebody had already tidied`,
      late.length);
  }
  const blind = recording.sittings.filter((one) => earliestOf(one)?.productAlreadyActive == null);
  if (blind.length > 0) {
    return finding(1, says, 'unmeasured',
      `sitting${blind.length === 1 ? '' : 's'} ${blind.map((one) => String(one.sitting)).join(', ')} never said whether the product had already activated when the observer's first line ran`);
  }

  const counts = recording.sittings.map((one) => ({ sitting: one.sitting, settled: settledOf(one) }));
  const unsettled = counts.filter((one) => one.settled === null);
  if (unsettled.length > 0) {
    return finding(1, says, 'red',
      `sitting${unsettled.length === 1 ? '' : 's'} ${unsettled.map((one) => String(one.sitting)).join(', ')} never settled -- no sighting of ${JSON.stringify(SETTLED)} was written, so there is no moment to count the groups at`,
      unsettled.length);
  }

  const elsewhere = counts.filter((one) => one.settled?.focused === false);
  if (elsewhere.length > 0) {
    return finding(1, says, 'unmeasured',
      theKeyboardWasElsewhere(elsewhere.map((one) => one.sitting), 'settled'));
  }

  const groups = counts.map((one) => one.settled?.groups.length ?? 0);
  const leaves = counts.map((one) => {
    const grid = one.settled?.grid;
    return grid === null || grid === undefined ? null : leavesIn(grid.groups);
  });
  const staircase = groups.map((one) => String(one)).join(', ');
  const aside = leaves.some((one, at) => one !== null && one !== groups[at])
    ? `; the grid accounted for ${leaves.map((one) => (one === null ? '?' : String(one))).join(', ')} of them, which is the editor holding a tab group outside its own grid`
    : '';

  const grew = groups.flatMap((count, at) => {
    const before = groups[at - 1];
    return at > 0 && before !== undefined && count > before
      ? [`${String(counts[at]?.sitting ?? at + 1)} (${String(before)} -> ${String(count)})`]
      : [];
  });
  return grew.length === 0
    ? finding(1, says, 'green', `the groups went ${staircase} and never grew${aside}`)
    : finding(1, says, 'red', `the groups went ${staircase}, and grew at sitting ${grew.join(', ')}${aside}`, grew.length);
}

// --- 2 ----------------------------------------------------------------------

/** Our strip is one group, not two. */
function oneStripOfOurs(recording: StandRecording): Finding {
  const says = 'exactly one group holds terminals of ours';
  const seen = settledStrips(recording);
  if (seen === null) {
    return finding(2, says, 'unmeasured', 'no sighting recorded whether a tab was a terminal, so which group is ours cannot be read off this recording');
  }
  const wrong = seen.filter((one) => one.strip.kind !== 'one');
  if (wrong.length > 0) {
    return finding(2, says, 'red',
      wrong.map((one) => one.strip.kind === 'many'
        ? `sitting ${String(one.sitting)} settled with terminals in columns ${one.strip.columns.map((column) => String(column)).join(' and ')}`
        : `sitting ${String(one.sitting)} settled with no terminal of ours anywhere`).join('; '),
      wrong.length);
  }
  return finding(2, says, 'green',
    `every sitting settled with one strip: ${seen.map((one) => `${String(one.sitting)} -> column ${String(one.strip.kind === 'one' ? one.strip.group.column : 0)}`).join(', ')}`);
}

// --- 3 ----------------------------------------------------------------------

/**
 * The strip is a third of what it shares, and it is UNDER the editors.
 *
 * Both halves, and in this order, because the customer paid for the second one
 * on 2026-08-22: their window was two COLUMNS, the strip was adopted as the
 * right-hand one, and a terminal a third of the width, full height, beside their
 * files is not a strip however small its number is.
 *
 * The share is of the family the strip is IN, not of the window. A grid is a
 * tree; a reader that takes the root's list for the columns answers 343 of 743
 * where the truth is 114 of 343, and calls a healthy window a defect -- or, with
 * the sizes the other way round, a defect healthy.
 */
function theStripIsAThirdAndUnderTheEditors(recording: StandRecording, budget: Budget): Finding {
  const says = `the strip holds no more than ${String(budget.share)} of its family, and sits under the editors`;
  const seen = settledStrips(recording);
  if (seen === null) {
    return finding(3, says, 'unmeasured', 'no sighting recorded whether a tab was a terminal, so the strip cannot be found in the grid');
  }

  const elsewhere = seen.filter((one) => one.snapshot.focused === false);
  if (elsewhere.length > 0) {
    return finding(3, says, 'unmeasured',
      theKeyboardWasElsewhere(elsewhere.map((one) => one.sitting), 'settled'));
  }

  const reasons: string[] = [];
  const shares: string[] = [];
  for (const { sitting, snapshot, strip } of seen) {
    if (strip.kind !== 'one') {
      reasons.push(`sitting ${String(sitting)} has no single strip to measure`);
      continue;
    }
    if (snapshot.grid === null) {
      reasons.push(`sitting ${String(sitting)} settled with no grid: the editor answered ${JSON.stringify(snapshot.gridRefused ?? 'nothing')}`);
      continue;
    }
    const index = strip.group.column - 1;
    if (index >= leavesIn(snapshot.grid.groups)) {
      reasons.push(`sitting ${String(sitting)} put the strip in column ${String(strip.group.column)}, and the grid has only ${String(leavesIn(snapshot.grid.groups))} columns in it`);
      continue;
    }
    const end = rowAtTheEnd(snapshot.grid);
    if (end !== index) {
      reasons.push(`sitting ${String(sitting)} left the strip in column ${String(strip.group.column)} of ${String(leavesIn(snapshot.grid.groups))}, and the row at the end of the area is ${end === null ? 'nowhere -- the area is not laid out in rows at all' : `column ${String(end + 1)}`}: it is not under the editors`);
      continue;
    }
    const share = shareOfLeaf(snapshot.grid, index);
    if (share === null) {
      reasons.push(`sitting ${String(sitting)} settled on a grid the editor had not sized, so the strip's share of it is unknown`);
      continue;
    }
    shares.push(`${String(sitting)} -> ${share.toFixed(3)}`);
    if (share > budget.share) {
      reasons.push(`sitting ${String(sitting)} left the strip holding ${share.toFixed(3)} of its family, over the ${String(budget.share)} it asks for`);
    }
  }

  return reasons.length === 0
    ? finding(3, says, 'green', `the strip was under the editors every time, at ${shares.join(', ')} of what it shares`)
    : finding(3, says, 'red', reasons.join('; '), reasons.length);
}

// --- 4 ----------------------------------------------------------------------

/**
 * A file opened while the strip is the active group sits ABOVE it, and the strip
 * keeps its height.
 *
 * The complaint behind it: a document opened while the strip had the focus
 * landed IN the strip, beside the terminals, because a group that is not locked
 * takes the next editor.
 */
function theFileSatAbove(recording: StandRecording, budget: Budget): Finding {
  const says = 'a file opened over the strip sits above it, and the strip keeps its share';
  const opened = recording.sittings.flatMap((one) => {
    const after = one.snapshots.find((snapshot) => snapshot.what === FILE_OPENED);
    const before = settledOf(one);
    return after === undefined || before === null ? [] : [{ sitting: one.sitting, before, after }];
  });
  if (opened.length === 0) {
    return finding(4, says, 'unmeasured', `no sitting of this recording opened a file: no sighting of ${JSON.stringify(FILE_OPENED)} stands beside a settled one`);
  }

  const elsewhere = opened.filter((one) => one.before.focused === false || one.after.focused === false);
  if (elsewhere.length > 0) {
    return finding(4, says, 'unmeasured',
      theKeyboardWasElsewhere(elsewhere.map((one) => one.sitting), 'opened a file'));
  }

  const reasons: string[] = [];
  for (const { sitting, before, after } of opened) {
    const was = stripOf(before);
    const now = stripOf(after);
    if (was.kind !== 'one' || now.kind !== 'one') {
      reasons.push(`sitting ${String(sitting)} has no single strip on both sides of the file being opened`);
      continue;
    }
    if (JSON.stringify(now.group.tabs) !== JSON.stringify(was.group.tabs)) {
      reasons.push(`sitting ${String(sitting)} put the file INTO the strip: it held ${JSON.stringify(was.group.tabs)} and now holds ${JSON.stringify(now.group.tabs)}`);
      continue;
    }
    const gained = after.groups.filter((group) => {
      const twin = before.groups.find((one) => one.column === group.column);
      return twin === undefined || group.tabs.length > twin.tabs.length;
    });
    const below = gained.filter((group) => group.column >= now.group.column);
    if (below.length > 0) {
      reasons.push(`sitting ${String(sitting)} put the file in column ${below.map((one) => String(one.column)).join(', ')}, at or after the strip in column ${String(now.group.column)}`);
      continue;
    }
    if (before.grid === null || after.grid === null) {
      reasons.push(`sitting ${String(sitting)} opened a file with no grid on one side of it`);
      continue;
    }
    const first = shareOfLeaf(before.grid, was.group.column - 1);
    const second = shareOfLeaf(after.grid, now.group.column - 1);
    if (first === null || second === null) {
      reasons.push(`sitting ${String(sitting)} opened a file over a grid the editor had not sized`);
      continue;
    }
    if (Math.abs(first - second) > SHARE_DRIFT) {
      reasons.push(`sitting ${String(sitting)} moved the strip from ${first.toFixed(3)} of its family to ${second.toFixed(3)} when the file opened`);
    }
  }
  void budget;

  return reasons.length === 0
    ? finding(4, says, 'green', `the file went above the strip and left its height alone in sitting ${opened.map((one) => String(one.sitting)).join(', ')}`)
    : finding(4, says, 'red', reasons.join('; '), reasons.length);
}

// --- 5 ----------------------------------------------------------------------

/**
 * The strip is never the only group in the editor area.
 *
 * A locked group alone in the area is a window a person cannot open a file in:
 * every editor they ask for has nowhere to go.
 */
function theStripIsNeverAlone(recording: StandRecording): Finding {
  const says = 'the strip is never the only group in the editor area';
  const all = recording.sittings.flatMap((one) =>
    one.snapshots.map((snapshot) => ({ sitting: one.sitting, snapshot, strip: stripOf(snapshot) }))
  );
  if (all.every((one) => one.strip.kind === 'unmeasured')) {
    return finding(5, says, 'unmeasured', 'no sighting recorded whether a tab was a terminal, so a window holding nothing but our strip cannot be told from one holding nothing but a file');
  }
  const alone = all.filter((one) => one.strip.kind === 'one' && one.snapshot.groups.length < 2);
  if (alone.length > 0) {
    return finding(5, says, 'red',
      `the strip stood alone in ${String(alone.length)} sighting(s): ${alone.slice(0, 3).map((one) => `sitting ${String(one.sitting)}, ${JSON.stringify(one.snapshot.what)}`).join('; ')}`,
      alone.length);
  }
  const withStrip = all.filter((one) => one.strip.kind === 'one').length;
  return finding(5, says, 'green', `the strip shared the area in every one of the ${String(withStrip)} sightings that had one`);
}

// --- 6 ----------------------------------------------------------------------

/**
 * Every record came back, and at least one of them through `--resume`.
 *
 * Read out of the store rather than off the screen, because a tab with the right
 * name on it proves a terminal was opened and not that the conversation in it is
 * the one that was there yesterday. `starts.jsonl` carries the intent this build
 * chose for each start, and `launch` where `resume` was expected is exactly the
 * complaint: the terminals came back and the conversations did not.
 *
 * **WHAT THIS POINT CANNOT ASK OF THE STAND AS IT IS BUILT TODAY (2026-08-26),
 * and the reason its red does not mean what it says.** `planRestore` answers
 * `resume` only for a record whose conversation has a transcript; a transcript
 * exists only once something has been SAID in that conversation
 * (`transcript-index.ts`, and `restore-planner.ts` calls the other case
 * `no-transcript`); the stand types into none of the terminals it makes. So
 * every start it can produce is a `launch`, and a launch MINTS A NEW
 * conversation id into the record, which the next sitting finds just as silent.
 * The loop has no way out: 64 starts over the eight runs whose traces were read
 * on 2026-08-25 and 2026-08-26, 64 launches, not one resume -- and the same 3
 * violations in every one of the seven runs measured before them. A red here therefore says "this stand cannot pose the
 * question", not "the conversations did not come back" -- and the two are the
 * difference this file's third answer exists for.
 *
 * It is NOT answered `unmeasured` all the same, and that is deliberate rather
 * than an oversight. Half of that change is a line in `gate/allowed-red.json`
 * admitting point 6 red at 3, which would then admit nothing -- and what a
 * budget admits is the owner's to say. The other exit is the measurer learning
 * to lay a transcript so that `resume` becomes reachable at all, which is a step
 * of its own. Both were put to the owner on 2026-08-26 with what each costs.
 */
function everythingCameBackAndOneResumed(recording: StandRecording): Finding {
  const says = 'every record came back, at least one of them through `resume`';
  const first = recording.sittings[0];
  if (first?.summary?.records.length === undefined || first.summary.records.length === 0) {
    return finding(6, says, 'unmeasured', 'sitting 1 wrote down no records, so there is nothing later sittings could be missing');
  }
  const wanted = first.summary.records.map((one) => one.id).sort((left, right) => left.localeCompare(right));

  const reasons: string[] = [];
  let resumed = 0;
  let launched = 0;
  for (const sitting of recording.sittings.slice(1)) {
    if (sitting.summary === null) {
      reasons.push(`sitting ${String(sitting.sitting)} wrote down no records at all`);
      continue;
    }
    const starts = sitting.summary.records.filter((one) => one.starts.some((start) => start.what === 'start'));
    const back = starts.map((one) => one.id).sort((left, right) => left.localeCompare(right));
    const missing = wanted.filter((id) => !back.includes(id));
    if (missing.length > 0) {
      reasons.push(`sitting ${String(sitting.sitting)}: ${String(missing.length)} of ${String(wanted.length)} records never came back (${missing.map((id) => id.slice(0, 8)).join(', ')})`);
      continue;
    }
    const intents = starts.flatMap((one) => one.starts.filter((start) => start.what === 'start').map((start) => start.intent));
    resumed += intents.filter((intent) => intent === 'resume').length;
    launched += intents.filter((intent) => intent === 'launch').length;
    if (!intents.includes('resume')) {
      reasons.push(`sitting ${String(sitting.sitting)}: all ${String(intents.length)} starts were ${JSON.stringify([...new Set(intents)])}, none of them a resume -- every conversation was begun again from nothing`);
    }
  }

  return reasons.length === 0
    ? finding(6, says, 'green', `every one of the ${String(wanted.length)} records came back in every later sitting, ${String(resumed)} start(s) through resume and ${String(launched)} through launch`)
    : finding(6, says, 'red', reasons.join('; '), reasons.length);
}

// --- 7 ----------------------------------------------------------------------

/**
 * The tabs, and the rows of the list, in the order they were in.
 *
 * The tabs are read off the strip, which is what a person sees. The ROWS are
 * not: no editor API shows the contents of a webview, and the list is one. What
 * is checked instead is the material the rows are ordered BY -- the placement
 * and the moment of creation of every record, which is what `terminal-order.ts`
 * sorts on. If those did not move, no deterministic ordering of them moved
 * either; and if they did, the list a person reads moved with them.
 */
function theSameOrder(recording: StandRecording): Finding {
  const says = 'the tabs, and what the rows of the list are ordered by, are as they were';
  const reasons: string[] = [];
  const unknown: string[] = [];

  const seen = settledStrips(recording);
  if (seen === null) {
    unknown.push('no sighting recorded whether a tab was a terminal, so the strip`s tabs cannot be found');
  } else {
    const firstStrip = seen[0];
    const wanted = firstStrip?.strip.kind === 'one' ? firstStrip.strip.group.tabs : null;
    if (wanted === null) {
      unknown.push('sitting 1 settled with no strip, so there is no order for the others to keep');
    } else {
      for (const one of seen.slice(1)) {
        const tabs = one.strip.kind === 'one' ? one.strip.group.tabs : null;
        if (tabs === null || JSON.stringify(tabs) !== JSON.stringify(wanted)) {
          reasons.push(`sitting ${String(one.sitting)} shows ${JSON.stringify(tabs)} where sitting 1 showed ${JSON.stringify(wanted)}`);
        }
      }
    }
  }

  const first = recording.sittings[0]?.summary;
  if (first === undefined || first === null || first.records.length === 0) {
    unknown.push('sitting 1 wrote down no records, so nothing says what the rows were ordered by');
  } else {
    const keys = (sitting: SittingRecording): string =>
      JSON.stringify(
        [...(sitting.summary?.records ?? [])]
          .map((one) => [one.id, one.placement, one.createdAt])
          .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
      );
    const wanted = keys(recording.sittings[0] as SittingRecording);
    for (const sitting of recording.sittings.slice(1)) {
      if (keys(sitting) !== wanted) {
        reasons.push(`sitting ${String(sitting.sitting)} orders the rows by ${keys(sitting)} where sitting 1 ordered them by ${wanted}`);
      }
    }
  }

  if (reasons.length > 0) {
    return finding(7, says, 'red', reasons.join('; '), reasons.length);
  }
  return unknown.length > 0
    ? finding(7, says, 'unmeasured', unknown.join('; '))
    : finding(7, says, 'green', 'the tabs of the strip and the keys the rows are ordered by are the ones sitting 1 left');
}

// --- 8 ----------------------------------------------------------------------

/**
 * Everything was back inside the budget.
 *
 * Sitting 1 is not held to it and cannot be: nothing came BACK in it -- the
 * terminals were made there, at whatever pace the driver made them.
 */
function withinTheBudget(recording: StandRecording, budget: Budget): Finding {
  const says = `every sitting after the first had everything back within ${String(budget.restoredMs)} ms`;
  const later = recording.sittings.slice(1);
  if (later.length === 0) {
    return finding(8, says, 'unmeasured', 'this recording has no sitting after the first, so nothing came back in it to be timed');
  }
  const silent = later.filter((one) => one.summary?.restoredMs == null);
  if (silent.length > 0) {
    return finding(8, says, 'unmeasured',
      `sitting${silent.length === 1 ? '' : 's'} ${silent.map((one) => String(one.sitting)).join(', ')} never said how long it took`);
  }
  const times = later.map((one) => ({ sitting: one.sitting, ms: one.summary?.restoredMs ?? 0 }));
  const over = times.filter((one) => one.ms > budget.restoredMs);
  const all = times.map((one) => `${String(one.sitting)} -> ${String(one.ms)} ms`).join(', ');
  return over.length === 0
    ? finding(8, says, 'green', `everything was back in ${all}, inside the ${String(budget.restoredMs)} ms budget`)
    : finding(8, says, 'red', `over the ${String(budget.restoredMs)} ms budget: ${over.map((one) => `sitting ${String(one.sitting)} took ${String(one.ms)} ms`).join(', ')} (all of them: ${all})`, over.length);
}

// --- reading a sitting ------------------------------------------------------

/**
 * Why a point that rests on a layout refuses to answer about a window that had
 * not got the keyboard.
 *
 * `vscode.getEditorLayout` answers for the part of the editor its ACTIVE group
 * is in -- measured 2026-08-25 on a window carrying Cursor's own agent editor,
 * twelve settled sightings of twelve -- and a window without the keyboard is a
 * window whose active group belongs to whatever took it.
 *
 * What this does NOT say is that losing the keyboard MOVES the answer. On
 * 2026-08-21 a live suite failed twice with `window.state.focused` true through
 * the whole of both runs, so the two are not one fact. The claim is the narrow
 * one: a point that cannot vouch for the reading it rests on says so, instead
 * of calling it a defect of the build.
 */
function theKeyboardWasElsewhere(sittings: readonly number[], when: string): string {
  return (
    `sitting${sittings.length === 1 ? '' : 's'} ${sittings.map((one) => String(one)).join(', ')} ` +
    `${when} while the window did not hold the keyboard, and the editor answers about the part its ` +
    'active group is in: what it said there is a reading of some window, and this recording cannot ' +
    'say it was this one'
  );
}

/**
 * One finding, with the number a budget reads.
 *
 * Overloaded rather than given an optional argument, so that the type checker
 * asks for the count at every red answer and refuses it at the two answers
 * where counting is meaningless. A default would have let a new red branch ship
 * with a number nobody chose.
 */
function finding(point: number, says: string, answer: 'green' | 'unmeasured', because: string): Finding;
function finding(point: number, says: string, answer: 'red', because: string, violations: number): Finding;
function finding(point: number, says: string, answer: Answer, because: string, violations?: number): Finding {
  return { point, says, answer, because, violations: answer === 'green' ? 0 : violations ?? null };
}

function isText(value: string | null): value is string {
  return value !== null;
}

/**
 * The sighting the observer took on its own first line, by name.
 *
 * By name and not `snapshots[0]`, because the whole of point 1 rests on this
 * one being the EARLIEST: a recording whose first line is something else is a
 * recording whose observer arrived late, and reading its first line as the
 * earliest would hide exactly the thing the flag on it exists to say.
 */
function earliestOf(sitting: SittingRecording): StandSnapshot | null {
  return sitting.snapshots.find((one) => one.what === ACTIVATED) ?? null;
}

/** The sighting the measurer marked as the one to judge from. */
function settledOf(sitting: SittingRecording): StandSnapshot | null {
  return sitting.snapshots.find((one) => one.what === SETTLED) ?? null;
}

type Strip =
  | { readonly kind: 'one', readonly group: StandGroup }
  | { readonly kind: 'none' }
  | { readonly kind: 'many', readonly columns: readonly number[] }
  | { readonly kind: 'unmeasured' };

/** Which group is ours, at one instant. */
function stripOf(snapshot: StandSnapshot): Strip {
  if (snapshot.groups.some((one) => one.terminals === null)) {
    return { kind: 'unmeasured' };
  }
  const ours = snapshot.groups.filter((one) => (one.terminals ?? 0) > 0);
  const only = ours[0];
  if (only === undefined) {
    return { kind: 'none' };
  }
  return ours.length === 1 ? { kind: 'one', group: only } : { kind: 'many', columns: ours.map((one) => one.column) };
}

/**
 * The strip of every sitting, at the moment it settled, or `null` when no
 * sighting in the whole recording says which tabs were terminals.
 */
function settledStrips(
  recording: StandRecording
): readonly { sitting: number, snapshot: StandSnapshot, strip: Strip }[] | null {
  const seen = recording.sittings.flatMap((one) => {
    const snapshot = settledOf(one);
    return snapshot === null ? [] : [{ sitting: one.sitting, snapshot, strip: stripOf(snapshot) }];
  });
  return seen.length === 0 || seen.every((one) => one.strip.kind === 'unmeasured') ? null : seen;
}

// --- reading the grid -------------------------------------------------------
//
// The grid is a TREE and is read as one here rather than borrowed from
// `@gripterm/core`, which reads it the same way. Deliberately: a stand that
// judged the product's placement with the product's own reader would agree with
// it by construction, and the one defect it could never see is the reader.

/** How many columns a family of nodes accounts for. */
function leavesIn(nodes: readonly GridNode[]): number {
  return nodes.reduce((sum, node) => sum + (node.groups === null ? 1 : leavesIn(node.groups)), 0);
}

/**
 * The last leaf of the grid when that leaf is a ROW AT THE BOTTOM, counted the
 * way `ViewColumn` counts -- or `null` when the end of the area is not a row.
 *
 * A leaf reached by descending through the LAST child of every level, at a level
 * laid out in rows, with something above it. Nothing else is a strip: in a window
 * laid out in columns the last leaf is the right-hand COLUMN, and a terminal
 * full height beside a person's files is the complaint, not the fix.
 */
function rowAtTheEnd(grid: Grid): number | null {
  let orientation = grid.orientation;
  let family = grid.groups;
  let before = 0;
  for (;;) {
    const last = family.at(-1);
    if (last === undefined) {
      return null;
    }
    for (const node of family.slice(0, -1)) {
      before += node.groups === null ? 1 : leavesIn(node.groups);
    }
    if (last.groups === null) {
      return family.length > 1 && orientation === ROWS ? before : null;
    }
    family = last.groups;
    orientation = orientation === ROWS ? COLUMNS : ROWS;
  }
}

/**
 * What the leaf at `index` holds of the space it shares with its siblings, or
 * `null` when the editor has not sized that family.
 *
 * `null` is "the editor has not said" and never "zero": a family whose sizes add
 * up to nothing is one the editor has not laid out, and reading that as a share
 * of zero would call an unlaid grid a strip that is already small enough.
 */
function shareOfLeaf(grid: Grid, index: number): number | null {
  const family = familyOf(grid.groups, { index, seen: 0 });
  if (family === null) {
    return null;
  }
  const total = family.siblings.reduce((sum, node) => sum + (node.size ?? 0), 0);
  return total <= 0 ? null : (family.node.size ?? 0) / total;
}

interface Family {
  readonly siblings: readonly GridNode[];
  readonly node: GridNode;
}

/** The list a leaf lives in, counting leaves from the left. */
function familyOf(
  siblings: readonly GridNode[],
  state: { readonly index: number, seen: number }
): Family | null {
  for (const node of siblings) {
    if (node.groups === null) {
      if (state.seen === state.index) {
        return { siblings, node };
      }
      state.seen += 1;
    } else {
      const found = familyOf(node.groups, state);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}
