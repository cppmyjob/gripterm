/**
 * What a sitting of the two-sitting stand leaves behind, and how it is read
 * back.
 *
 * The stand is two halves that share exactly this file. The MEASURER
 * (`tests/stand/run.mjs` and the observer it loads) starts a real editor several
 * times over one project folder and appends lines here; the JUDGE (`judge.ts`)
 * is a function from those lines to a verdict and never starts anything. The
 * format is the whole of the contract between them, which is why it is written
 * down as types rather than passed around as `any`.
 *
 * **Every field is present, and `null` means "the recording does not say".**
 * Not an optional property: a stand whose measurement was never taken must be
 * able to answer `unmeasured`, and a missing key and a measured absence are two
 * different facts. `staircase-2026-08-23.ndjson` is exactly that case -- seven
 * real sittings whose observer never asked whether a tab was a terminal -- and
 * a judge that read those as "no terminals" would call an unmeasured window
 * clean.
 */

/**
 * One node of the editor's grid, as `vscode.getEditorLayout` answers -- with the
 * two absent-or-present keys made total.
 *
 * The editor omits `size` for a group it has not laid out yet and omits `groups`
 * on a leaf. Both are read here as `null`, so that nothing downstream has to
 * remember which of the two spellings of "nothing" it is looking at.
 */
export interface GridNode {
  readonly size: number | null;
  readonly groups: readonly GridNode[] | null;
}

export interface Grid {
  /** `0` lays a family out in columns, `1` in rows. Levels alternate. */
  readonly orientation: number;
  readonly groups: readonly GridNode[];
}

/** One tab group, at one instant. */
export interface StandGroup {
  /** The editor's own number for it: `ViewColumn`, counting leaves from the left. */
  readonly column: number;
  readonly active: boolean | null;
  readonly tabs: readonly string[];
  /** How many of those tabs are terminals; `null` when the recording never asked. */
  readonly terminals: number | null;
}

export interface StandSnapshot {
  readonly sitting: number;
  /** Where this sighting stands among the sitting's own, from one. */
  readonly ordinal: number;
  readonly at: string;
  /** Why it was taken. Three of these are read by the judge -- see below. */
  readonly what: string;
  readonly sinceActivationMs: number | null;
  /**
   * Whether the product had already activated when the observer's first line
   * ran.
   *
   * The activation order of two extensions in one host is not guaranteed, so an
   * observer that arrived second saw a window somebody had already tidied. A
   * clean first sighting taken then is not evidence, and the judge says so
   * rather than passing it.
   */
  readonly productAlreadyActive: boolean | null;
  /** The editor's key for this folder: the last segment of `context.storageUri`. */
  readonly workspaceStorage: string | null;
  /**
   * True when the tab groups changed under the grid while both were being read.
   *
   * The two are asked of the editor separately and one of them is asynchronous.
   * A pair taken from two instants is two facts about two windows, which is the
   * defect the prototype had: it read the groups AFTER awaiting the grid.
   */
  readonly torn: boolean | null;
  /**
   * Whether the window held the keyboard when this sighting was taken.
   *
   * `vscode.window.state.focused`, and it is here because three of the nine
   * points read the editor's own layout, which the editor answers for the part
   * its ACTIVE group is in (measured 2026-08-25: 12 settled sightings of 12).
   * A window that has not got the keyboard is a window whose active group
   * belongs to whatever took it, so a reading taken there is one the judge
   * refuses rather than one it calls a defect.
   *
   * `null` is a recording that never asked -- every one taken before
   * 2026-08-26 -- and it is NOT read as "the window had lost it": the fixtures
   * the acceptance of the stand rests on are of that kind, and a rule that
   * turned them all unmeasured would answer about nothing at all.
   */
  readonly focused: boolean | null;
  readonly grid: Grid | null;
  /** What the editor said instead of a grid, when it refused to answer. */
  readonly gridRefused: string | null;
  readonly groups: readonly StandGroup[];
}

/** One line of a record's `starts.jsonl`, narrowed to what the stand judges. */
export interface StandStart {
  readonly what: string;
  /** `resume` continues the conversation the record names; `launch` begins a new one. */
  readonly intent: string | null;
}

export interface StandRecord {
  readonly id: string;
  /** What the product orders the list by, first key then second. */
  readonly placement: number | null;
  readonly createdAt: number | null;
  readonly starts: readonly StandStart[];
}

/** What only the process outside the window knows, written once a sitting has closed. */
export interface StandSitting {
  readonly sitting: number;
  /**
   * From the observer's activation to the first sighting in which the window
   * held everything it ended the sitting holding.
   *
   * Not the length of the sitting: the driver's own waits are in that, and they
   * are the stand's cost rather than the product's.
   */
  readonly restoredMs: number | null;
  /**
   * The two `tookMs` the product itself printed into its log, read back out of
   * the store after the sitting closed (Ш11).
   *
   * Not the driver's own clock, and that is the whole point: the driver's
   * numbers hold its waits, its spawns and the editor's own startup, none of
   * which are the product's. These two are stamped inside `activate` -- one when
   * the list reaches the screen, one when activation finishes -- and until this
   * field existed nothing anywhere read them.
   */
  readonly listedMs: number | null;
  readonly activatedMs: number | null;
  readonly records: readonly StandRecord[];
}

export interface SittingRecording {
  readonly sitting: number;
  readonly snapshots: readonly StandSnapshot[];
  readonly summary: StandSitting | null;
}

/** Where the recording came from, and what it is honest about not holding. */
export interface StandHead {
  readonly what: string;
  readonly editor: string;
  readonly recordedAt: string;
  readonly notMeasured: readonly string[];
}

export interface StandRecording {
  readonly head: StandHead;
  readonly sittings: readonly SittingRecording[];
}

/**
 * The three sightings the judge reads by name.
 *
 * By name and not by position, and that is the correction of the third defect
 * the prototype had: `vscode.getEditorLayout` answers `Canceled: Canceled` on
 * the way down, every time it was measured, so "the last line of the sitting"
 * is the one line whose grid is never there. The measurer says which sighting is
 * the settled one, at the moment it takes it.
 */
export const ACTIVATED = 'activated';
export const SETTLED = 'settled';
export const FILE_OPENED = 'a file opened';

/**
 * The recording, read back from the lines a run appended.
 *
 * Strict on purpose. Everything here was written by the stand's own two halves,
 * so a line that does not fit is a stand that has drifted from itself -- and the
 * one thing worse than a red stand is one that reads yesterday's format as
 * today's and answers about a window nobody looked at.
 */
export function parseRecording(recorded: string): StandRecording {
  const lines = recorded
    .split(/\r?\n/u)
    .map((body, at) => ({ line: at + 1, body }))
    .filter((one) => one.body.trim().length > 0);

  const head = lines[0];
  if (head === undefined) {
    throw new Error('this recording has no head line, and no lines at all');
  }

  const values = lines.map((one) => ({ line: one.line, value: readJson(one.line, one.body) }));
  const first = values[0];
  /* c8 ignore next 3 -- `lines[0]` was just proved to be there. */
  if (first === undefined) {
    throw new Error('this recording has no head line, and no lines at all');
  }
  if (kindOf(first.value) !== 'stand') {
    throw new Error(
      `the first line of a recording is its head -- a line with "kind":"stand" -- and this one is ${JSON.stringify(kindOf(first.value))}`
    );
  }

  const snapshots: StandSnapshot[] = [];
  const summaries: StandSitting[] = [];
  for (const { line, value } of values.slice(1)) {
    const kind = kindOf(value);
    if (kind === 'snapshot') {
      snapshots.push(readSnapshot(line, value));
    } else if (kind === 'sitting') {
      summaries.push(readSitting(line, value));
    } else {
      throw new Error(`line ${String(line)} of the recording has a kind nothing reads: ${JSON.stringify(kind)}`);
    }
  }

  const numbers = [...new Set([...snapshots, ...summaries].map((one) => one.sitting))].sort(
    (left, right) => left - right
  );
  return {
    head: readHead(first.value),
    sittings: numbers.map((sitting) => ({
      sitting,
      snapshots: snapshots.filter((one) => one.sitting === sitting),
      summary: summaries.find((one) => one.sitting === sitting) ?? null,
    })),
  };
}

// --- reading one line -------------------------------------------------------

type Fields = Readonly<Record<string, unknown>>;

function readJson(line: number, body: string): Fields {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error(`line ${String(line)} of the recording is not JSON`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`line ${String(line)} of the recording is not an object`);
  }
  return value as Fields;
}

function kindOf(value: Fields): unknown {
  return value.kind;
}

function readHead(value: Fields): StandHead {
  return {
    what: text(value.what) ?? '',
    editor: text(value.editor) ?? '',
    recordedAt: text(value.recordedAt) ?? '',
    notMeasured: Array.isArray(value.notMeasured)
      ? value.notMeasured.map((one) => text(one) ?? String(one))
      : [],
  };
}

function readSnapshot(line: number, value: Fields): StandSnapshot {
  return {
    sitting: number(line, 'sitting', value.sitting),
    ordinal: number(line, 'ordinal', value.ordinal),
    at: text(value.at) ?? '',
    what: text(value.what) ?? '',
    sinceActivationMs: maybeNumber(line, 'sinceActivationMs', value.sinceActivationMs),
    productAlreadyActive: maybeFlag(line, 'productAlreadyActive', value.productAlreadyActive),
    workspaceStorage: text(value.workspaceStorage),
    torn: maybeFlag(line, 'torn', value.torn),
    focused: maybeFlag(line, 'focused', value.focused),
    grid: readGrid(line, value.grid),
    gridRefused: text(value.gridRefused),
    groups: list(line, 'groups', value.groups).map((one) => readGroup(line, one)),
  };
}

function readGroup(line: number, value: unknown): StandGroup {
  const fields = object(line, 'a group', value);
  return {
    column: number(line, 'column', fields.column),
    active: maybeFlag(line, 'active', fields.active),
    tabs: list(line, 'tabs', fields.tabs).map((one) => text(one) ?? ''),
    terminals: maybeNumber(line, 'terminals', fields.terminals),
  };
}

function readGrid(line: number, value: unknown): Grid | null {
  if (value === null || value === undefined) {
    return null;
  }
  const fields = object(line, 'the grid', value);
  return {
    orientation: number(line, 'orientation', fields.orientation),
    groups: list(line, 'the grid`s groups', fields.groups).map((one) => readNode(line, one)),
  };
}

function readNode(line: number, value: unknown): GridNode {
  const fields = object(line, 'a node of the grid', value);
  const groups = fields.groups;
  return {
    size: maybeNumber(line, 'size', fields.size),
    groups:
      groups === undefined || groups === null
        ? null
        : list(line, 'the groups of a node', groups).map((one) => readNode(line, one)),
  };
}

function readSitting(line: number, value: Fields): StandSitting {
  return {
    sitting: number(line, 'sitting', value.sitting),
    restoredMs: maybeNumber(line, 'restoredMs', value.restoredMs),
    listedMs: maybeNumber(line, 'listedMs', value.listedMs),
    activatedMs: maybeNumber(line, 'activatedMs', value.activatedMs),
    records: list(line, 'records', value.records).map((one) => readRecord(line, one)),
  };
}

function readRecord(line: number, value: unknown): StandRecord {
  const fields = object(line, 'a record', value);
  return {
    id: text(fields.id) ?? '',
    placement: maybeNumber(line, 'placement', fields.placement),
    createdAt: maybeNumber(line, 'createdAt', fields.createdAt),
    starts: list(line, 'starts', fields.starts).map((one) => {
      const start = object(line, 'a start', one);
      return { what: text(start.what) ?? '', intent: text(start.intent) };
    }),
  };
}

// --- the five ways a field can be wrong -------------------------------------

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function number(line: number, named: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`line ${String(line)} of the recording has no ${named}`);
  }
  return value;
}

function maybeNumber(line: number, named: string, value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return number(line, named, value);
}

function maybeFlag(line: number, named: string, value: unknown): boolean | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`line ${String(line)} of the recording says ${named} is ${JSON.stringify(value)}, which is not true or false`);
  }
  return value;
}

function list(line: number, named: string, value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`line ${String(line)} of the recording has no ${named}`);
  }
  return value;
}

function object(line: number, named: string, value: unknown): Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`line ${String(line)} of the recording has ${named} that is not an object`);
  }
  return value as Fields;
}
