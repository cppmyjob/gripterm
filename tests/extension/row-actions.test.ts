import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONTEXT_ABANDONED,
  CONTEXT_ADOPTABLE,
  CONTEXT_FOREIGN,
  CONTEXT_LIVE,
  CONTEXT_OVER,
} from '../../packages/core/src/index';

/**
 * What a row offers, against the values the presenter can put on one.
 *
 * The two halves are declared in different languages and neither can see the
 * other: `terminal-presentation.ts` decides a row's `contextValue`, and the
 * manifest decides which commands a `when` clause with that value shows. A
 * value the manifest never mentions is a row with no menu at all, and nothing
 * in either file says so -- the row simply does nothing when a person tries.
 *
 * The owner reported exactly that shape twice. On 2026-08-13: "detached records
 * I cannot delete", which produced `CONTEXT_ABANDONED`. And in the M3.14
 * acceptance run: a row whose window was gone "offers Adopt, and does not go
 * away" -- deletion existed, but only behind the right-button menu, while the
 * one button ON the row invited the person to take the record instead.
 */

const EXTENSION = join(__dirname, '..', '..', 'packages', 'extension');

interface MenuEntry {
  readonly command: string;
  readonly when: string;
  readonly group?: string;
}

interface Manifest {
  readonly contributes: {
    readonly commands: readonly { readonly command: string, readonly icon?: string }[];
    readonly menus: Readonly<Record<string, readonly MenuEntry[]>>;
  };
}

const manifest = JSON.parse(readFileSync(join(EXTENSION, 'package.json'), 'utf8')) as Manifest;
const rowMenus = manifest.contributes.menus['view/item/context'] ?? [];

/** The commands a row with this context value offers, and where they sit. */
function offeredOn(contextValue: string): readonly MenuEntry[] {
  return rowMenus.filter((entry) => entry.when.includes(`viewItem == ${contextValue}`));
}

/** The commands offered ON the row itself, without opening a menu. */
function inlineOn(contextValue: string): readonly string[] {
  return offeredOn(contextValue)
    .filter((entry) => (entry.group ?? '').startsWith('inline'))
    .map((entry) => entry.command);
}

describe('what a row offers the person who is looking at it', () => {
  it('lets a record nobody is answering for be thrown away from the row itself', () => {
    // The fix the owner chose for the M3.14 observation. `Delete Record` was
    // reachable before this -- in the right-button menu -- and the acceptance
    // run is the evidence that reachable is not the same as found: the row's
    // one button said `Adopt`, so the answer to "how do I get rid of this" was
    // "take it, and then close it".
    //
    // The command behind the button is unchanged and stays modal: it names what
    // survives, says whose window the record was, and moves the directory to
    // `trash/<stamp>/` rather than deleting it. A button that took something
    // away in one click would be the wrong end of §I.3.
    expect(inlineOn(CONTEXT_ADOPTABLE)).toContain('gripterm.deleteTerminal');
    expect(inlineOn(CONTEXT_ABANDONED)).toContain('gripterm.deleteTerminal');
  });

  it('keeps adoption first on a row that offers both', () => {
    // Order is the manifest's `group` suffix and nothing else, so it is stated
    // rather than left to the order of the lines. Taking a record is the
    // ordinary act and throwing it away is the last resort; a trash can to the
    // left of the way out would be a misreading waiting to happen.
    expect(inlineOn(CONTEXT_ADOPTABLE)).toStrictEqual([
      'gripterm.adoptTerminal',
      'gripterm.deleteTerminal',
    ]);
  });

  it('gives every row of ours something to do, and says which one deliberately has nothing', () => {
    // `CONTEXT_FOREIGN` is the one value that offers nothing, and it is not an
    // omission: the terminal is alive in a window this one cannot reach, so
    // every command would either do nothing or write into a record this window
    // is forbidden to write (§4.8). Listing it here is what makes a SIXTH value
    // added later fail this test instead of quietly drawing a dead row.
    const silent = [CONTEXT_FOREIGN];
    const acting = [CONTEXT_LIVE, CONTEXT_OVER, CONTEXT_ADOPTABLE, CONTEXT_ABANDONED];

    expect(acting.filter((value) => offeredOn(value).length === 0)).toStrictEqual([]);
    expect(silent.filter((value) => offeredOn(value).length > 0)).toStrictEqual([]);
  });

  it('offers only commands that exist, and gives every button on a row an icon', () => {
    // An inline entry without an icon is a button a person cannot see, which is
    // the same defect as no button at all.
    const declared = new Map(manifest.contributes.commands.map((one) => [one.command, one.icon]));
    const missing = rowMenus.filter((entry) => !declared.has(entry.command)).map((one) => one.command);
    const iconless = rowMenus
      .filter((entry) => (entry.group ?? '').startsWith('inline') && declared.get(entry.command) === undefined)
      .map((one) => one.command);

    expect(missing).toStrictEqual([]);
    expect(iconless).toStrictEqual([]);
  });
});
