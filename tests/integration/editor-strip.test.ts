import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
 * What this window has appended to its log in the store since a mark.
 *
 * Reading the FILE and not a double, deliberately. The whole of Ш3 is that the
 * evidence a person can send is the store, so a suite that read a recorder
 * inside the process would be checking something nobody can ever be given.
 *
 * The mark is a byte offset rather than a line count, because the log is
 * appended to by this same window all the while -- a heartbeat, a watcher, a
 * reconciliation -- and a test that read the whole file would pass on a line
 * some other part of the build wrote an hour ago.
 */
async function markInTheLog(): Promise<number> {
  const { readiness } = await api();
  assert.ok(
    readiness.logFile !== null,
    'this window is writing no log into the store, so nothing here can be diagnosed from one'
  );
  return (await readFile(readiness.logFile, 'utf8')).length;
}

async function saidSince(mark: number): Promise<string> {
  const { readiness } = await api();
  assert.ok(readiness.logFile !== null, 'this window is writing no log into the store');
  return (await readFile(readiness.logFile, 'utf8')).slice(mark);
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

/**
 * How the family holding the group at `index` is laid out: 0 for columns side
 * by side, 1 for rows stacked. `null` when there is no such leaf.
 *
 * Its own walk, and a DIFFERENT question from the one the product asks: the
 * core answers "is the LAST leaf a row at the bottom", this answers "is the
 * family holding THIS leaf rows at all". Nested levels alternate, which is the
 * editor's rule for this shape and is measured in `editor-layout.test.ts`.
 */
function familyOrientationOf(
  layout: { readonly orientation: number, readonly groups: readonly LayoutNode[] },
  index: number
): number | null {
  let seen = 0;
  const walk = (siblings: readonly LayoutNode[], orientation: number): number | null => {
    for (const node of siblings) {
      if (node.groups === undefined) {
        if (seen === index) {
          return orientation;
        }
        seen += 1;
      } else {
        const found = walk(node.groups, orientation === 1 ? 0 : 1);
        if (found !== null) {
          return found;
        }
      }
    }
    return null;
  };
  return walk(layout.groups, layout.orientation);
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
   * Point 2 of the stand, 2026-08-25: "sitting 3 settled with terminals in
   * columns 2 and 3".
   *
   * The strip is remembered as a `ViewColumn`, and a `ViewColumn` is a POSITION
   * -- closing a group in front of ours moves ours and nothing tells us. When
   * the move takes our number past the end of the list, the number names no
   * group at all, and "no group at my number" was read as "the strip is not
   * ours any more": the next terminal found nothing remembered and split a
   * second strip.
   *
   * Measured in Cursor the same day, sitting 3 of the stand run at 13:17: our
   * group was made at column 4 with three groups beside it (`a group of our own
   * was opened below the editors {"column":4}`); 230 ms later the recording
   * holds three groups in all, with our terminal listed at column 2 -- and the
   * log's next line is a SECOND `a group of our own was opened below the
   * editors`. What put the numbering out there is Cursor's own "New Agent"
   * editor, which lives in an editor part of its own; what is asserted here is
   * the move itself, made by a person closing a group, because that needs no
   * fork and no agent pane and is the same defect.
   */
  test('finds the strip again when the group it made is renumbered past the end of the list', async () => {
    const { gateway } = await api();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    // Two columns of the person's, so the strip is made as a third group and
    // its number has somewhere to fall from.
    for (const column of [vscode.ViewColumn.One, vscode.ViewColumn.Two]) {
      const file = await vscode.workspace.openTextDocument({
        content: `a file of the person's, in column ${String(column)}`,
        language: 'plaintext',
      });
      await vscode.window.showTextDocument(file, { viewColumn: column });
    }

    const one = await gateway.create({
      terminalId: { value: '550e8400-e29b-41d4-a716-4466554400a0' } as unknown as Spec['terminalId'],
      name: 'gripterm-renumbered-one',
      cwd: os.tmpdir(),
      env: {},
      shellPath: null,
      shellArgs: [],
    });
    try {
      await waitFor('the first terminal to get a tab', () => columnOf('gripterm-renumbered-one') !== undefined);
      const made = columnOf('gripterm-renumbered-one');
      assert.ok(made !== undefined);
      assert.equal(
        vscode.window.tabGroups.all.length,
        3,
        `the strip was not made as a third group: ${describeGroups()}`
      );

      /*
       * The person closes the group at the front. Every column after it loses
       * one, so the number the strip was made with now names nothing -- which
       * is the state, and the only state, this test is about.
       */
      const first = groupAt(vscode.ViewColumn.One);
      assert.ok(first, 'there is no first group to close');
      await vscode.window.tabGroups.close(first, true);
      await waitFor('the group in front of the strip to go', () => vscode.window.tabGroups.all.length === 2);
      const moved = columnOf('gripterm-renumbered-one');
      assert.equal(moved, vscode.ViewColumn.Two, `the strip did not move: ${describeGroups()}`);
      // `- 1` rather than the plain comparison, because a `ViewColumn` counts
      // from one and a length from zero: subtracting keeps both of them
      // numbers, where comparing an enum to a count is a comparison the linter
      // is right to refuse.
      assert.ok(
        made - 1 >= vscode.window.tabGroups.all.length,
        `the remembered number still names a group: ${describeGroups()}`
      );

      const two = await gateway.create({
        terminalId: { value: '550e8400-e29b-41d4-a716-4466554400a1' } as unknown as Spec['terminalId'],
        name: 'gripterm-renumbered-two',
        cwd: os.tmpdir(),
        env: {},
        shellPath: null,
        shellArgs: [],
      });
      try {
        await waitFor('the second terminal to get a tab', () => columnOf('gripterm-renumbered-two') !== undefined);
        // The same GROUP as the first, asked by where the first one is now:
        // the number it was made with is the thing under test and cannot be
        // the thing asserted.
        assert.equal(
          columnOf('gripterm-renumbered-two'),
          columnOf('gripterm-renumbered-one'),
          `a second strip was made instead of the one that was there: ${describeGroups()}`
        );
      } finally {
        two.dispose();
      }
    } finally {
      one.dispose();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
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

    /*
     * The person is NOT in the empty group, and that is the customer's window
     * rather than a detail of the stand. `newGroupBelow` above leaves the
     * editor on the group it made, and with the focus there the rule that stood
     * here until 2026-08-22 -- lock it only if it is already active -- locked
     * it by luck. Their log says what happens otherwise, four windows over five
     * hours: `{"column":2,"locked":false}`.
     */
    await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
    await waitFor(
      `the editor to be on the person's own group: ${describeGroups()}`,
      () => vscode.window.tabGroups.activeTabGroup.viewColumn === vscode.ViewColumn.One
    );

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

      /*
       * And the adopted group is OURS, which is the half this test did not
       * hold until 2026-08-22. The customer's log, four windows over five
       * hours:
       *
       *   the terminals went into the empty group at the end of the editor
       *   area {"column":2,"locked":false}
       *
       * An unlocked strip takes the person's next file. They open a terminal,
       * the strip becomes the active group, they click a file in the explorer,
       * and it lands beside the terminal as a tab -- "он делит область с
       * файлами... справа от терминала появляется файл".
       *
       * The lock is asserted the way a person meets it: the strip is made the
       * active group, a document is opened with NO target, and it must land
       * somewhere else. `autoLockGroups.terminalEditor` is off in this window
       * (the first test of this suite turns it off and leaves it off), so what
       * turns the document away is our lock and nothing else.
       */
      await vscode.commands.executeCommand(`workbench.action.focus${['First', 'Second', 'Third'][restored - 1] ?? 'First'}EditorGroup`);
      await waitFor(
        `the strip to be the active group: ${describeGroups()}`,
        () => vscode.window.tabGroups.activeTabGroup.viewColumn === restored
      );
      const wanderer = await vscode.workspace.openTextDocument({
        content: 'a file opened with no target while the strip is in front',
        language: 'plaintext',
      });
      const landed = (await vscode.window.showTextDocument(wanderer)).viewColumn;
      assert.notEqual(
        landed,
        restored,
        `a file landed in the strip, so the group we adopted was never locked: ${describeGroups()}`
      );
    } finally {
      handle.dispose();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });

  /*
   * The customer's screenshot, 2026-08-22, after three rounds of me reading
   * their words as something else: the editor area in TWO COLUMNS, their
   * terminal full height on the left, `design.md` on the right, and in the
   * Output panel beside it `the terminals went into the empty group at the end
   * of the editor area {"column":2}`.
   *
   * "The end of the area" was one question where it is two. A strip is made
   * below the editors, so in a window laid out in rows it IS the last leaf --
   * but in a window laid out in columns the last leaf is the right-hand column,
   * and taking it is the sixth complaint in its original words: "слева окажется
   * окно терминала на всю высоту, а справа файл". It also feeds itself, which
   * is why they could not get out of it: the editor restores the grid it was
   * left with, so a column taken once comes back and is taken again.
   */
  test('refuses an empty group BESIDE the editors, which is not a strip', async () => {
    const { gateway } = await api();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    const file = await vscode.workspace.openTextDocument({
      content: 'a file of the person, in the column they work in',
      language: 'plaintext',
    });
    await vscode.window.showTextDocument(file, { viewColumn: vscode.ViewColumn.One });
    // The shape the customer's window came back in: a column at the end with
    // nothing in it. `newGroupRight` and not `newGroupBelow` is the whole test.
    await vscode.commands.executeCommand('workbench.action.newGroupRight');
    assert.equal(vscode.window.tabGroups.all.length, 2, `the stand is not two columns: ${describeGroups()}`);
    const stand = await layoutNow();
    assert.equal(stand.orientation, 0, `the stand did not come out as columns: ${JSON.stringify(stand)}`);

    const handle = await gateway.create({
      terminalId: TERMINAL_ID,
      name: 'gripterm-m224-beside',
      cwd: os.tmpdir(),
      env: {},
      shellPath: null,
      shellArgs: [],
    });
    try {
      await waitFor('the terminal to get a tab', () => columnOf('gripterm-m224-beside') !== undefined);
      const strip = columnOf('gripterm-m224-beside');
      assert.ok(strip !== undefined);

      /*
       * Asked of the LAYOUT and not of the column numbers, because splitting
       * renumbers them: the empty column the stand made was column two, and
       * after a row is opened under the file it is column three while the strip
       * is column two. Comparing the numbers across that is the trap this file
       * warns about twice, and the first draft of this test walked into it.
       *
       * What is promised is the shape: the terminals are a ROW among rows.
       * Taking the empty column would have made them a column among columns,
       * full height beside the person's file, which is the picture the customer
       * sent.
       */
      const after = await layoutNow();
      assert.equal(
        familyOrientationOf(after, strip - 1),
        1,
        `the terminals are a column beside the files rather than a strip under them: ${describeGroups()}`
        + ` | the stand was ${JSON.stringify(stand)} and it is now ${JSON.stringify(after)}`
      );
      assert.equal(
        vscode.window.tabGroups.all.length,
        3,
        `the person's empty column was taken instead of left alone: ${describeGroups()}`
      );
      assert.ok(
        vscode.window.tabGroups.all.some((group) => group.tabs.length === 0),
        `the person's empty column is gone: ${describeGroups()}`
      );
    } finally {
      handle.dispose();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });

  /*
   * The customer, 2026-08-22, on the build that put the strip below the editors
   * at last: "теперь открывается в панели как нужно НО при переоткрытии
   * остаётся пустая панель."
   *
   * What a restart leaves: the grid is the editor's and comes back whole, and
   * every terminal this build makes is `isTransient: true` (A3) and does not.
   * A third of the editor area, held by a group with nothing in it, on every
   * start until they open a terminal.
   *
   * The window that wakes cannot be built here -- a suite runs inside one that
   * is already awake -- so what is built is the SHAPE it wakes into, which is
   * the whole of what the rule is given to decide on: editors above, an empty
   * group below them, and nothing of ours anywhere.
   */
  test('takes away the empty strip a restart brings back', async () => {
    const { editorStrip } = await api();
    assert.ok(editorStrip, 'this window has no strip to keep, and the engine or the location says why');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    const file = await vscode.workspace.openTextDocument({
      content: 'a file of the person, above the strip that came back empty',
      language: 'plaintext',
    });
    await vscode.window.showTextDocument(file, { viewColumn: vscode.ViewColumn.One });
    await vscode.commands.executeCommand('workbench.action.newGroupBelow');
    await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
    assert.equal(vscode.window.tabGroups.all.length, 2, `the stand is not two rows: ${describeGroups()}`);
    const stand = await layoutNow();
    assert.equal(stand.orientation, 1, `the stand did not come out as rows: ${JSON.stringify(stand)}`);

    try {
      const took = await editorStrip.takeAwayEmptyGroups();
      assert.equal(took, 1, `the empty strip was left where it was: ${describeGroups()}`);
      assert.equal(
        vscode.window.tabGroups.all.length,
        1,
        `the editor area still holds the empty strip: ${describeGroups()}`
      );
      assert.equal(
        columnOf('a file of the person'),
        vscode.ViewColumn.One,
        `the person's file did not survive the tidying up: ${describeGroups()}`
      );
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });

  /*
   * The owner, 2026-08-23, on the build that took away the empty strip at the
   * END of the area: "повторилось также появились пустые группы" -- with three
   * of them stacked ABOVE their terminals.
   *
   * Their shape, built here: editors nowhere, terminals at the bottom, empty
   * groups above. The first rule looked at the last group, found the terminals
   * in it and did nothing, which from the chair is a fix that did not fix
   * anything.
   */
  test('takes away every empty group a restart brings back, not only the last one', async () => {
    const { editorStrip } = await api();
    assert.ok(editorStrip, 'this window has no strip to keep, and the engine or the location says why');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    const file = await vscode.workspace.openTextDocument({
      content: 'the only thing in the editor area, at the bottom of it',
      language: 'plaintext',
    });
    await vscode.window.showTextDocument(file, { viewColumn: vscode.ViewColumn.One });
    // Three empty groups above what is held, which is the picture they sent.
    for (let made = 1; made <= 3; made += 1) {
      await vscode.commands.executeCommand('workbench.action.newGroupAbove');
    }
    assert.equal(vscode.window.tabGroups.all.length, 4, `the stand is not four groups: ${describeGroups()}`);

    try {
      const took = await editorStrip.takeAwayEmptyGroups();
      assert.equal(took, 3, `${String(took)} of the three empty groups went: ${describeGroups()}`);
      assert.equal(
        vscode.window.tabGroups.all.length,
        1,
        `the editor area still holds empty groups: ${describeGroups()}`
      );
      assert.notEqual(
        columnOf('the only thing in the editor area'),
        undefined,
        `the person's file did not survive the tidying up: ${describeGroups()}`
      );
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });

  /*
   * And the line that keeps it from being a rule about anything else: a group
   * with something in it is never touched, however this window feels about
   * where it is.
   *
   * The price of the wider rule, named rather than hidden: an empty group a
   * person made and has not filled yet is closed with the rest. It is only ever
   * run in the first seconds of a window, it only ever runs when the workbench
   * is set to close empty groups itself -- which is what makes the group a
   * leftover rather than a choice -- and what a person loses is a split holding
   * nothing.
   */
  test('never touches a group that holds anything', async () => {
    const { editorStrip } = await api();
    assert.ok(editorStrip, 'this window has no strip to keep, and the engine or the location says why');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    const left = await vscode.workspace.openTextDocument({
      content: 'a file in the column the person works in',
      language: 'plaintext',
    });
    const right = await vscode.workspace.openTextDocument({
      content: 'a file in the column beside it',
      language: 'plaintext',
    });
    await vscode.window.showTextDocument(left, { viewColumn: vscode.ViewColumn.One });
    await vscode.window.showTextDocument(right, { viewColumn: vscode.ViewColumn.Two });
    assert.equal(vscode.window.tabGroups.all.length, 2, `the stand is not two columns: ${describeGroups()}`);

    try {
      const took = await editorStrip.takeAwayEmptyGroups();
      assert.equal(took, 0, `something was closed that had a file in it: ${describeGroups()}`);
      assert.equal(vscode.window.tabGroups.all.length, 2, `a column with a file in it is gone: ${describeGroups()}`);
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });

  /*
   * THE MEASUREMENT THIS EXISTS FOR, 2026-08-23. In a sitting where five empty
   * groups stood for forty seconds, the cleanup said NOTHING AT ALL, and the log
   * did not allow anybody to tell which of its silent ways out it had taken. The
   * cause had to be recovered by reading sources and comparing timestamps --
   * which is exactly the position this product was putting its owner in, and
   * exactly what a log is for.
   *
   * `takeAwayEmptyGroups` had eight outcomes and wrote a line on two of them.
   * The three below are the ones a suite can stand up honestly.
   *
   * Two of the ways out that were named here as unenterable races are GONE
   * rather than still untested (Ш8, 2026-08-25): the arranging lock and
   * somebody pressing the plus mid-sweep were the boolean and the counter that
   * `OneTurnAtATime` replaced, and neither state exists any more -- the sweep
   * is a turn of one queue, and nothing else runs inside it. What is left
   * untested is still untested and still named rather than pretended about: the
   * editor refusing to close a group it was asked to, a window taken down while
   * the sweep was waiting for it to stop moving, and a person who has turned
   * `workbench.editor.closeEmptyGroups` off.
   *
   * Read out of the FILE IN THE STORE, because that file is the whole of Ш3: it
   * is what a person can be asked for after they have closed the window.
   */
  test('says why it took nothing away when every group holds something', async () => {
    const { editorStrip } = await api();
    assert.ok(editorStrip, 'this window has no strip to keep, and the engine or the location says why');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    const left = await vscode.workspace.openTextDocument({
      content: 'a file in the column the person works in',
      language: 'plaintext',
    });
    const right = await vscode.workspace.openTextDocument({
      content: 'a file in the column beside it',
      language: 'plaintext',
    });
    await vscode.window.showTextDocument(left, { viewColumn: vscode.ViewColumn.One });
    await vscode.window.showTextDocument(right, { viewColumn: vscode.ViewColumn.Two });
    assert.equal(vscode.window.tabGroups.all.length, 2, `the stand is not two columns: ${describeGroups()}`);

    const mark = await markInTheLog();
    try {
      const took = await editorStrip.takeAwayEmptyGroups();
      assert.equal(took, 0, `something was closed that had a file in it: ${describeGroups()}`);

      const said = await saidSince(mark);
      assert.match(
        said,
        /the sweep of empty groups is over/,
        `the sweep said nothing at all, so the log cannot say which way out it took: ${JSON.stringify(said)}`
      );
      assert.match(
        said,
        /every group in the editor area holds something/,
        `the sweep did not say WHY it took nothing: ${JSON.stringify(said)}`
      );
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });

  test('says why it took nothing away when the editor area holds one group', async () => {
    const { editorStrip } = await api();
    assert.ok(editorStrip, 'this window has no strip to keep, and the engine or the location says why');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    assert.equal(vscode.window.tabGroups.all.length, 1, `the stand is not one group: ${describeGroups()}`);

    const mark = await markInTheLog();
    const took = await editorStrip.takeAwayEmptyGroups();
    assert.equal(took, 0, `the only group in the area was taken: ${describeGroups()}`);

    const said = await saidSince(mark);
    assert.match(
      said,
      /the editor area holds one group/,
      `the sweep did not say that an empty area is nobodys problem: ${JSON.stringify(said)}`
    );
  });

  /*
   * The way out the owner's own sitting most likely took, and the one that cost
   * the most to work out: a window that has already made a group for its
   * terminals leaves every empty group alone, and said nothing about it.
   */
  test('says why it took nothing away when the terminals already have a group', async () => {
    const { gateway, editorStrip } = await api();
    assert.ok(editorStrip, 'this window has no strip to keep, and the engine or the location says why');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    const handle = await gateway.create({
      terminalId: TERMINAL_ID,
      name: 'gripterm-m224-kept',
      cwd: os.tmpdir(),
      env: {},
      shellPath: null,
      shellArgs: [],
    });

    try {
      await waitFor('the terminal to get a tab', () => columnOf('gripterm-m224-kept') !== undefined);
      /*
       * No extra group is made here, and that is not laziness. Inserting one
       * ABOVE renumbers the columns, so the number this window remembers stops
       * naming its own group and `_kept()` lets go of it -- which is a
       * different way out, and the one the two tests above already stand on.
       */
      const mark = await markInTheLog();
      const took = await editorStrip.takeAwayEmptyGroups();
      assert.equal(took, 0, `an empty group went while the strip was ours: ${describeGroups()}`);

      const said = await saidSince(mark);
      assert.match(
        said,
        /the terminals already have a group of their own/,
        `the sweep left five empty groups standing and said nothing: ${JSON.stringify(said)}`
      );
    } finally {
      handle.dispose();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });

  /*
   * The FIRST half of the customer's sixth complaint, and the half that was
   * still open on 2026-08-22: "панель с терминалами открывается на весь экран
   * ПОСЛЕ ЗАГРУЗКИ... воспроизводится в непонятных для меня случаях."
   *
   * The state a window is in most often right after it starts, and the one this
   * suite never stood the strip up from: an editor area with NOTHING in it, one
   * empty group. `column()` splits it, and the split is a workbench command
   * that answers `undefined` whether it did anything or not.
   *
   * **Measured 2026-08-22, and this is why the rule exists.** In the Cursor on
   * that machine, `workbench.action.newGroupBelow` over an empty editor area
   * made a group nine times out of ten and silently made none on the tenth; in
   * another run of the same probe it threw `Invalid editor group provided!`. VS
   * Code stable did it fifteen times out of fifteen. Unchecked, the miss made
   * `column()` read the ACTIVE group -- the person's own and only group -- lock
   * it, and put the terminals in it: a locked terminal group filling the editor
   * area, which is the "на весь экран" exactly, and the next file then had to
   * go BESIDE it.
   *
   * What this run can and cannot hold. It asserts the INVARIANT -- after a
   * terminal is made from an empty area, the terminals are never the only group
   * -- three times over, which is the thing that was false. It cannot make the
   * command miss on demand, so under VS Code it would have passed before the
   * fix as well; the run that failed is written down in
   * `docs/experiments/2026-08-21-customer-feedback.md` and is reproduced with
   * `spikes/cursor-probe`.
   */
  test('never leaves the terminals alone in an editor area that started empty', async () => {
    const { gateway } = await api();

    for (const attempt of [1, 2, 3]) {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await waitFor('the editor area to be one empty group', () =>
        vscode.window.tabGroups.all.length === 1 && vscode.window.tabGroups.all[0]?.tabs.length === 0);

      const name = `gripterm-m224-empty-${String(attempt)}`;
      const handle = await gateway.create({
        terminalId: TERMINAL_ID,
        name,
        cwd: os.tmpdir(),
        env: {},
        shellPath: null,
        shellArgs: [],
      });
      try {
        await waitFor('the terminal to get a tab', () => columnOf(name) !== undefined);
        // The rescue is asynchronous, so the invariant is asserted once the
        // window has settled rather than at the instant the tab appeared.
        await waitFor(
          `the terminals not to be the only group: ${describeGroups()}`,
          () => vscode.window.tabGroups.all.length > 1
        );

        const strip = columnOf(name);
        assert.ok(strip !== undefined, `the terminal lost its group: ${describeGroups()}`);
        const elsewhere = vscode.window.tabGroups.all.filter((group) => group.viewColumn !== strip);
        assert.ok(
          elsewhere.length > 0,
          `the terminals took the whole editor area: ${describeGroups()}`
        );

        /*
         * And a strip is a STRIP -- the size half of the same complaint, which
         * having a neighbour does not answer on its own. Measured in Cursor on
         * 2026-08-22: the group was there, and ours held 673 pixels of 743, so
         * the person still met "новый терминал на всю область файлов" with a
         * seventy-pixel sliver above it.
         *
         * WHAT THIS TEST CANNOT HOLD, said out loud: it did not fail on the
         * build that had that defect. The cause is the editor answering
         * `getEditorLayout` with a layout it has not sized yet, and this host
         * has never been seen to do it -- the retry the product now makes is
         * what handles it, and the evidence for it is the Cursor probe in the
         * protocol, not this line. What this line holds is the promise itself,
         * so a build that starts taking the area here fails here.
         */
        const share = shareOf(await layoutNow(), strip - 1);
        assert.ok(share !== null, `the editor sized no group for the strip: ${describeGroups()}`);
        assert.ok(
          share <= 0.5,
          `the terminals took ${String(Math.round(share * 100))}% of the space they share: ${describeGroups()}`
        );
      } finally {
        handle.dispose();
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      }
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
   * chevron is drawn on the title bar of our group and nowhere else. A menu's
   * visibility is not readable. What IS asserted, below, is the whole of what
   * the editor is given to decide it with -- the customer reported on
   * 2026-08-22 that the button had still never appeared, and the `when` behind
   * it was the platform's `activeEditor == 'terminalEditor'`, a string a fork
   * is free not to answer. It is ours now, so the answer is ours to hold.
   */
  test('throws the terminals over the whole editor area, and puts them back', async () => {
    const { gateway, inFront } = await api();
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
      // The key the button is drawn on, and the only part of the drawing a run
      // can reach. `refresh` because a tab that became active without an event
      // -- the API promises no order here -- must not be read as "no terminal".
      inFront.refresh();
      assert.equal(
        inFront.inFront,
        true,
        'a terminal is the editor in front and the key that draws the button says otherwise'
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

    // And it goes back down: a button that never turns off is a button on
    // every file the person opens.
    await waitFor('the terminal to be gone from the editor area', () =>
      vscode.window.tabGroups.all.every((group) =>
        group.tabs.every((tab) => !(tab.input instanceof vscode.TabInputTerminal))));
    inFront.refresh();
    assert.equal(inFront.inFront, false, 'the key still says a terminal is in front, and there is none');
  });

  /*
   * The button pressed from somewhere that is NOT the terminal's own tab bar.
   *
   * The customer has now reported three times that the icon never appears on
   * that tab bar in Cursor, and on 2026-08-22 the key it hangs on was measured
   * in Cursor itself and found to be set correctly (`probe-empty-strip.ts`:
   * `inFront = true` with a terminal in front, `false` with a file). What is
   * missing is the drawing, which no API can be asked about -- so the button
   * was put where that editor is known to draw ours, the title bar of the list
   * of terminals, and from there the active group is whatever file the person
   * last touched.
   *
   * `toggleMaximizeEditorGroup` names no target. Without the strip being stood
   * on first, this test maximises the person's SOURCE FILE -- a button doing
   * the opposite of what its title says, which is the defect the owner found in
   * the arrow on the same day.
   */
  test('maximises the terminals when it is pressed from a file the person was in', async () => {
    const { gateway } = await api();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const file = await vscode.workspace.openTextDocument({
      content: 'the file the person was looking at when they pressed the button',
      language: 'plaintext',
    });
    await vscode.window.showTextDocument(file, { viewColumn: vscode.ViewColumn.One });

    const handle = await gateway.create({
      terminalId: TERMINAL_ID,
      name: 'gripterm-m224-from-the-list',
      cwd: os.tmpdir(),
      env: {},
      shellPath: null,
      shellArgs: [],
    });
    let maximised = false;
    try {
      await waitFor('the terminal to get a tab', () => columnOf('gripterm-m224-from-the-list') !== undefined);
      const strip = columnOf('gripterm-m224-from-the-list');
      assert.ok(strip !== undefined);
      const theirs = columnOf('the file the person was looking at');
      assert.ok(theirs !== undefined);

      // Where the person is: their file, not the terminal.
      await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
      await waitFor(
        'the editor to stand on the group the person was in',
        () => vscode.window.tabGroups.activeTabGroup.viewColumn === theirs
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
        `the button maximised something else: our group has ${String(during.size)} px`
          + ` of the ${String(before.span)} px the editor area is | ${describeGroups()}`
      );

      await vscode.commands.executeCommand('gripterm.maximizeTerminals');
      maximised = false;
      const after = sizeAndSpanOf(await layoutNow(), strip - 1);
      assert.ok(after !== null);
      assert.equal(after.size, before.size, 'the second press did not put the group back');
    } finally {
      if (maximised) {
        await vscode.commands.executeCommand('gripterm.maximizeTerminals');
      }
      handle.dispose();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });

  /*
   * And with nothing of ours in front of anybody, it declines.
   *
   * The command is in the palette and in the title bar of the list, both of
   * which a person can reach with no terminal open at all. `toggleMaximize`
   * would then throw their file over the window -- a button that says
   * "the Terminals" doing something to a file is worse than one that does
   * nothing, and this is the line that holds it.
   */
  test('does nothing at all when there are no terminals to maximise', async () => {
    await api();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const file = await vscode.workspace.openTextDocument({
      content: 'a file, and not a terminal in sight',
      language: 'plaintext',
    });
    await vscode.window.showTextDocument(file, { viewColumn: vscode.ViewColumn.One });
    await vscode.commands.executeCommand('workbench.action.newGroupRight');
    await vscode.window.showTextDocument(file, { viewColumn: vscode.ViewColumn.Two });
    await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');

    try {
      const before = sizeAndSpanOf(await layoutNow(), 0);
      assert.ok(before !== null, 'the editor reports no size for the group the person is in');
      assert.ok(before.size < before.span, 'the stand is one group, so nothing could be maximised anyway');

      await vscode.commands.executeCommand('gripterm.maximizeTerminals');
      const after = sizeAndSpanOf(await layoutNow(), 0);
      assert.ok(after !== null);
      assert.equal(
        after.size,
        before.size,
        `the button threw the person's own file over the editor area: ${String(after.size)} px`
          + ` where it had ${String(before.size)} px`
      );
    } finally {
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

  /*
   * The owner, 2026-08-27: "закрываю файл - панель с терминалом максимизируется
   * сама". `_keepCompany` exists for exactly that and did not fire, and this is
   * the sequence that stops it firing -- every step of it something a person
   * does, and one of them the very button the same report is about.
   *
   * The strip is remembered by a NUMBER. When the number stops naming the strip
   * -- a split above it renumbers everything after -- the next question asked of
   * `_kept()` lets go of it, and `standOnTheStrip`, which the maximise button
   * asks first, is one of those questions. From then on nothing puts the number
   * back: `_foundByItsTerminals` is reached only THROUGH `_kept()`, which
   * answers `null` before it gets there. So the person closes their last file,
   * the editor takes the emptied group away, and the rule that would have put a
   * group back above the terminals declines because it cannot name them.
   */
  test('keeps a group above the terminals after the strip has been renumbered under it', async () => {
    const { gateway } = await api();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    const folder = await mkdtemp(join(os.tmpdir(), 'gripterm-renumbered-'));
    const path = join(folder, 'paste-two-lines.txt');
    await writeFile(path, 'the file the owner opened and then closed', 'utf8');
    const file = await vscode.workspace.openTextDocument(path);
    await vscode.window.showTextDocument(file, { viewColumn: vscode.ViewColumn.One });

    const handle = await gateway.create({
      terminalId: TERMINAL_ID,
      name: 'gripterm-m224-renumbered',
      cwd: os.tmpdir(),
      env: {},
      shellPath: null,
      shellArgs: [],
    });
    try {
      await waitFor('the terminal to get a tab', () => columnOf('gripterm-m224-renumbered') !== undefined);
      // Into a local first: `assert.equal` narrows what it is handed, and a
      // narrowed `tabGroups.all.length` makes every later reading of it a
      // constant to the type checker -- which is how the linter came to call
      // the wait below a comparison that is always false.
      const stand = vscode.window.tabGroups.all.length;
      assert.equal(stand, 2, `the stand is not a file and a strip: ${describeGroups()}`);

      // The person splits the group their file is in, which renumbers ours.
      await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
      await vscode.commands.executeCommand('workbench.action.splitEditorDown');
      await waitFor(
        `a third group to appear: ${describeGroups()}`,
        () => vscode.window.tabGroups.all.length === 3
      );

      const mark = await markInTheLog();
      // And then presses the button this same report is about, from their file.
      await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
      await vscode.commands.executeCommand('gripterm.maximizeTerminals');

      // The person closes their files, both of them, and the editor takes the
      // emptied groups away by itself.
      const closeTheFileInFront = async (): Promise<void> => {
        await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        await new Promise((resolve) => setTimeout(resolve, 200));
      };
      await closeTheFileInFront();
      await closeTheFileInFront();

      const until = Date.now() + 12000;
      while (vscode.window.tabGroups.all.length < 2 && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(
        vscode.window.tabGroups.all.length > 1,
        `the terminals were left alone in the editor area: ${describeGroups()}`
          + ` | ${JSON.stringify(await saidSince(mark))}`
      );
    } finally {
      handle.dispose();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await rm(folder, { recursive: true, force: true });
    }
  });

  /*
   * The owner, 2026-08-27: "нет реакции на кнопку Maximise the Terminal".
   *
   * `workbench.action.toggleMaximizeEditorGroup` has nothing to maximise a
   * group OVER when the editor area holds one group, and it says so the way
   * every workbench command says everything -- by answering `undefined` and
   * changing nothing. The command around it then wrote
   * `the group holding the terminals was maximised or put back` regardless,
   * which is the log asserting what it never checked (I.1) about the one
   * question the person had.
   *
   * The stand is a single group holding a terminal AND a file, which is a
   * state the strip's own repair leaves alone -- it is not a group of nothing
   * but terminals -- so the window cannot move under the measurement.
   */
  test('says nothing was maximised when there was nothing to maximise', async () => {
    // The whole object, not `said` destructured off it: `said` is a getter that
    // answers with a copy, so a destructured one is a snapshot of the sentences
    // this window had said before the button was pressed.
    const gripterm = await api();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await waitFor('the editor area to be one empty group', () =>
      vscode.window.tabGroups.all.length === 1 && vscode.window.tabGroups.all[0]?.tabs.length === 0);

    const theirs = vscode.window.createTerminal({
      name: 'a terminal the person made themselves',
      location: { viewColumn: vscode.ViewColumn.One },
    });
    try {
      await waitFor('the person`s own terminal to get a tab', () =>
        columnOf('a terminal the person made themselves') !== undefined);
      const file = await vscode.workspace.openTextDocument({
        content: 'a file in the same group as the terminal',
        language: 'plaintext',
      });
      await vscode.window.showTextDocument(file, { viewColumn: vscode.ViewColumn.One });
      theirs.show(false);
      await waitFor(
        `the terminal to be the tab in front: ${describeGroups()}`,
        () => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTerminal
      );
      const area = vscode.window.tabGroups.all.length;
      assert.equal(area, 1, `the editor area is not the one group this measures: ${describeGroups()}`);

      const before = await layoutNow();
      const mark = await markInTheLog();
      const saidBefore = gripterm.said.length;
      await vscode.commands.executeCommand('gripterm.maximizeTerminals');
      const after = await layoutNow();

      // The measurement itself: the editor really does nothing here. The day it
      // starts doing something, this line is what says so.
      assert.deepEqual(
        after,
        before,
        `the editor maximised something after all: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`
      );

      const wrote = await saidSince(mark);
      assert.doesNotMatch(
        wrote,
        /was maximised or put back/,
        `the log says the group was maximised, and the editor area never moved: ${JSON.stringify(wrote)}`
      );
      assert.match(
        wrote,
        /nothing to maximise|nothing was maximised/,
        `the button did nothing and the log did not say so: ${JSON.stringify(wrote)}`
      );

      // And the person is told, which is the half of the complaint no log
      // answers: from in front of the screen a button that declines and a
      // button that is broken are the same button.
      const sentences = gripterm.said.slice(saidBefore);
      assert.ok(
        sentences.some((sentence) => sentence.includes('nothing to maximise them over')),
        `the button did nothing and the window said nothing: ${JSON.stringify(sentences)}`
      );
    } finally {
      theirs.dispose();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });
});
