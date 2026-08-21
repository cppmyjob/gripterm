import {
  OwnerId,
  OwnerRef,
  TerminalId,
  dropInTree,
  groupTerminals,
} from '../../packages/core/src/index';
import { makeEntry } from '../helpers/domain-fixtures';
import type { TerminalEntry, TreeDrop } from '../../packages/core/src/index';

/**
 * A row of the LIST dragged to another place in it (owner, 2026-08-21: "не
 * реализован drag and drop в tree view где список всех терминалов").
 *
 * The arrangement itself is `terminal-order`, and this file adds nothing to it.
 * What is decided here is everything the list has and the strip has not: the
 * list shows every terminal ON THE MACHINE (par. 0), under the project each one
 * belongs to, and most of those rows are not this window's to write (par. 4.8).
 * So a drop has to be able to say no, and each no has to be a different no --
 * that is the whole of this file.
 *
 * Kept out of the tree view for the reason par. 3.5 gives: `packages/extension`
 * is outside the coverage thresholds, and a rule taken there is a rule nothing
 * checks.
 */

const HERE = 'D:/Projects/foo';
const THERE = 'D:/Projects/bar';
const MINUTE = 60_000;

const OURS = 'window-ours';
const THEIRS = 'window-theirs';

function row(
  index: number,
  options: { folder?: string | null, window?: string, madeAtMs?: number } = {}
): TerminalEntry {
  return makeEntry({
    terminalId: TerminalId.fromString(`1111111${index}-1111-4111-8111-111111111111`),
    createdAt: new Date(options.madeAtMs ?? index * MINUTE),
    owner: OwnerRef.create({
      kind: 'window',
      ownerId: OwnerId.fromString(options.window ?? OURS),
      editorKind: 'vscode',
      workspaceFolder: options.folder === undefined ? HERE : options.folder,
    }),
  });
}

function id(index: number): TerminalId {
  return TerminalId.fromString(`1111111${index}-1111-4111-8111-111111111111`);
}

/** Everything this window may write: the records of the window named `OURS`. */
function ownsOurs(terminalId: TerminalId): boolean {
  return terminalId.value.startsWith('1111111');
}

function drop(
  entries: readonly TerminalEntry[],
  moved: TerminalId,
  target: Parameters<typeof dropInTree>[0]['target'],
  owns: (terminalId: TerminalId) => boolean = ownsOurs
): TreeDrop {
  return dropInTree({
    groups: groupTerminals(entries, [HERE]),
    moved,
    target,
    owns,
  });
}

/** The ids of the rows the drop wants written down. */
function written(result: TreeDrop): readonly string[] {
  return result.changed.map((entry) => entry.terminalId.value);
}

describe('dropInTree moves a row where the hand let it go', () => {
  it('puts the dragged row where the row it was dropped on stands', () => {
    const rows = [row(1), row(2), row(3)];

    const result = drop(rows, id(3), { kind: 'row', terminalId: id(1) });

    expect(result.refusal).toBeNull();
    expect(written(result)).toStrictEqual([id(3).value]);
    const moved = result.changed[0];
    expect(moved).toBeDefined();
    expect(moved?.placement).toBeLessThan(row(1).placement);
  });

  it('writes one record, not the arrangement', () => {
    const rows = [row(1), row(2), row(3)];

    const result = drop(rows, id(1), { kind: 'row', terminalId: id(3) });

    expect(result.changed).toHaveLength(1);
  });

  it('changes nothing when a row is dropped on itself', () => {
    const rows = [row(1), row(2)];

    const result = drop(rows, id(1), { kind: 'row', terminalId: id(1) });

    expect(result.refusal).toBeNull();
    expect(result.changed).toStrictEqual([]);
  });

  it('puts a row dropped on its own heading first', () => {
    const rows = [row(1), row(2), row(3)];

    const result = drop(rows, id(3), { kind: 'heading', key: HERE.toLowerCase() });

    expect(result.refusal).toBeNull();
    const moved = result.changed[0];
    expect(moved?.placement).toBeLessThan(row(1).placement);
  });
});

describe('dropInTree refuses what this window may not do', () => {
  it('refuses a row belonging to another window', () => {
    // par. 4.8: a window writes its own records and nobody else's. The list
    // shows every terminal on the machine, so most rows in it are this one.
    const rows = [row(1), row(2, { window: THEIRS })];

    const result = drop(rows, id(2), { kind: 'row', terminalId: id(1) }, () => false);

    expect(result.refusal).toBe('not-ours');
    expect(result.changed).toStrictEqual([]);
  });

  it('refuses a drop under another project', () => {
    // The project of a terminal is the folder of the window that made it. It is
    // not ours to change, and a row that jumped headings would be a lie about
    // which window answers for it.
    const rows = [row(1), row(2, { folder: THERE })];

    const result = drop(rows, id(1), { kind: 'row', terminalId: id(2) });

    expect(result.refusal).toBe('other-project');
    expect(result.changed).toStrictEqual([]);
  });

  it('refuses a drop on another project heading', () => {
    const rows = [row(1), row(2, { folder: THERE })];

    const result = drop(rows, id(1), { kind: 'heading', key: THERE.toLowerCase() });

    expect(result.refusal).toBe('other-project');
  });

  it('refuses a drop that landed on nothing', () => {
    const result = drop([row(1), row(2)], id(1), null);

    expect(result.refusal).toBe('nowhere');
  });

  it('refuses a row that is no longer in the list', () => {
    const result = drop([row(1)], id(9), { kind: 'row', terminalId: id(1) });

    expect(result.refusal).toBe('nowhere');
  });

  it('refuses rather than write half an arrangement it may not finish', () => {
    // Two neighbours made in the same millisecond leave no room between them,
    // and the answer to that -- writing the whole arrangement out again -- is
    // one this window may only give for its own records. Here one of them is
    // somebody else's, so the drop is refused whole: half an arrangement is an
    // order nobody asked for.
    const rows = [
      row(1, { madeAtMs: 0 }),
      row(2, { madeAtMs: 1, window: THEIRS }),
      row(3, { madeAtMs: 10 * MINUTE }),
    ];

    const result = drop(rows, id(3), { kind: 'row', terminalId: id(2) }, (terminalId) =>
      !terminalId.equals(id(2)));

    expect(result.refusal).toBe('no-room');
    expect(result.changed).toStrictEqual([]);
  });

  it('writes the arrangement out when the rows with no room are all ours', () => {
    const rows = [
      row(1, { madeAtMs: 0 }),
      row(2, { madeAtMs: 1 }),
      row(3, { madeAtMs: 10 * MINUTE }),
    ];

    const result = drop(rows, id(3), { kind: 'row', terminalId: id(2) });

    expect(result.refusal).toBeNull();
    expect(result.changed.length).toBeGreaterThan(1);
  });
});
