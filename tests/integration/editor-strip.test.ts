import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GriptermApi } from '../../packages/extension/src/extension';

type Spec = Parameters<GriptermApi['gateway']['create']>[0];

/** The gateway keys on `.value` alone; the brand exists to stop this happening anywhere but a test. */
const TERMINAL_ID = { value: '550e8400-e29b-41d4-a716-446655440000' } as unknown as Spec['terminalId'];

/** The shape `vscode.getEditorLayout` answers with. Read here, never written here. */
interface LayoutNode {
  readonly size?: number;
  readonly groups?: readonly LayoutNode[];
}

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

async function waitFor(what: string, ready: () => boolean, ms = 8000): Promise<void> {
  const until = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > until) {
      throw new Error(`gave up waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The column of the group holding a tab with that label, or `undefined`. */
function columnOf(label: string): vscode.ViewColumn | undefined {
  return vscode.window.tabGroups.all.find((group) =>
    group.tabs.some((tab) => tab.label.includes(label))
  )?.viewColumn;
}

function groupAt(column: vscode.ViewColumn): vscode.TabGroup | undefined {
  return vscode.window.tabGroups.all.find((group) => group.viewColumn === column);
}

/** A tab this build made: a terminal, named the way this suite names them. */
function isOurTerminal(tab: vscode.Tab): boolean {
  return tab.input instanceof vscode.TabInputTerminal && tab.label.startsWith('gripterm-m224-');
}

/**
 * Every group and what is in it, for an assertion message.
 *
 * Written because the failure this replaces said `3 !== 2` and left the reader
 * to guess which third group -- and a live run is exactly where guessing is
 * most expensive.
 */
function describeGroups(): string {
  return vscode.window.tabGroups.all
    .map((group) => `[${String(group.viewColumn)}] ${group.tabs.map((tab) => tab.label).join(', ')}`)
    .join(' | ');
}

/**
 * The group at `index`: how many pixels it has, and how many its siblings share
 * between them. Walking the editor's own answer, and deliberately NOT
 * `withGroupShare` read backwards -- a test that checks an implementation with
 * the same implementation checks nothing.
 *
 * The two numbers are handed back separately because a maximised group makes
 * their ratio meaningless: measured 2026-08-21 in this host, maximising turns
 * `[{size:495},{size:248}]` into `[{size:495},{size:743}]` -- our group is given
 * the WHOLE editor area (743 = 495 + 248) while the group it covers keeps the
 * number it had. So "it takes everything" is `size === the span it had before`,
 * and a share would say 0.6 about a group that fills the window.
 */
function sizeAndSpanOf(
  layout: { readonly groups: readonly LayoutNode[] },
  index: number
): { readonly size: number, readonly span: number } | null {
  let seen = 0;
  const walk = (siblings: readonly LayoutNode[]): { size: number, span: number } | null => {
    for (const node of siblings) {
      if (node.groups === undefined) {
        if (seen === index) {
          return {
            size: node.size ?? 0,
            span: siblings.reduce((sum, one) => sum + (one.size ?? 0), 0),
          };
        }
        seen += 1;
      } else {
        const found = walk(node.groups);
        if (found !== null) {
          return found;
        }
      }
    }
    return null;
  };
  return walk(layout.groups);
}

/** How much of what it shares the group at `index` takes, or `null`. */
function shareOf(layout: { readonly groups: readonly LayoutNode[] }, index: number): number | null {
  const measured = sizeAndSpanOf(layout, index);
  return measured === null || measured.span === 0 ? null : measured.size / measured.span;
}

async function layoutNow(): Promise<{
  readonly orientation: number;
  readonly groups: readonly LayoutNode[];
}> {
  return await vscode.commands.executeCommand<{
    readonly orientation: number;
    readonly groups: readonly LayoutNode[];
  }>('vscode.getEditorLayout');
}

/**
 * M2.24. The owner asked for the agents to open "in a separate panel of their
 * own, at the bottom, the way ordinary terminals do". An extension cannot have
 * a panel -- `TerminalLocation` offers the editor's one panel and the editor
 * area, and nothing else -- so what is built instead is a GROUP of the editor
 * area, below the editors and locked, which is the same picture made of the
 * parts the platform hands out.
 *
 * Everything asserted here was measured first, in this host, on 2026-08-13:
 * `newGroupBelow` nests under the active column rather than restacking the
 * window; a locked group turns away an editor opened with no target and still
 * takes ours when we name its column; and the group goes on its own when its
 * last terminal does.
 */
suite('the strip of our own', () => {
  test('M2.24: keeps a group below the editors that holds our terminals and nothing else', async () => {
    const { gateway, readiness } = await api();
    assert.equal(readiness.location, 'group', 'this build no longer opens terminals in a strip of their own');

    /*
     * The editor locks a group holding a terminal editor BY ITSELF: measured
     * 2026-08-13, `workbench.editor.autoLockGroups` has `terminalEditor: true`
     * in its default, and a document opened with the strip focused landed among
     * the editors with nothing of ours locking anything.
     *
     * So it is turned off here, and that is the point of the test rather than
     * setup for it. With it on, the assertion about the lock passes on a build
     * that locks nothing -- the mutation bench proved exactly that -- and the
     * promise "ours and nothing else" would rest on a setting the person is
     * free to turn off. Turned off, what holds the strip is our own lock.
     */
    const settings = vscode.workspace.getConfiguration('workbench.editor');
    const autoLock = settings.inspect<Record<string, boolean>>('autoLockGroups');
    await settings.update(
      'autoLockGroups',
      { ...autoLock?.defaultValue, ...autoLock?.globalValue, terminalEditor: false },
      vscode.ConfigurationTarget.Global
    );

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const file = await vscode.workspace.openTextDocument({
      content: 'a file the person is working on',
      language: 'plaintext',
    });
    const editors = (await vscode.window.showTextDocument(file, { viewColumn: vscode.ViewColumn.One }))
      .viewColumn;

    const one = await gateway.create({
      terminalId: TERMINAL_ID,
      name: 'gripterm-m224-one',
      cwd: os.tmpdir(),
      env: {},
      shellPath: null,
      shellArgs: [],
    });

    try {
      await waitFor('the first terminal to get a tab', () => columnOf('gripterm-m224-one') !== undefined);
      const strip = columnOf('gripterm-m224-one');
      assert.ok(strip !== undefined);
      assert.notEqual(strip, editors, 'our terminal opened among the editors');

      // A strip is a strip because of what is NOT in it.
      const held = groupAt(strip);
      assert.ok(held);
      assert.ok(
        held.tabs.every((tab) => tab.input instanceof vscode.TabInputTerminal),
        'something that is not a terminal is in our group'
      );

      // About a third of what it shares its space with. Not exact: the editor
      // answers in pixels and rounds, and a person is free to drag it.
      const share = shareOf(await layoutNow(), strip - 1);
      assert.ok(share !== null, 'the editor reports no size for our group');
      assert.ok(share > 0.28 && share < 0.4, `our group takes ${String(share)} of its parent`);

      /*
       * The lock, established the only way it can be: by what the editor does.
       * There is no API that reports a group as locked.
       *
       * The strip has to be the ACTIVE group first, and that is the whole
       * assertion rather than a detail of it. Without this the document lands
       * among the editors because that is where the focus was -- which is what
       * happens with no lock at all, so the test would pass on a build that had
       * dropped it. The mutation bench found exactly that on 2026-08-13.
       */
      one.show(false);
      await waitFor(
        'the strip to become the active group',
        () => vscode.window.tabGroups.activeTabGroup.viewColumn === strip
      );
      const second = await vscode.workspace.openTextDocument({
        content: 'another file, opened with no target at all',
        language: 'plaintext',
      });
      const landed = (await vscode.window.showTextDocument(second)).viewColumn;
      assert.notEqual(landed, strip, 'a file opened into our group, so the lock is not holding');

      // The second terminal joins the first. A strip per terminal would be the
      // same defect wearing the opposite face.
      const two = await gateway.create({
        terminalId: { value: '550e8400-e29b-41d4-a716-446655440001' } as unknown as Spec['terminalId'],
        name: 'gripterm-m224-two',
        cwd: os.tmpdir(),
        env: {},
        shellPath: null,
        shellArgs: [],
      });
      try {
        await waitFor('the second terminal to get a tab', () => columnOf('gripterm-m224-two') !== undefined);
        /*
         * Both in ONE group, asked as "the same group as the first" and not as
         * "the column the first one had". The editor renumbers its columns
         * whenever a group is added before them, so a build that opened a
         * second strip could still answer the remembered number -- which is how
         * this assertion first passed on a build that did open one.
         */
        assert.equal(
          columnOf('gripterm-m224-two'),
          columnOf('gripterm-m224-one'),
          'our two terminals are in different groups'
        );
        /*
         * "AND NOTHING ELSE", asked of OUR group rather than of the window.
         *
         * This was `tabGroups.all.length === 2` until 2026-08-21, when it failed
         * a live run with `3 !== 2` and nothing to say about what the third
         * group was. It was the editor's own doing: the document opened a few
         * lines above must land outside a LOCKED active group, and where the
         * editor puts it -- back among the editors, or in a new group beside
         * them -- is the editor's routing decision and not a promise of ours.
         * The count made every other suite's leftovers part of this assertion
         * too.
         *
         * What the title claims is asserted instead, and it is the stronger
         * claim: our group holds our two terminals and nothing besides. A second
         * strip is caught by the assertion above -- both terminals in one column
         * -- and by the one below, which is about every OTHER group.
         */
        const stripNow = groupAt(strip);
        assert.ok(stripNow, 'our group is gone');
        assert.deepEqual(
          stripNow.tabs.map((tab) => tab.label).sort(),
          ['gripterm-m224-one', 'gripterm-m224-two'],
          `our group holds something else: ${describeGroups()}`
        );
        assert.deepEqual(
          vscode.window.tabGroups.all
            .filter((group) => group.viewColumn !== strip && group.tabs.some(isOurTerminal))
            .map((group) => group.viewColumn),
          [],
          `a terminal of ours is outside our group: ${describeGroups()}`
        );
      } finally {
        two.dispose();
      }
    } finally {
      one.dispose();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await settings.update(
        'autoLockGroups',
        autoLock?.globalValue,
        vscode.ConfigurationTarget.Global
      );
    }
  });

  /*
   * The customer's first complaint, 2026-08-21: "терминалы открываются в
   * отдельной панели. Однако если перезапустить приложение они откроются в новой
   * панели а старая панель останется пустой".
   *
   * Measured in a real editor the same day, two sittings on one user data
   * directory: the second window came back holding `[1] (empty) | [2] (empty)`
   * -- the editor restores the grid with our strip in it, and the terminals are
   * not restored because their processes are gone -- and the restore then made a
   * THIRD group. Every restart added one.
   *
   * A restart cannot be had inside a test host: measured the same day, this host
   * starts with a single empty group whatever the run before it left. What CAN
   * be had is the shape the restart produces -- an empty group at the end of the
   * area that we did not make -- and that is what the rule is written against.
   *
   * Three groups rather than two, deliberately: with the empty group second, a
   * strip remembered from an earlier test in this same window would answer the
   * same column and the test would pass without the rule existing.
   */
  test('takes an empty group at the end of the area instead of making another one', async () => {
    const { gateway } = await api();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    for (const column of [vscode.ViewColumn.One, vscode.ViewColumn.Two]) {
      const file = await vscode.workspace.openTextDocument({
        content: `a file of the person's, in column ${String(column)}`,
        language: 'plaintext',
      });
      await vscode.window.showTextDocument(file, { viewColumn: column });
    }
    // The shape a restart leaves: a group at the end with nothing in it.
    await vscode.commands.executeCommand('workbench.action.newGroupBelow');
    const restored = vscode.window.tabGroups.activeTabGroup.viewColumn;
    assert.equal(vscode.window.tabGroups.all.length, 3, `the stand is not three groups: ${describeGroups()}`);
    const before = sizeAndSpanOf(await layoutNow(), restored - 1);
    assert.ok(before !== null);

    const handle = await gateway.create({
      terminalId: TERMINAL_ID,
      name: 'gripterm-m224-adopted',
      cwd: os.tmpdir(),
      env: {},
      shellPath: null,
      shellArgs: [],
    });
    try {
      await waitFor('the terminal to get a tab', () => columnOf('gripterm-m224-adopted') !== undefined);

      assert.equal(
        columnOf('gripterm-m224-adopted'),
        restored,
        `the terminal did not go into the empty group: ${describeGroups()}`
      );
      assert.equal(
        vscode.window.tabGroups.all.length,
        3,
        `a group was made although one was standing empty: ${describeGroups()}`
      );

      // And the person's height is left alone: a third would undo the drag they
      // made in the sitting before this one.
      const after = sizeAndSpanOf(await layoutNow(), restored - 1);
      assert.ok(after !== null);
      assert.equal(after.size, before.size, 'the adopted group was resized');
    } finally {
      handle.dispose();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });

  /*
   * The other half of the customer's sixth complaint, 2026-08-21: "панель с
   * терминалами открывается на весь экран... если открыть файл то слева
   * окажется окно терминала на всю высоту а справа файл. Неудобно и непонятно
   * как выйти из этой ситуации."
   *
   * Measured the same day. When the person closes their last file the editor
   * takes the empty group away, our strip is left holding the whole editor
   * area, and it is LOCKED -- so the next file cannot go into it and the editor
   * makes a group beside it instead, turning the area horizontal:
   *
   *   strip alone     [1*] terminal              orientation 1, [743]
   *   file landed in  2
   *   after the file  [1] terminal | [2*] file   orientation 0, [426, 426]
   *
   * The owner chose the cure on 2026-08-21: keep a group above, so that a file
   * has somewhere to land. This asserts the whole scenario -- the strip left
   * alone, the group that appears, and the file going where a person expects.
   */
  test('never stays the only group, so a file has somewhere to land', async () => {
    const { gateway } = await api();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    /*
     * A file on disk and not an untitled one: closing an untitled document
     * asks whether to save it, and a dialog is the one thing a suite cannot
     * answer. The first build of this test used an untitled document, the close
     * was refused, and the editor merged the file into our group instead --
     * which the failure message printed in full.
     */
    const folder = await mkdtemp(join(os.tmpdir(), 'gripterm-strip-'));
    const path = join(folder, 'the-last-file.txt');
    await writeFile(path, 'the last file the person had open', 'utf8');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(path), {
      viewColumn: vscode.ViewColumn.One,
    });

    const handle = await gateway.create({
      terminalId: TERMINAL_ID,
      name: 'gripterm-m224-alone',
      cwd: os.tmpdir(),
      env: {},
      shellPath: null,
      shellArgs: [],
    });
    try {
      await waitFor('the terminal to get a tab', () => columnOf('gripterm-m224-alone') !== undefined);

      // The person closes their last file, and the editor takes the emptied
      // group away by itself (`workbench.editor.closeEmptyGroups`, on by
      // default). That is the whole of how the strip is left alone.
      await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

      const until = Date.now() + 10000;
      while (vscode.window.tabGroups.all.length !== 2 && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(
        vscode.window.tabGroups.all.length,
        2,
        `no group appeared above the strip: ${describeGroups()}`
      );
      const strip = columnOf('gripterm-m224-alone');
      assert.ok(strip !== undefined, `the terminal lost its group: ${describeGroups()}`);
      const above = vscode.window.tabGroups.all.find((group) => group.viewColumn !== strip);
      assert.ok(above, `there is no group but ours: ${describeGroups()}`);
      assert.deepEqual(above.tabs, [], `the group made above is not empty: ${describeGroups()}`);
      assert.ok(above.viewColumn < strip, `the group was made below the terminals: ${describeGroups()}`);

      // And the file goes where a person expects: above, not beside.
      const second = await vscode.workspace.openTextDocument({
        content: 'the file opened after the terminals were left alone',
        language: 'plaintext',
      });
      const landed = (await vscode.window.showTextDocument(second)).viewColumn;

      assert.equal(landed, above.viewColumn, `the file landed beside the terminals: ${describeGroups()}`);
      assert.equal(
        (await layoutNow()).orientation,
        1,
        'the editor area went sideways, which is the shape the customer could not get out of'
      );
    } finally {
      handle.dispose();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await rm(folder, { recursive: true, force: true });
    }
  });

  /*
   * The button the customer asked for on 2026-08-21: a chevron that throws the
   * terminals over the whole editor area and puts them back at the second
   * click, the way Cursor's terminal panel does it.
   *
   * What only a live host can answer, and the reason this is not a unit test:
   * `workbench.action.toggleMaximizeEditorGroup` is a command id read out of a
   * bundle, not an API. Whether it is there, whether it acts on the group we
   * mean, and whether a second call is really the way back are three facts
   * about this editor and about nothing else.
   *
   * What is NOT asserted here, because nothing in the API can see it: that the
   * chevron is drawn on the title bar of our group and nowhere else. The `when`
   * clause is the editor's to evaluate, and a menu's visibility is not
   * readable. That one is an eye check, and it is written down as one.
   */
  test('throws the terminals over the whole editor area, and puts them back', async () => {
    const { gateway } = await api();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes('gripterm.maximizeTerminals'),
      'gripterm.maximizeTerminals is not registered with the workbench'
    );
    assert.ok(
      !commands.includes('gripterm.restoreTerminals'),
      'the second command is still there, and an icon that cannot follow the state lied about it'
    );

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const file = await vscode.workspace.openTextDocument({
      content: 'the file the terminals are supposed to cover',
      language: 'plaintext',
    });
    await vscode.window.showTextDocument(file, { viewColumn: vscode.ViewColumn.One });

    const handle = await gateway.create({
      terminalId: TERMINAL_ID,
      name: 'gripterm-m224-big',
      cwd: os.tmpdir(),
      env: {},
      shellPath: null,
      shellArgs: [],
    });
    let maximised = false;
    try {
      await waitFor('the terminal to get a tab', () => columnOf('gripterm-m224-big') !== undefined);
      const strip = columnOf('gripterm-m224-big');
      assert.ok(strip !== undefined);
      // The toggle names no target and takes the ACTIVE group, so the group is
      // made active first -- which is what clicking its title bar does.
      handle.show(false);
      await waitFor(
        'the strip to become the active group',
        () => vscode.window.tabGroups.activeTabGroup.viewColumn === strip
      );

      const before = sizeAndSpanOf(await layoutNow(), strip - 1);
      assert.ok(before !== null, 'the editor reports no size for our group');
      assert.ok(before.size < before.span, 'our group already fills the editor area');

      await vscode.commands.executeCommand('gripterm.maximizeTerminals');
      maximised = true;
      const during = sizeAndSpanOf(await layoutNow(), strip - 1);

      assert.ok(during !== null);
      assert.equal(
        during.size,
        before.span,
        `maximised, our group has ${String(during.size)} px of the ${String(before.span)} px the editor area is`
      );

      // The same command again: it is a toggle, which is what the customer
      // asked for and the only thing that cannot be wrong about the state.
      await vscode.commands.executeCommand('gripterm.maximizeTerminals');
      maximised = false;
      const after = sizeAndSpanOf(await layoutNow(), strip - 1);

      assert.ok(after !== null);
      assert.equal(
        after.size,
        before.size,
        `put back, our group has ${String(after.size)} px where it had ${String(before.size)} px`
      );
    } finally {
      // A window left maximised is a window every suite after this one runs in.
      if (maximised) {
        await vscode.commands.executeCommand('gripterm.maximizeTerminals');
      }
      handle.dispose();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });

  test('M2.24: lets the strip go when its last terminal goes', async () => {
    const { gateway } = await api();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const file = await vscode.workspace.openTextDocument({ content: 'kept open', language: 'plaintext' });
    await vscode.window.showTextDocument(file, { viewColumn: vscode.ViewColumn.One });

    const handle = await gateway.create({
      terminalId: TERMINAL_ID,
      name: 'gripterm-m224-last',
      cwd: os.tmpdir(),
      env: {},
      shellPath: null,
      shellArgs: [],
    });
    await waitFor('the terminal to get a tab', () => columnOf('gripterm-m224-last') !== undefined);
    assert.equal(vscode.window.tabGroups.all.length, 2, 'the strip did not appear beside the editors');

    handle.dispose();

    // The editor closes a group that has nothing left in it, which is what makes
    // "opened at the first terminal" the whole of the rule -- there is no
    // second rule that has to remember to take it away.
    await waitFor(
      'the strip to go with the terminal',
      () => vscode.window.tabGroups.all.length === 1,
      10000
    );
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });
});
