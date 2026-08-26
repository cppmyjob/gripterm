import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GriptermApi } from '../../packages/extension/src/extension';

/**
 * The claim Ш15 exists to make: what the trash holds can be seen and brought
 * back FROM THE INTERFACE, by somebody who has never opened a file manager.
 *
 * It cannot be made anywhere else. `TrashStore` has its own suite against a real
 * store, and that suite proves the mechanism; what only a real Extension Host
 * can show is the rest of the road -- a command that is registered, a list that
 * is offered, a row chosen out of it, and a store that has the record back
 * afterwards. The list itself is answered through `Picker` for the reason
 * `Asker` exists: a quick pick in a headless run is a suite that HANGS rather
 * than one that fails.
 *
 * All three forms are seeded, because a return that knows one of them is a
 * return that lies about the other two. They are written as JSON rather than
 * made with our own encoders on purpose -- the compiled suite cannot import
 * `@gripterm/core` at all, and this is the contract as it exists ON DISK.
 */

/** A batch of the shape this build mints, so the list is willing to read it. */
const BATCH = '2026-08-01_12-00-00';

const WHOLE_TERMINAL = '5c4b3a29-1d0e-4f6a-9b8c-7d6e5f4a3b2c';
const CARDS_TERMINAL = '6d5c4b3a-2e1f-4a7b-8c9d-0e1f2a3b4c5d';
const OWNER_FILE = 'window-out-of-the-trash.json';

const WHOLE_NAME = 'the whole folder I threw away';
const CARDS_NAME = 'the record I deleted';

/** Long enough for the watcher's debounce and a read, short enough to fail fast. */
const APPEARS_WITHIN_MS = 8000;
const POLL_MS = 50;

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

function recordJson(terminalId: string, displayName: string, now: number): string {
  return JSON.stringify({
    terminalId,
    sessionId: '4a3b2c1d-0e9f-4a8b-9c7d-6e5f4a3b2c1d',
    sessionIdHistory: [],
    owner: {
      kind: 'window',
      ownerId: 'window-that-is-gone',
      editorKind: 'vscode',
      workspaceFolder: 'D:/Projects/elsewhere',
    },
    metadata: { displayName, task: null, notes: [], tags: [], color: null },
    launch: {
      cwd: 'D:/Projects/elsewhere',
      addDirs: [],
      permissionMode: 'manual',
      agent: null,
      model: null,
      worktree: null,
      mcpConfigPaths: [],
      appendSystemPrompt: null,
      extraEnv: {},
    },
    createdAt: now,
    closedAt: null,
    revision: 1,
  });
}

function observedJson(now: number): string {
  return JSON.stringify({
    state: 'idle',
    lastEventAt: now,
    currentTool: null,
    lastAssistantMessage: null,
    cost: null,
    contextWindow: null,
    pid: null,
  });
}

async function there(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitForRow(gripterm: GriptermApi, terminalId: string, wanted: boolean): Promise<void> {
  const deadline = Date.now() + APPEARS_WITHIN_MS;
  while (Date.now() < deadline) {
    if (gripterm.registry.list().some((entry) => entry.terminalId.value === terminalId) === wanted) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  assert.fail(`the row for ${terminalId} did not ${wanted ? 'appear' : 'disappear'} in time`);
}

suite('the way back out of the trash', () => {
  test('is offered from the title of the list and from nowhere else', async () => {
    /*
     * The same rule the cleanup follows, and for the same reason: this is about
     * the STORE and not about the row a person is pointing at. On a row it would
     * read as "bring this row back", which is not a thing a row that is there
     * can mean.
     */
    const manifest = vscode.extensions.getExtension('gripterm-placeholder.gripterm')?.packageJSON as {
      readonly contributes: {
        readonly menus: Readonly<Record<string, readonly { readonly command: string, readonly when?: string }[]>>;
      };
    };
    await api();
    const commands = await vscode.commands.getCommands(true);

    assert.ok(commands.includes('gripterm.restoreFromTrash'), 'restoreFromTrash is not registered');
    assert.deepEqual(
      (manifest.contributes.menus['view/title'] ?? [])
        .filter((item) => item.command === 'gripterm.restoreFromTrash')
        .map((item) => item.when),
      ['view == gripterm.terminals']
    );
    assert.deepEqual(
      (manifest.contributes.menus['view/item/context'] ?? []).filter(
        (item) => item.command === 'gripterm.restoreFromTrash'
      ),
      []
    );
  });

  /*
   * Escape, and it is here rather than left to a unit test because of WHERE the
   * mistake would be: this command's act is a write into the store, and a list a
   * person walked away from must leave the trash exactly as it was.
   *
   * The trash is SEEDED first, deliberately. A run's store already holds batches
   * from earlier suites, so a test that asserted on an empty trash would be
   * asserting about whatever ran before it -- and worse, a command that reached a
   * real quick pick with no answer queued does not fail, it HANGS, which is the
   * hazard `Asker` exists for and which cost this suite one 120-second timeout on
   * 2026-08-26.
   */
  test('changes nothing at all when the list is walked away from', async () => {
    const gripterm = await api();
    const store = gripterm.readiness.storageDir;
    const batch = join(store, 'trash', BATCH);
    const now = Date.now();

    try {
      await mkdir(join(batch, WHOLE_TERMINAL), { recursive: true });
      await writeFile(
        join(batch, WHOLE_TERMINAL, 'record.json'),
        recordJson(WHOLE_TERMINAL, WHOLE_NAME, now),
        'utf8'
      );
      const said = gripterm.said.length;

      gripterm.picker.chooseNothing();
      await vscode.commands.executeCommand('gripterm.restoreFromTrash');

      assert.deepEqual(gripterm.said.slice(said), []);
      assert.equal(await there(join(batch, WHOLE_TERMINAL, 'record.json')), true);
      assert.equal(await there(join(store, 'terminals', WHOLE_TERMINAL)), false);
      // And the list really was drawn: a dismissal that changed nothing because
      // nothing was offered would prove nothing at all.
      const offered = gripterm.picker.offered.at(-1) ?? [];
      assert.ok(offered.includes(WHOLE_NAME), `the list did not offer it: ${JSON.stringify(offered)}`);
    } finally {
      await rm(batch, { recursive: true, force: true });
    }
  });

  test('brings all three forms back, each chosen out of the list a person is shown', async () => {
    const gripterm = await api();
    const store = gripterm.readiness.storageDir;
    const batch = join(store, 'trash', BATCH);
    const now = Date.now();

    try {
      // Form one: a whole terminal folder, with no home left under `terminals/`.
      await mkdir(join(batch, WHOLE_TERMINAL, 'events'), { recursive: true });
      await writeFile(join(batch, WHOLE_TERMINAL, 'events', '2026-08-01.ndjson'), '{"seq":1}\n', 'utf8');
      await writeFile(join(batch, WHOLE_TERMINAL, 'settings.json'), '{"hooks":{}}', 'utf8');
      await writeFile(join(batch, WHOLE_TERMINAL, 'observed.json'), observedJson(now), 'utf8');
      await writeFile(
        join(batch, WHOLE_TERMINAL, 'record.json'),
        recordJson(WHOLE_TERMINAL, WHOLE_NAME, now),
        'utf8'
      );

      // Form two: the two cards only. The terminal's own folder never left, and
      // this is the case a rename of the folder back would fail on.
      await mkdir(join(store, 'terminals', CARDS_TERMINAL, 'events'), { recursive: true });
      await writeFile(
        join(store, 'terminals', CARDS_TERMINAL, 'events', '2026-08-01.ndjson'),
        '{"seq":1}\n',
        'utf8'
      );
      await mkdir(join(batch, CARDS_TERMINAL), { recursive: true });
      await writeFile(join(batch, CARDS_TERMINAL, 'observed.json'), observedJson(now), 'utf8');
      await writeFile(
        join(batch, CARDS_TERMINAL, 'record.json'),
        recordJson(CARDS_TERMINAL, CARDS_NAME, now),
        'utf8'
      );

      // Form three: a presence file, and one that does not decode -- which is
      // the case the trash was given presence files FOR (a decoder defect must
      // not delete its own evidence).
      await mkdir(join(batch, 'owners'), { recursive: true });
      await writeFile(join(batch, 'owners', OWNER_FILE), '{not json', 'utf8');

      const offered = await gripterm.trash?.list();
      assert.ok(offered, 'this window has no trash to read');
      assert.deepEqual(
        offered
          .filter((item) => item.batch === BATCH)
          .map((item) => `${item.form} ${item.displayName ?? item.name}`)
          .sort(),
        [
          `owner-file ${OWNER_FILE}`,
          `record-only ${CARDS_NAME}`,
          `whole-folder ${WHOLE_NAME}`,
        ].sort()
      );

      // Each one chosen by the label a person would click, through the command
      // itself: this is what "brought back from the interface" means.
      for (const label of [WHOLE_NAME, CARDS_NAME, OWNER_FILE]) {
        const before = gripterm.said.length;
        gripterm.picker.chooseNext(label);
        await vscode.commands.executeCommand('gripterm.restoreFromTrash');
        const spoken = gripterm.said.slice(before);
        assert.ok(
          spoken.some((line) => line.startsWith(`Gripterm: "${label}" is back in the store`)),
          `nothing said that "${label}" came back: ${JSON.stringify(spoken)}`
        );
      }

      // The whole folder is in the store, history and all, and the record is
      // read again -- which is the half a return that only moved files would
      // not have earned.
      assert.equal(
        await readFile(join(store, 'terminals', WHOLE_TERMINAL, 'events', '2026-08-01.ndjson'), 'utf8'),
        '{"seq":1}\n'
      );
      await waitForRow(gripterm, WHOLE_TERMINAL, true);
      // The two cards landed IN the folder that stayed, beside its journal.
      assert.equal(await there(join(store, 'terminals', CARDS_TERMINAL, 'record.json')), true);
      assert.equal(
        await readFile(join(store, 'terminals', CARDS_TERMINAL, 'events', '2026-08-01.ndjson'), 'utf8'),
        '{"seq":1}\n'
      );
      await waitForRow(gripterm, CARDS_TERMINAL, true);
      // And the presence file is back where the sweep found it.
      assert.equal(await there(join(store, 'owners', OWNER_FILE)), true);

      // The batch is gone with the last thing in it: a batch left standing is a
      // claim that something is still in there.
      assert.equal(await there(batch), false);
      assert.deepEqual(
        (await gripterm.trash?.list())?.filter((item) => item.batch === BATCH),
        []
      );
    } finally {
      // Reversible by construction: everything here is of this test's own making.
      await rm(batch, { recursive: true, force: true });
      await rm(join(store, 'owners', OWNER_FILE), { force: true });
      await rm(join(store, 'terminals', WHOLE_TERMINAL), { recursive: true, force: true });
      await rm(join(store, 'terminals', CARDS_TERMINAL), { recursive: true, force: true });
    }

    // Left as it was found, for the suites that run after this one.
    await waitForRow(gripterm, WHOLE_TERMINAL, false);
    await waitForRow(gripterm, CARDS_TERMINAL, false);
  });
});
