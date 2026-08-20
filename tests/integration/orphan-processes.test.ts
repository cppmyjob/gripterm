import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, uptime } from 'node:os';
import type { GriptermApi } from '../../packages/extension/src/extension';

/**
 * The one act in this build that nothing takes back: ending somebody's process
 * (M3.5, O4).
 *
 * **Why it needs a real `claude` and cannot be done with a cheaper process.** The
 * guard that authorises the kill is the machine's OWN word -- `claude agents
 * --json` naming this conversation, at this pid -- so a stand-in process would
 * be refused by the very rule under test, and a test that never reached the kill
 * would be green about nothing. It is also the only way to see the other half:
 * that once the process is gone the CLI stops listing it, which is what makes
 * the restore of the same activation possible.
 *
 * **Why the pair of runs is the whole design of this test.** On Windows a pty
 * child dies with the pseudoconsole anyway (M3.2(7)), so "no process remains"
 * would be green with this step deleted -- the vacuum test of M1.5 and M2.11. So
 * the process here is NOT a child of anything that goes away, and the two runs
 * differ in exactly one character of one record: `engine`. The first run must
 * leave it running, the second must end it. Neither outcome is available to the
 * operating system by accident.
 *
 * **What it touches, said rather than left to be discovered.** One record and one
 * presence file, both of this test's own making, both removed in a `finally`.
 * One `claude` of its own, started and ended by it. And the pass itself runs
 * against the whole store, which is what it does in a person's window too --
 * with the difference that on a machine with no `own` records, which is every
 * machine until the setting is changed, there is nothing else it can consider.
 * The CLI is asked to trust `tmpdir()` if it has not been asked before, by the
 * same Enter a person presses; that is a line in the CLI's own configuration
 * and the one side effect this suite leaves behind.
 */

const DEAD_WINDOW = 'integration-window-that-left-a-process';
const DEAD_WINDOW_FILE = `${DEAD_WINDOW}.json`;
const ORPHAN_TERMINAL = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';
/** The conversation this test's own `claude` is started with, so the listing can be matched. */
const ORPHAN_SESSION = 'd5e6f7a8-9b0c-4d1e-8f2a-3b4c5d6e7f80';
/** The scaffold record the farewell test reads a launch recipe out of, and removes again. */
const RECIPE_TERMINAL = '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d';
const RECIPE_SESSION = '7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e';

type MadeGateway = ReturnType<GriptermApi['makeGateway']>;
type Spec = Parameters<MadeGateway['create']>[0];

/** A terminal id without the core's constructor, which a compiled suite cannot reach. */
function terminalIdOf(value: string): Spec['terminalId'] {
  return { value } as unknown as Spec['terminalId'];
}

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

function extensionPath(): string {
  const extension = vscode.extensions.getExtension('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return extension.extensionPath;
}

/** Everything the pass said, so a refusal can be read rather than assumed. */
class CollectedLog {
  public readonly lines: string[] = [];

  public info(message: string): void {
    this.lines.push(`info: ${message}`);
  }

  public warn(message: string): void {
    this.lines.push(`warn: ${message}`);
  }

  public error(message: string): void {
    this.lines.push(`error: ${message}`);
  }
}

/**
 * A presence file whose window is established gone, by arithmetic rather than by
 * a pid: a heartbeat older than the boot cannot have been written by anything
 * running now.
 */
function presenceJson(): string {
  const beforeBoot = Date.now() - uptime() * 1000 - 60_000;
  return JSON.stringify({
    ownerId: DEAD_WINDOW,
    kind: 'window',
    pid: process.pid,
    editorKind: 'vscode',
    editorVersion: '1.133.0',
    workspaceFolders: [],
    startedAt: beforeBoot,
    heartbeatAt: beforeBoot,
  });
}

function recordJson(now: number, engine: 'own' | 'editor'): string {
  return JSON.stringify({
    terminalId: ORPHAN_TERMINAL,
    sessionId: ORPHAN_SESSION,
    sessionIdHistory: [],
    owner: { kind: 'window', ownerId: DEAD_WINDOW, editorKind: 'vscode', workspaceFolder: null },
    metadata: {
      displayName: 'a terminal whose window went away',
      task: null,
      notes: [],
      tags: [],
      color: null,
    },
    launch: {
      cwd: tmpdir(),
      addDirs: [],
      permissionMode: null,
      agent: null,
      model: null,
      worktree: null,
      mcpConfigPaths: [],
      appendSystemPrompt: null,
      extraEnv: {},
    },
    engine,
    createdAt: now,
    closedAt: null,
    revision: 1,
  });
}

/** The same shape with nothing running: what a record that has never been started looks like. */
function noProcessJson(now: number): string {
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

function observedJson(now: number, pid: number): string {
  return JSON.stringify({
    state: 'idle',
    lastEventAt: now,
    currentTool: null,
    lastAssistantMessage: null,
    cost: null,
    contextWindow: null,
    pid,
  });
}

/** Whether a process answers, by the table §4.8 is built on. */
function stillThere(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause: unknown) {
    return (cause as { readonly code?: unknown }).code !== 'ESRCH';
  }
}

/** What the machine says is running, asked the way the product asks it. */
function listedSessions(cliPath: string): readonly { sessionId?: string, pid?: number }[] {
  const output = execFileSync(cliPath, ['agents', '--json'], { encoding: 'utf8', timeout: 30_000 });
  return JSON.parse(output) as readonly { sessionId?: string, pid?: number }[];
}

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Waits for something to become true, and says what it was still waiting for when it gave up. */
async function waitFor(what: string, answer: () => boolean, withinMs = 30_000): Promise<void> {
  const deadline = Date.now() + withinMs;
  while (!answer()) {
    if (Date.now() > deadline) {
      throw new Error(`waited ${String(withinMs)} ms for ${what}`);
    }
    await pause(100);
  }
}

/** Waits until there is something to be had, and hands it back. */
async function waitUntil<T>(what: string, answer: () => T | null, withinMs = 30_000): Promise<T> {
  const deadline = Date.now() + withinMs;
  for (;;) {
    const found = answer();
    if (found !== null) {
      return found;
    }
    if (Date.now() > deadline) {
      throw new Error(`waited ${String(withinMs)} ms for ${what}`);
    }
    await pause(100);
  }
}

type Entry = Awaited<ReturnType<GriptermApi['lifecycle']['launch']>>;

/** A record for the recipe below: no process, and an owner nothing is going to hear from. */
function recipeJson(now: number): string {
  return JSON.stringify({
    terminalId: RECIPE_TERMINAL,
    sessionId: RECIPE_SESSION,
    sessionIdHistory: [],
    owner: {
      kind: 'window',
      ownerId: 'integration-window-that-lent-a-recipe',
      editorKind: 'vscode',
      workspaceFolder: null,
    },
    metadata: { displayName: 'a record lent for its recipe', task: null, notes: [], tags: [], color: null },
    launch: {
      cwd: tmpdir(),
      addDirs: [],
      permissionMode: null,
      agent: null,
      model: null,
      worktree: null,
      mcpConfigPaths: [],
      appendSystemPrompt: null,
      extraEnv: {},
    },
    engine: 'editor',
    createdAt: now,
    closedAt: null,
    revision: 1,
  });
}

/**
 * A launch recipe, read out of the store rather than built.
 *
 * `LaunchRecipe` is a class of the core, and a compiled integration suite cannot
 * reach the core's constructors: it resolves `@gripterm/core` through
 * `node_modules`, which an installed extension has none of. What it CAN do is
 * read one back through the repository this window is using -- the same object
 * that will read the record the launch below writes.
 *
 * The scaffold is removed before the launch returns it, so that nothing of this
 * test's making is in the store while a real terminal of its own is running. It
 * says `engine: editor` and carries no pid on purpose: for the second it exists
 * it must be something no sweep would act on.
 */
async function recipeFromStore(gripterm: GriptermApi): Promise<Entry['launch']> {
  const { repository, readiness } = gripterm;
  assert.ok(repository, 'this window is not reading the shared store');
  const directory = join(readiness.storageDir, 'terminals', RECIPE_TERMINAL);
  try {
    const now = Date.now();
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'record.json'), recipeJson(now), 'utf8');
    await writeFile(join(directory, 'observed.json'), noProcessJson(now), 'utf8');
    const entry = (await repository.readAll()).find((one) => one.terminalId.value === RECIPE_TERMINAL);
    assert.ok(entry, 'the scaffold record this test wrote is not readable');
    return entry.launch;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Everything a launch of this test's own left in the person's store, trash included. */
async function cleanStore(storageDir: string, terminalId: string): Promise<void> {
  await rm(join(storageDir, 'terminals', terminalId), { recursive: true, force: true });
  const trash = join(storageDir, 'trash');
  for (const stamp of await readdir(trash).catch(() => [])) {
    await rm(join(trash, stamp, terminalId), { recursive: true, force: true });
    const left = await readdir(join(trash, stamp)).catch(() => ['keep']);
    if (left.length === 0) {
      await rm(join(trash, stamp), { recursive: true, force: true });
    }
  }
}

suite('the processes of windows that are gone', () => {
  test('a record left by a dead window keeps its process under `editor` and loses it under `own`', async () => {
    const gripterm = await api();
    const { reconciler, readiness } = gripterm;
    assert.ok(reconciler, 'this window is not reading the shared store');
    const { cliPath } = readiness;
    assert.notEqual(cliPath, null, 'claude was not found on PATH, and this test is about a real one');

    const log = new CollectedLog();
    const gateway: MadeGateway = gripterm.makeGateway({
      setting: 'own',
      mode: 'process',
      location: 'panel',
      extensionPath: extensionPath(),
      editor: { termProgram: 'vscode', termProgramVersion: vscode.version },
      // The default: this suite is not about the channel to the other extension.
      ideChannel: false,
      logger: log,
    });
    assert.equal(gateway.engine, 'own', `the own engine did not come up: ${log.lines.join(' | ')}`);

    const owners = join(readiness.storageDir, 'owners');
    const terminal = join(readiness.storageDir, 'terminals', ORPHAN_TERMINAL);
    let pid: number | null = null;

    try {
      const handle = await gateway.create({
        terminalId: terminalIdOf(ORPHAN_TERMINAL),
        name: 'a terminal whose window went away',
        cwd: tmpdir(),
        // The nine markers of the Claude Code run that may have started this
        // editor. Left in, the CLI writes no transcript and no history (A28) --
        // and, measured on the way to A43, does not appear in its own listing
        // either, which would take this test's evidence away.
        env: {
          CLAUDE_CODE_CHILD_SESSION: null,
          CLAUDECODE: null,
          CLAUDE_CODE_ENTRYPOINT: null,
          CLAUDE_CODE_SESSION_ID: null,
          CLAUDE_CODE_SSE_PORT: null,
          CLAUDE_CODE_EXECPATH: null,
          CLAUDE_PID: null,
          CLAUDE_ENV_FILE: null,
          CLAUDE_PROJECT_DIR: null,
        },
        shellPath: cliPath ?? '',
        shellArgs: ['--session-id', ORPHAN_SESSION],
      });
      pid = await handle.processId();
      assert.ok(pid !== null && pid > 0, 'the agent has no pid, so nothing could be confirmed about it');

      const { screen } = handle;
      assert.ok(screen, 'the own engine has no screen');
      let drawn = '';
      const data = screen.onData((chunk) => {
        drawn += chunk;
      });
      let answeredTrust = false;
      // Measured 2026-08-17 (A43): the CLI lists a session three seconds after
      // it starts, with nothing said in it. This is a ceiling for a machine
      // under load, kept inside the suite's own two minutes.
      const deadline = Date.now() + 60_000;
      for (;;) {
        const listed = listedSessions(cliPath ?? '').some((one) => one.sessionId === ORPHAN_SESSION);
        if (listed) {
          break;
        }
        assert.ok(
          Date.now() < deadline,
          `the CLI never listed this test's own session. Screen: ${JSON.stringify(drawn.slice(-400))}`
        );
        if (!answeredTrust && drawn.includes('trust')) {
          // The folder dialog, answered by its own default -- "Yes, I trust this
          // folder" is the selected line. Measured 2026-08-17: until it is
          // answered the session does not exist to the CLI at all, so without
          // this the pass under test would have nothing to confirm.
          screen.write('\r');
          answeredTrust = true;
        }
        await pause(1000);
      }
      data.dispose();

      // The record and its window, written as the window that died would have
      // left them -- except for the engine, which this test moves.
      const now = Date.now();
      await mkdir(terminal, { recursive: true });
      await mkdir(owners, { recursive: true });
      await writeFile(join(owners, DEAD_WINDOW_FILE), presenceJson(), 'utf8');
      await writeFile(join(terminal, 'observed.json'), observedJson(now, pid), 'utf8');
      await writeFile(join(terminal, 'record.json'), recordJson(now, 'editor'), 'utf8');

      const underEditor = await reconciler.endOrphanedProcesses();

      assert.deepEqual(underEditor.ended, [], 'a terminal the editor made was ended');
      assert.equal(stillThere(pid), true, 'the process of an `editor` record was ended');

      await writeFile(join(terminal, 'record.json'), recordJson(now, 'own'), 'utf8');

      const underOwn = await reconciler.endOrphanedProcesses();

      assert.deepEqual(
        underOwn.ended,
        [ORPHAN_TERMINAL],
        `the process was not ended: ${JSON.stringify(underOwn)}`
      );
      assert.equal(stillThere(pid), false, 'the pass reported an ending that did not happen');
      // The half that (д) is for: both gates of a restore read the machine
      // straight after this returns, and one of them is this listing.
      assert.equal(
        listedSessions(cliPath ?? '').some((one) => one.sessionId === ORPHAN_SESSION),
        false,
        'the CLI still lists a conversation whose process this pass ended'
      );
      // And the record is left exactly where it was: a window that ends a
      // process is not a person closing a terminal (П7).
      const entry = (await gripterm.repository?.readAll())?.find(
        (one) => one.terminalId.value === ORPHAN_TERMINAL
      );
      assert.ok(entry, 'the record was taken away by a pass that only ends processes');
      assert.equal(entry.closedAt, null);
      assert.equal(entry.isRestorable(), true);
    } finally {
      if (pid !== null && stillThere(pid)) {
        process.kill(pid, 'SIGKILL');
      }
      gateway.dispose();
      await rm(join(owners, DEAD_WINDOW_FILE), { force: true });
      await rm(terminal, { recursive: true, force: true });
    }
  });

  test('a window leaving ends the processes it made itself, and only those', async () => {
    /*
     * The composed farewell, run rather than read: this is the function
     * `deactivate` calls, holding the gateway this window is really using and the
     * records it really holds.
     *
     * **It is the one act the two engines answer OPPOSITELY**, which is why the
     * suite is run twice under M3.10 and why both halves are said here. Under
     * `editor` it ends nothing and disposes nothing: those terminals are the
     * editor's, and a `claude` in one of them outlives the extension host on
     * purpose (O5, M2.16). Under `own` the pty belongs to this window and goes
     * with it -- as a WINDOW LEAVING (`we-are-shutting-down`) and not as a
     * terminal being closed, because every reload would otherwise stamp
     * `closedAt` on every conversation and bring none of them back (P7).
     *
     * **Written with a terminal of its own rather than with an empty window.**
     * The shape this replaced asserted "ended nothing" under `editor` with
     * nothing running at all, which is equally true of a build that ends
     * everything -- the vacuum test M1.5 and M2.11 both met. So it starts a real
     * agent through the composed lifecycle, the path the button takes, and ends
     * it before returning whichever engine ran it. It is never spoken to: it
     * costs a conversation in the CLI's own store and no tokens.
     */
    const gripterm = await api();
    const { readiness, registry, lifecycle } = gripterm;
    assert.notEqual(readiness.cliPath, null, 'claude was not found on PATH, and this test starts a real one');

    const started = await lifecycle.launch({
      displayName: 'a terminal its own window made',
      recipe: await recipeFromStore(gripterm),
    });
    const { terminalId } = started;
    let startedPid: number | null = null;
    try {
      const running = await waitUntil(
        'the record to name the process it started',
        () => registry.get(terminalId)?.observed.pid ?? null
      );
      startedPid = running;
      assert.equal(stillThere(running), true, 'the agent this test started was not running');

      const report = gripterm.endOwnProcesses();

      if (readiness.engine === 'editor') {
        assert.deepEqual(report.ended, [], 'a window ended a process that was not its to end');
        assert.deepEqual(report.refused, []);
        assert.equal(stillThere(running), true, 'a terminal of the editor was ended by a window leaving');
      } else {
        assert.deepEqual(
          report.ended,
          [running],
          `the window left without ending the process it started: ${JSON.stringify(report)}`
        );
        await waitFor('the process to go', () => !stillThere(running));
        /*
         * Waited for by the RECORD hearing about it, not by the process being
         * gone. The two are a tenth of a second apart -- the pty reports its exit
         * after it has happened -- and asserting in that gap is asserting on a
         * record nothing has told yet: the first version of this test read
         * `closedAt` there and passed against a build that stamped it (L3b of the
         * battery, 2026-08-18).
         */
        await waitFor(
          'the record to hear that its terminal ended',
          () => registry.get(terminalId)?.observed.state === 'ended'
        );
        // And it is left where a restore can find it, which is the half P7
        // stands on: a window leaving is not a person closing anything.
        const left = registry.get(terminalId);
        assert.ok(left, 'the record went away with the window that was leaving');
        assert.equal(left.closedAt, null, 'a window leaving closed a conversation it is expected to bring back');
        assert.equal(left.isRestorable(), true);
      }
    } finally {
      if (readiness.engine === 'own') {
        // Off the strip, as the cross on its tab does: a tab left behind stays
        // on the panel for the rest of the run, and the suites after this one
        // count it (M3.9).
        gripterm.stage.removed(terminalId.value);
      } else if (registry.knows(terminalId)) {
        lifecycle.close(terminalId);
      }
      await waitFor(
        'this window to let go of the terminal',
        () => !gripterm.gateway.listKnown().some((one) => one.terminalId.value === terminalId.value)
      ).catch(() => null);
      if (startedPid !== null && stillThere(startedPid)) {
        process.kill(startedPid, 'SIGKILL');
      }
      lifecycle.discard(terminalId);
      // Long enough for the writer's own deletion to have gone through, so this
      // and it are not racing over the same directory.
      await pause(1000);
      await cleanStore(readiness.storageDir, terminalId.value);
    }
  });
});
