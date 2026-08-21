import {
  OwnerId,
  OwnerRef,
  TerminalId,
  groupTerminals,
} from '../../packages/core/src/index';
import { makeEntry } from '../helpers/domain-fixtures';
import type { TerminalEntry, TerminalGroup } from '../../packages/core/src/index';

/**
 * The list, in the shape П4 asks for: every window on the machine shows every
 * terminal, grouped by the project it belongs to.
 *
 * The grouping is decided here rather than in the tree view for the reason §3.5
 * gives -- `packages/extension` is outside the coverage thresholds, so a rule
 * taken there is a rule nothing checks. What remains on the other side is a
 * `TreeItem` per group.
 *
 * The rules that matter are about IDENTITY of a folder rather than about
 * drawing: two windows spell one folder differently often enough (a shell types
 * `d:\projects\x`, the explorer hands over `D:\Projects\X`) that a naive group
 * key would split one project in half and tell a person their terminals are
 * somewhere else.
 */

const OPEN_HERE = 'D:/Projects/foo';
const ELSEWHERE = 'D:/Projects/bar';

function rowIn(folder: string | null, index = 0): TerminalEntry {
  return makeEntry({
    terminalId: TerminalId.fromString(`1111111${index}-1111-4111-8111-111111111111`),
    owner: OwnerRef.create({
      kind: 'window',
      ownerId: OwnerId.fromString(`window-${index}`),
      editorKind: 'vscode',
      workspaceFolder: folder,
    }),
  });
}

function labels(groups: readonly TerminalGroup[]): readonly string[] {
  return groups.map((group) => group.label);
}

function rowsIn(group: TerminalGroup | undefined): readonly string[] {
  return (group?.entries ?? []).map((entry) => entry.terminalId.value);
}

describe('groupTerminals puts one project in one group', () => {
  it('keeps the terminals of one folder together, in the order they arrived', () => {
    const groups = groupTerminals([rowIn(OPEN_HERE, 1), rowIn(OPEN_HERE, 2)], [OPEN_HERE]);

    expect(groups).toHaveLength(1);
    expect(rowsIn(groups[0])).toStrictEqual([
      '11111111-1111-4111-8111-111111111111',
      '11111112-1111-4111-8111-111111111111',
    ]);
  });

  it('gives every folder a group of its own', () => {
    const groups = groupTerminals([rowIn(OPEN_HERE, 1), rowIn(ELSEWHERE, 2)], [OPEN_HERE]);

    expect(groups).toHaveLength(2);
  });

  it('treats two spellings of one Windows folder as one project', () => {
    // The record outlives the window that wrote it, and Windows does not care
    // about case or which slash was used. Splitting them would show a person
    // two projects where they have one, with their terminals divided between
    // them for no reason they can see.
    const groups = groupTerminals(
      [rowIn('D:\\Projects\\Foo', 1), rowIn('d:/projects/foo/', 2)],
      []
    );

    expect(groups).toHaveLength(1);
    expect(rowsIn(groups[0])).toHaveLength(2);
  });

  it('keeps two posix folders that differ only in case apart', () => {
    // `/home/a` and `/home/A` are two directories there, and merging them is
    // the same mistake as splitting one Windows folder, from the other side.
    const groups = groupTerminals([rowIn('/home/a', 1), rowIn('/home/A', 2)], []);

    expect(groups).toHaveLength(2);
  });

  it('names a group by the folder as the first record naming it spells it', () => {
    const groups = groupTerminals([rowIn('D:\\Projects\\Foo', 1), rowIn('d:/projects/foo', 2)], []);

    expect(groups[0]?.folder).toBe('D:\\Projects\\Foo');
  });
});

describe('groupTerminals orders the groups so this window reads its own first', () => {
  it('puts the folders this window has open first, in the window\'s own order', () => {
    const groups = groupTerminals(
      [rowIn(ELSEWHERE, 1), rowIn('D:/Projects/second', 2), rowIn(OPEN_HERE, 3)],
      [OPEN_HERE, 'D:/Projects/second']
    );

    expect(labels(groups)).toStrictEqual(['foo', 'second', 'bar']);
  });

  it('sorts the rest by path, so two readings of one machine agree', () => {
    const groups = groupTerminals(
      [rowIn('D:/Projects/zeta', 1), rowIn('D:/Projects/alpha', 2), rowIn('D:/Projects/mid', 3)],
      []
    );

    expect(labels(groups)).toStrictEqual(['alpha', 'mid', 'zeta']);
  });

  it('puts the terminals of a window with no folder in a group of their own, last', () => {
    const groups = groupTerminals([rowIn(null, 1), rowIn(OPEN_HERE, 2)], [OPEN_HERE]);

    expect(labels(groups)).toStrictEqual(['foo', 'No folder']);
  });

  it('has nothing to group when there are no terminals', () => {
    expect(groupTerminals([], [OPEN_HERE])).toStrictEqual([]);
  });

  it('does not invent a group for an open folder with no terminals in it', () => {
    // An empty group is a chevron with nothing behind it, and a list of the
    // person's folders is what the explorer above it already is.
    const groups = groupTerminals([rowIn(OPEN_HERE, 1)], [OPEN_HERE, ELSEWHERE]);

    expect(labels(groups)).toStrictEqual(['foo']);
  });
});

describe('groupTerminals says which project is this window\'s', () => {
  it('marks the folders this window has open', () => {
    const groups = groupTerminals([rowIn(OPEN_HERE, 1), rowIn(ELSEWHERE, 2)], [OPEN_HERE]);

    expect(groups.map((group) => group.mine)).toStrictEqual([true, false]);
  });

  it('marks a folder open here even when another window spells it differently', () => {
    const groups = groupTerminals([rowIn('d:/projects/foo', 1)], ['D:\\Projects\\Foo']);

    expect(groups[0]?.mine).toBe(true);
  });

  it('calls the folderless group this window\'s only when this window has no folder', () => {
    // The same rule the restore predicate uses (§6): `null` belongs to a window
    // with no folders open, and to no other.
    expect(groupTerminals([rowIn(null, 1)], []).at(0)?.mine).toBe(true);
    expect(groupTerminals([rowIn(null, 1)], [OPEN_HERE]).at(0)?.mine).toBe(false);
  });
});

describe('groupTerminals names a group the way a person reads a path', () => {
  it('takes the label from the last segment and the detail from the parent', () => {
    const groups = groupTerminals([rowIn('D:\\Projects\\foo', 1)], []);

    expect(groups[0]?.label).toBe('foo');
    expect(groups[0]?.detail).toBe('D:\\Projects');
  });

  it('leaves the detail empty when the folder has no parent to show', () => {
    const groups = groupTerminals([rowIn('/foo', 1)], []);

    expect(groups[0]?.label).toBe('foo');
    expect(groups[0]?.detail).toBe('');
  });

  it('gives a drive root and a posix root a label rather than an empty line', () => {
    // Rare, and the cost of getting it wrong is a group nobody can click on
    // because it has no name at all.
    expect(groupTerminals([rowIn('D:\\', 1)], []).at(0)?.label).toBe('D:');
    expect(groupTerminals([rowIn('/', 1)], []).at(0)?.label).toBe('/');
  });

  it('gives the folderless group a key of its own, whatever a folder normalises to', () => {
    // A posix root normalises to nothing at all, and a group key it shared with
    // "no folder" would put a window's terminals under somebody else's heading.
    const groups = groupTerminals([rowIn('/', 1), rowIn(null, 2)], []);

    expect(groups).toHaveLength(2);
    expect(new Set(groups.map((group) => group.key)).size).toBe(2);
  });
});

/**
 * The order the rows stand in inside a group (owner's decision 2026-08-21).
 *
 * The same arrangement the tabs of the panel are drawn in, and for the same
 * reason: it lives on the record, so the two views cannot come to different
 * conclusions about where a terminal belongs, and a restart cannot change
 * either. Before this, both drew rows in the order the store happened to hand
 * the records over -- which is the order the filesystem lists uuid-named
 * directories.
 */
describe('the order of the rows inside a group', () => {
  it('follows the arrangement on the records, not the order they arrived', () => {
    const first = rowIn(OPEN_HERE, 1).withOrder(3000);
    const second = rowIn(OPEN_HERE, 2).withOrder(1000);

    const groups = groupTerminals([first, second], [OPEN_HERE]);

    expect(groups[0]?.entries.map((entry) => entry.terminalId.value)).toStrictEqual([
      second.terminalId.value,
      first.terminalId.value,
    ]);
  });

  it('reads a record nobody arranged as one made when it was made', () => {
    const older = rowIn(OPEN_HERE, 1);
    const newer = rowIn(OPEN_HERE, 2);

    // Same fixture moment for both, so the last resort decides -- and the point
    // of the assertion is that it decides the SAME WAY whichever order they
    // arrive in. Two windows reading one store must draw one list.
    const one = groupTerminals([older, newer], [OPEN_HERE]);
    const other = groupTerminals([newer, older], [OPEN_HERE]);

    expect(one[0]?.entries.map((entry) => entry.terminalId.value)).toStrictEqual(
      other[0]?.entries.map((entry) => entry.terminalId.value)
    );
  });
});
