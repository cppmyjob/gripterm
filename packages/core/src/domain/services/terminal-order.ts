import type { TerminalEntry } from '../entities/terminal-entry';
import type { TerminalId } from '../entities/terminal-id';

/**
 * The order the tabs of the panel -- and the rows of the tree -- stand in, and
 * what a person dragging one of them changes.
 *
 * **The defect this answers**, reported by the owner on 2026-08-21: "после
 * перезагрузки меняется порядок табов терминалов... сначала идёт таб с
 * терминалом 2 а потом 1". Nothing held an order at all. `readAll` answers in
 * the order the filesystem lists directories -- their names are uuids -- the
 * restore walks that list in that order, and the panel takes the terminals in
 * the order they come back. Two runs were free to disagree, and a person had no
 * way to correct either of them: the tabs could not be dragged.
 *
 * **The owner's decisions, same day.** The order lives IN THE RECORD, so that it
 * survives a restart and travels with the record to whichever window adopts it;
 * and it applies to the strip AND to the tree, so there is one arrangement
 * rather than two that drift.
 *
 * **Why a number on a record rather than a list somewhere.** A window may write
 * only the records it owns (§4.8). A stored LIST of ids would be a second place
 * where the set of terminals is written down -- one that can disagree with the
 * records themselves -- and it would have to be written by somebody for records
 * that are not theirs. A number per record makes a drag ONE write, of the record
 * that moved, by the window that owns it.
 */

/**
 * The gap left between two tabs when the whole arrangement is written out.
 *
 * A minute in the same milliseconds `placement` falls back to, so that a spread
 * arrangement and a set of untouched records sit in one number space and read
 * the same way in a debugger.
 */
const SPACING = 60_000;

/**
 * How close two neighbours may be and still have room between them.
 *
 * Two milliseconds rather than "anything above zero", so that the rule is a
 * statement about the data and not about floating point: halving a gap of one
 * yields a number a reader cannot check by eye, and the case is rare enough that
 * writing the arrangement out again costs nothing anybody notices.
 */
const NO_ROOM = 2;

/**
 * The entries in the order they are shown, oldest arrangement first.
 *
 * Total and stable: `placement` decides, then the moment of creation, then the
 * id. The last two are not decoration -- two windows reading one store must draw
 * the same list, and without a last resort the answer would depend on which
 * record the filesystem listed first, which is the defect this file exists for.
 */
export function arranged(entries: readonly TerminalEntry[]): readonly TerminalEntry[] {
  return [...entries].sort((left, right) => {
    if (left.placement !== right.placement) {
      return left.placement - right.placement;
    }
    if (left.createdAt.getTime() !== right.createdAt.getTime()) {
      return left.createdAt.getTime() - right.createdAt.getTime();
    }
    return left.terminalId.value < right.terminalId.value ? -1 : 1;
  });
}

export interface ReorderRequest {
  /** Every terminal the person is looking at, in any order. */
  readonly entries: readonly TerminalEntry[];
  readonly moved: TerminalId;
  /**
   * Where it should end up, counted in the arranged list AFTER the move, from 0.
   *
   * Clamped rather than refused: this number comes from a page, and a page is
   * the one place a wrong index can arrive from without anybody in this build
   * having made a mistake.
   */
  readonly toIndex: number;
}

/**
 * The records whose arrangement changed -- usually one, and everything only when
 * two neighbours have no room between them.
 *
 * Returns the new instances rather than writing anything: what may be written,
 * and by whom, is the repository's rule and not this function's.
 */
export function reorderTerminals(request: ReorderRequest): readonly TerminalEntry[] {
  const list = arranged(request.entries);
  const from = list.findIndex((entry) => entry.terminalId.equals(request.moved));
  if (from === -1) {
    return [];
  }
  const to = Math.min(Math.max(request.toIndex, 0), list.length - 1);
  if (to === from) {
    return [];
  }

  const moved = list[from];
  if (moved === undefined) {
    return [];
  }
  const without = list.filter((entry) => !entry.terminalId.equals(request.moved));
  const before = without[to - 1];
  const after = without[to];

  if (before !== undefined && after !== undefined) {
    return after.placement - before.placement < NO_ROOM
      ? spread(without, moved, to)
      : [moved.withOrder((before.placement + after.placement) / 2)];
  }
  if (after !== undefined) {
    return [moved.withOrder(after.placement - SPACING)];
  }
  if (before !== undefined) {
    return [moved.withOrder(before.placement + SPACING)];
  }
  // One terminal, moved to where it already is. `to === from` caught it above,
  // and this line is what makes that reasoning unnecessary to trust.
  return [];
}

/**
 * The whole arrangement, written out evenly, with the moved tab in its new
 * place.
 *
 * The one path where a drag writes more than one record, and it is a path a
 * window can always take: every record on the strip is its own.
 */
function spread(
  without: readonly TerminalEntry[],
  moved: TerminalEntry,
  to: number
): readonly TerminalEntry[] {
  const wanted = [...without.slice(0, to), moved, ...without.slice(to)];
  const base = wanted[0]?.placement ?? moved.placement;
  return wanted
    .map((entry, index) => entry.withOrder(base + index * SPACING))
    .filter((entry, index) => entry !== wanted[index]);
}
