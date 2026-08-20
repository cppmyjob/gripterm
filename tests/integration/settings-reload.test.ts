import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { GriptermApi } from '../../packages/extension/src/extension';

/**
 * What a running window says when somebody changes a setting it has already
 * read (M3.13).
 *
 * The rule and the sentences are held by `tests/extension/reload-notice.test.ts`,
 * which needs no host. This suite holds the half that a rule cannot: that the
 * window is LISTENING -- that the editor really raises the event for our
 * section, that the handler is really subscribed, and that a sentence really
 * comes out of it. Delete the subscription and the unit suite stays green; this
 * one does not.
 *
 * Read through `api.said` rather than by intercepting the toast. Replacing
 * `vscode.window.showInformationMessage` from here was tried first and collected
 * NOTHING (2026-08-18) -- the object a suite gets from `require` is not
 * necessarily the object the extension is calling -- and a collector that stays
 * empty cannot tell a silent window from a misdirected sentence. What `api.said`
 * cannot show is the toast on the screen: that is one line of `ui/say.ts` and a
 * person looking, which is M3.14.
 */

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

/** What the window has said since `from`, which is where this test started reading. */
function saidSince(gripterm: GriptermApi, from: number): readonly string[] {
  return gripterm.said.slice(from);
}

suite('a setting this window read once', () => {
  test('changing the engine is answered with the reload it needs', async () => {
    // Activated first: the subscription is made during activation, and a window
    // that had not activated yet would give this suite a green run for a
    // listener nobody had installed.
    const gripterm = await api();
    const from = gripterm.said.length;

    const settings = vscode.workspace.getConfiguration('gripterm');
    // Whatever is in effect now, we set the other one: the event is only raised
    // on a real change, and the second run of this suite has `own` seeded in its
    // profile.
    const before = settings.inspect<string>('terminal.engine')?.globalValue;
    const other = settings.get<string>('terminal.engine') === 'own' ? 'editor' : 'own';

    try {
      await settings.update('terminal.engine', other, vscode.ConfigurationTarget.Global);
      await waitFor(
        `the window to answer a change of the engine (it said ${JSON.stringify(saidSince(gripterm, from))})`,
        () => saidSince(gripterm, from).some((message) => message.includes('which engine makes a terminal'))
      );
    } finally {
      // Back to what the run was started with, including "not set at all".
      await settings.update('terminal.engine', before, vscode.ConfigurationTarget.Global);
    }
  });

  test('answers a change of ours, and says nothing about a change of theirs', async () => {
    const gripterm = await api();
    const from = gripterm.said.length;

    const ours = vscode.workspace.getConfiguration('gripterm');
    const theirs = vscode.workspace.getConfiguration('editor');
    const before = ours.inspect<number>('journal.retentionDays')?.globalValue;
    const theirsBefore = theirs.inspect<boolean>('mouseWheelZoom')?.globalValue;

    try {
      await theirs.update('mouseWheelZoom', true, vscode.ConfigurationTarget.Global);
      await ours.update('journal.retentionDays', 9, vscode.ConfigurationTarget.Global);
      await waitFor(
        `the window to answer a change of the journal retention (it said ${JSON.stringify(saidSince(gripterm, from))})`,
        () => saidSince(gripterm, from).some((message) => message.includes('how long the event journal is kept'))
      );

      // One sentence, not nine and not two. The editor setting was changed FIRST
      // and the answer to ours has already arrived, so the window had every
      // chance to answer that one too. This is what catches a rule that says
      // something about any change at all.
      const notices = saidSince(gripterm, from).filter((message) => message.startsWith('Gripterm reads'));
      assert.equal(
        notices.length,
        1,
        `the window said more than the one thing that changed: ${JSON.stringify(notices)}`
      );
    } finally {
      await ours.update('journal.retentionDays', before, vscode.ConfigurationTarget.Global);
      await theirs.update('mouseWheelZoom', theirsBefore, vscode.ConfigurationTarget.Global);
    }
  });
});
