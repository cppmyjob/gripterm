import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * How the maximise button reaches the title bar of a terminal's own editor, in
 * an editor that will not draw an extension's command there.
 *
 * **The mechanism, read out of the fork's own workbench on 2026-08-26** --
 * `%LOCALAPPDATA%\Programs\cursor\resources\app\out\vs\workbench\workbench.glass.main.js`
 * @~3 614 300, in the class that decides which title-bar actions are hidden:
 *
 *     isEditorTitle(t){ return t.id === MenuId.EditorTitle.id }
 *     _matchesEditorTitleBuiltInCommandPrefix(t){
 *       return _editorTitleBuiltInCommandPrefixes.some(e => t.startsWith(e)) }
 *     _isExtensionContributedEditorTitleCommand(t){
 *       return MenuRegistry.getCommand(t)?.source ? true
 *            : MenuRegistry.getMenuItems(MenuId.EditorTitle)
 *                .some(e => isIMenuItem(e) && e.command.id === t && !!e.command.source) }
 *     _isEditorTitleCommandVisibleByDefault(t){
 *       return this._isExtensionContributedEditorTitleCommand(t)
 *            ? this._matchesEditorTitleBuiltInCommandPrefix(t) : true }
 *     isHidden(t,e){ if(this.isEditorTitle(t)) return
 *       pinned.includes(e) ? false : hidden.includes(e) ? true
 *       : shown.includes(e) ? false : !this._isEditorTitleCommandVisibleByDefault(e) ... }
 *
 *     _editorTitleBuiltInCommandPrefixes = ["workbench.","_workbench.","editor.",
 *       "settings.","debug.","terminal.","git.","merge-conflict.","markdown.","composer."]
 *
 * In words: in `editor/title`, and in no other menu, a command an EXTENSION
 * contributed is hidden by default unless its id begins with one of ten
 * prefixes of the editor's own. Ours does not, and no honest id of ours can.
 * The branch is in both of the fork's workbenches and has nought occurrences in
 * VS Code 1.134.0, so `--classic` does not lift it either.
 *
 * **The way through, and it is not a trick on that rule but the shape the rule
 * is written about.** The hide is keyed per menu item: for a SUBMENU it is
 * keyed on the submenu's own id (`createMenuHide`: `isISubmenuItem(e) ?
 * e.submenu.id : e.id`), which is neither a command in the registry nor a
 * command item of `editor/title` -- so `_isExtensionContributedEditorTitleCommand`
 * answers no for it and it is visible. Its CHILDREN are built by a menu of the
 * submenu's own id, so their hide state is decided by the ordinary rule and not
 * by the branch above. And the editor then folds a one-item submenu in the
 * `navigation` group back into that one item -- `createEditorActions`:
 * `(action, group) => group === 'navigation' && action.actions.length <= 1` --
 * so what a person sees and clicks is one icon and one click, which is what the
 * customer asked for.
 *
 * MEASURED, both ways, by `pnpm run gate:eyes` on 2026-08-26 with a terminal in
 * front and its group 1006 px wide: three probe actions contributed straight
 * into `editor/title` -- one of them with no `when` at all -- drew in VS Code
 * 1.134.0 at 22x22 each and NONE of them in Cursor 3.17.19; a fourth, inlined
 * out of a submenu, drew in BOTH at 22x22.
 *
 * WHAT WOULD MAKE THIS FILE WRONG: the fork dropping the branch (then the
 * direct entry would work again, and this shape still would), or the fork
 * folding submenus into the same rule (then nothing in our manifest can reach
 * that bar, and the answer becomes `cursor.general.pinnedTitleActions`, the
 * fork's own setting for pinning an action id there by hand).
 */

const EXTENSION = join(__dirname, '..', '..', 'packages', 'extension');

interface MenuEntry {
  readonly command?: string;
  readonly submenu?: string;
  readonly when?: string;
  readonly group?: string;
}

interface Manifest {
  readonly contributes: {
    readonly commands: readonly { readonly command: string }[];
    readonly submenus?: readonly { readonly id: string, readonly label: string }[];
    readonly menus: Readonly<Record<string, readonly MenuEntry[]>>;
  };
}

const manifest = JSON.parse(readFileSync(join(EXTENSION, 'package.json'), 'utf8')) as Manifest;
const MAXIMISE = 'gripterm.maximizeTerminals';
const editorTitle = manifest.contributes.menus['editor/title'] ?? [];
const submenus = manifest.contributes.submenus ?? [];

describe('the maximise button, in an editor that hides an extension`s commands from editor/title', () => {
  it('does not offer the command straight to editor/title, where the fork hides it', () => {
    // The shape this replaces. It is not merely useless in Cursor -- it would
    // draw a SECOND, identical button in VS Code, where the submenu is inlined
    // to exactly the same icon.
    expect(editorTitle.filter((entry) => entry.command === MAXIMISE)).toStrictEqual([]);
  });

  it('reaches that bar through a submenu, which the fork does not hide', () => {
    const throughASubmenu = editorTitle.filter((entry) => entry.submenu !== undefined);
    expect(throughASubmenu).toHaveLength(1);
    const entry = throughASubmenu[0] ?? {};
    expect(submenus.map((one) => one.id)).toContain(entry.submenu);
    // Only the `navigation` group is folded back into its one item. In any
    // other group the person would get a dropdown to open before they could
    // press anything -- two clicks where the customer asked for one.
    expect((entry.group ?? '').startsWith('navigation')).toBe(true);
    // The condition the button has always hung on stays where it was: the
    // submenu carries it, so the whole thing goes when no terminal is in front.
    expect(entry.when).toBe('gripterm.terminalInFront');
  });

  it('keeps that submenu at exactly one item, which is what makes it one click', () => {
    const inside = manifest.contributes.menus[submenus[0]?.id ?? ''] ?? [];
    // `action.actions.length <= 1` is the whole of the editor's rule. A second
    // item here does not add a second button: it stops the fold and turns the
    // one the customer asked for into a menu to open.
    expect(inside.map((one) => one.command)).toStrictEqual([MAXIMISE]);
    expect(manifest.contributes.commands.map((one) => one.command)).toContain(MAXIMISE);
  });
});
