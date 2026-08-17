import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import type { GriptermApi } from '../../packages/extension/src/extension';

/**
 * The page, in the only place its claims can be checked: a real editor, a real
 * webview, a real xterm.
 *
 * Everything here is asked of the PAGE and answered by the page. That is the
 * point of the step: "no CSP violations" and "xterm got the theme and the
 * metrics" are exactly the kind of claim a person makes by glancing at a screen
 * and a suite has no business repeating on trust. The page reports what it
 * measured -- its own box, its own font, its own policy violations -- and these
 * tests assert those numbers.
 */

const SETTLES_WITHIN_MS = 30_000;

/**
 * The panel container's id, written out rather than imported.
 *
 * An integration suite may take TYPES from the extension package and no values:
 * a value would be a second compiled copy of the module beside the bundle the
 * editor is running (M3.4-Б proved that by watching it fail). So the name is
 * here, and the test below checks it against the manifest.
 */
const PANEL_CONTAINER = 'griptermPanel';

/**
 * `vsce` starting up is slow, and this asks it exactly once.
 *
 * Under the suite's own two-minute limit rather than at it: a test that hit the
 * process timeout and the mocha timeout at the same moment would report the
 * second and hide the first.
 */
const PACKAGING_TIMEOUT_MS = 60_000;

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

/**
 * Brings the panel tab up, which is what makes the view exist at all.
 *
 * A panel webview view is not resolved until its tab is shown -- the lesson the
 * M3.2 stand met and the reason M3.7 has a rehydration handshake rather than a
 * start-up one.
 */
async function show(): Promise<void> {
  await vscode.commands.executeCommand('gripterm.workbench.focus');
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}

suite('the panel this extension draws in', () => {
  test('the panel tab exists, rather than the view quietly landing in the explorer', async () => {
    // The one thing a resolved view and a working page CANNOT tell apart, and
    // it cost this step an hour on 2026-08-17. A view container whose id is not
    // alphanumeric is refused by VS Code 1.133 -- `property 'id' is mandatory
    // and must be of type 'string'` -- and then `View container 'gripterm.panel'
    // does not exist and all views registered to it will be added to
    // 'Explorer'`. Both lines go to the extension host log and nowhere else: the
    // extension activates, the page loads, every other test here passes, and the
    // panel tab the whole step is about is not there.
    //
    // The editor registers `workbench.view.extension.<container>` for every
    // container it accepted, so this asks the editor rather than the manifest.
    const commands = await vscode.commands.getCommands(true);

    assert.ok(
      commands.includes(`workbench.view.extension.${PANEL_CONTAINER}`),
      `no panel container: the editor refused '${PANEL_CONTAINER}' and the view is somewhere else`
    );
  });

  test('the manifest and this suite name the same container', async () => {
    // Belt and braces, and the braces are the point: the test above would pass
    // just as happily if the manifest were renamed and this constant left
    // behind -- it would then be asking about a container nothing contributes.
    const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
    assert.ok(extension);
    const manifest = extension.packageJSON as {
      contributes: {
        viewsContainers: { panel: readonly { id: string }[] };
        views: Record<string, readonly { id: string, type?: string }[]>;
      };
    };

    assert.deepEqual(
      manifest.contributes.viewsContainers.panel.map((one) => one.id),
      [PANEL_CONTAINER]
    );
    assert.deepEqual(manifest.contributes.views[PANEL_CONTAINER], [
      { id: 'gripterm.workbench', name: 'Agents', type: 'webview', contextualTitle: 'Gripterm' },
    ]);
  });

  test('the tab opens, the page loads, and it reports what it was given', async () => {
    const { workbench } = await api();
    await show();

    const report = await workbench.whenReady(SETTLES_WITHIN_MS);

    // xterm exists and has geometry: a terminal of no columns is the shape of
    // every "it rendered" claim that turns out to be about a hidden box.
    assert.ok(report.cols > 0, `no columns: ${JSON.stringify(report)}`);
    assert.ok(report.rows > 0, `no rows: ${JSON.stringify(report)}`);
    // The number the plan asked to be named, checked where it lands rather than
    // where it is written.
    assert.equal(report.scrollback, 1000);
    // The theme reached it: a colour, taken from the editor's own variables.
    assert.match(report.background, /^(?:#|rgb)/u);
    // And the metrics: the font a webview cannot read out of the settings by
    // itself, so if this is empty the page is drawing in a proportional font.
    assert.ok(report.fontFamily.length > 0, 'no font family');
    assert.ok(report.fontSize > 0, 'no font size');
    // The codicon font is loaded and usable. This is what M3.9 draws state
    // icons with, and the reason `font-src` is in the policy at all.
    assert.equal(report.codiconLoaded, true);
    // The width table, and it is asserted because dropping the addon breaks
    // nothing visible to a suite: the `✅` and the CJK glyphs Claude Code prints
    // silently become one cell wide, and every frame after one of them is off by
    // a column (M3.2 stage B, answer 4).
    assert.equal(report.unicodeVersion, '11');
  });

  test('the page reports no policy violation of its own making', async () => {
    const { workbench } = await api();
    await show();
    await workbench.whenReady(SETTLES_WITHIN_MS);

    // A violation is reported by the document as it happens, so this waits a
    // beat after the page settled rather than reading an empty list at once.
    await delay(1000);

    assert.deepEqual(workbench.violations, []);
  });

  test('both halves are on screen, and the border between them moves', async () => {
    const { workbench } = await api();
    await show();
    const before = await workbench.whenReady(SETTLES_WITHIN_MS);

    assert.ok(before.terminalWidth > 0, 'the terminal half has no width');
    assert.ok(before.detailsWidth > 0, 'the details half has no width');

    // Dragged by the page on the suite's order, because a suite has no pointer:
    // the page dispatches real pointer events at the splitter, so what is being
    // exercised is the handler a person's mouse would reach.
    const after = await workbench.dragSplitterBy(-120, SETTLES_WITHIN_MS);

    assert.ok(
      after.terminalWidth < before.terminalWidth,
      `the terminal half did not shrink: ${String(before.terminalWidth)} -> ${String(after.terminalWidth)}`
    );
    assert.ok(
      after.detailsWidth > before.detailsWidth,
      `the details half did not grow: ${String(before.detailsWidth)} -> ${String(after.detailsWidth)}`
    );
    // The screen followed the border rather than keeping its old size.
    assert.ok(after.cols < before.cols, `xterm kept ${String(before.cols)} columns`);

    await workbench.dragSplitterBy(120, SETTLES_WITHIN_MS);
  });

  test('a change of theme repaints the terminal', async () => {
    const { workbench } = await api();
    await show();
    const before = await workbench.whenReady(SETTLES_WITHIN_MS);

    // Written into the test host's own user data directory (`.vscode-test/`),
    // not the person's settings, and put back in the `finally` regardless.
    const settings = vscode.workspace.getConfiguration('workbench');
    const previous = settings.get<string>('colorTheme');
    const other = before.background.toLowerCase() === '#ffffff'
      ? 'Default Dark Modern'
      : 'Default Light Modern';
    try {
      const repainted = workbench.nextMeasurement(SETTLES_WITHIN_MS);
      await settings.update('colorTheme', other, vscode.ConfigurationTarget.Global);
      const after = await repainted;

      assert.notEqual(
        after.background.toLowerCase(),
        before.background.toLowerCase(),
        `the terminal kept ${before.background} after the theme changed to ${other}`
      );
    } finally {
      await settings.update('colorTheme', previous, vscode.ConfigurationTarget.Global);
      await workbench.nextMeasurement(SETTLES_WITHIN_MS).catch(() => null);
    }
  });

  test('zooming the editor re-lays the terminal out', async () => {
    const { workbench } = await api();
    await show();
    const before = await workbench.whenReady(SETTLES_WITHIN_MS);

    try {
      const relaid = workbench.nextMeasurement(SETTLES_WITHIN_MS);
      await vscode.commands.executeCommand('workbench.action.zoomIn');
      const after = await relaid;

      // Zoom makes every CSS pixel bigger, so the same panel holds fewer cells.
      // Asserted on the cell count rather than on the pixel box: the box is what
      // the editor changed, the cells are what the person reads.
      assert.ok(
        after.cols < before.cols || after.rows < before.rows,
        `nothing moved: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`
      );
    } finally {
      await vscode.commands.executeCommand('workbench.action.zoomReset');
      await workbench.nextMeasurement(SETTLES_WITHIN_MS).catch(() => null);
    }
  });

  test('hiding the panel and bringing it back does not build the page again', async () => {
    const { workbench } = await api();
    await show();
    const before = await workbench.whenReady(SETTLES_WITHIN_MS);
    const resolvedBefore = workbench.resolveCount;

    await vscode.commands.executeCommand('workbench.action.togglePanel');
    await delay(500);
    await show();
    await delay(500);

    // This is the decision of M3.6 in the one form that can be checked:
    // `retainContextWhenHidden: true`. Same page, same generation, so the
    // scrollback, the selection and the cursor a person left behind are still
    // there. The cost is memory, and it is named in the plan rather than here.
    const after = await workbench.measure('after the panel came back', SETTLES_WITHIN_MS);
    assert.equal(after.generation, before.generation);
    assert.equal(workbench.resolveCount, resolvedBefore);
  });

  test('the policy is really in force, and a refusal really reaches the log', async () => {
    // Last on purpose: this one dirties the list of violations that the second
    // test asserts is empty, and it does so deliberately.
    //
    // Without it, `violations: []` would be exactly what a page reports when
    // nobody is listening at all -- the vacuum this repository keeps finding by
    // mutation (M1.5, M2.11, M3.5). Here the page reaches for an image from
    // another origin, `img-src` names our own origin and `data:` and nothing
    // else, and the request is stopped before it is made: nothing leaves this
    // machine, and the block is reported.
    const { workbench } = await api();
    await show();
    await workbench.whenReady(SETTLES_WITHIN_MS);

    const violation = await workbench.breakPolicy(SETTLES_WITHIN_MS);

    assert.equal(violation.directive, 'img-src');
    assert.match(violation.blockedUri, /example\.invalid/u);
  });

  test('the archive carries the page, the font and the notice', async () => {
    // `vsce ls` lives in the integration run rather than in `pnpm test` for one
    // reason: it asks about BUILT files, and the integration run is the suite
    // that is always preceded by a build. In `pnpm test` the same assertion
    // would be red on a clean checkout and green after a build -- a test whose
    // answer depends on what somebody ran last is not a test.
    const files = await new Promise<readonly string[]>((resolve, reject) => {
      execFile(
        'npx',
        ['vsce', 'ls', '--no-dependencies'],
        {
          cwd: join(__dirname, '..', '..', '..', 'packages', 'extension'),
          shell: true,
          timeout: PACKAGING_TIMEOUT_MS,
        },
        (error: unknown, stdout: string) => {
          if (error !== null) {
            reject(new Error('vsce ls could not list the package contents', { cause: error }));
            return;
          }
          resolve(stdout.split('\n').map((line) => line.trim().replaceAll('\\', '/')).filter(Boolean));
        }
      );
    });

    assert.ok(files.includes('dist/webview/main.js'), `no page script: ${files.join(', ')}`);
    assert.ok(files.includes('dist/webview/main.css'), 'no page stylesheet');
    assert.ok(
      files.some((file) => /^dist\/webview\/codicon-[^/]+\.ttf$/u.test(file)),
      'no codicon font, so M3.9 has nothing to draw state icons with'
    );
    assert.ok(files.includes('media/panel.svg'), 'no icon for the panel tab');
    // The font is CC-BY-4.0: shipping it without the attribution is a condition
    // of the licence unmet, not a missing courtesy.
    assert.ok(files.includes('NOTICE.md'), 'no NOTICE, and the codicon font requires one');
  });
});
