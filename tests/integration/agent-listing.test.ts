import * as assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import {
  findExecutable,
  parseAgentListing,
  parseCliVersion,
  probeVersionOutput,
  readAgentListing,
} from '../../packages/core/src/index';
import type { AgentListing, AgentRecord } from '../../packages/core/src/index';

/**
 * THE OTHER HALF OF THE COMPARISON: the same scene, asked of the real CLI.
 *
 * `tests/agents/comparison.test.ts` runs always and costs nothing -- it checks
 * that the recorded implementation of `AgentRoster` answers a captured scene the
 * way the CLI's own reader answers the capture. Nothing in it can notice the day
 * the CLI stops printing what was captured, and that day is not hypothetical:
 * the shape comes from an internal accounting format already in its fifth
 * version (A22). This file is what goes red instead.
 *
 * **The scene is the fixture's, not this file's**, and that is what the fixture
 * is for. Three session shapes are read out of
 * `tests/agents/fixtures/roster-scene-2026-08-27.json` -- one complete, one with
 * no `name` and no `status`, one that knows neither its directory (`"?"`) nor
 * its start (`0`) -- planted on live pids of this run, and the CLI's answer is
 * compared with what that same file says the CLI answered on 2026-08-27. There
 * is no module the two halves can import (this one is compiled into the
 * extension host, the other runs in jest), so what they share is the file.
 *
 * **The build is compared too, and it is the plan's own rule** -- "the version is
 * recorded; the installed `claude` moved and the comparison fails". A recording
 * taken from one build and replayed against another is a comparison of two
 * different things pretending to be one.
 *
 * **Nothing here is the owner's.** The sessions are planted into a
 * `CLAUDE_CONFIG_DIR` this run makes and deletes, on pids of processes this run
 * started; `~/.claude` is never read, never written, and never left with a file.
 * `procStart` is deliberately omitted: it is optional (measured), and fabricating
 * a process start time would be the one field here we could get wrong without
 * noticing.
 */

const CLAUDE = 'claude';
const GENEROUS_MS = 20_000;

/** `out/tests/integration` is three below the repository root. */
const REPO = join(__dirname, '..', '..', '..');
const SCENE_FILE = join(REPO, 'tests', 'agents', 'fixtures', 'roster-scene-2026-08-27.json');
const SCENE_NAME = 'tests/agents/fixtures/roster-scene-2026-08-27.json';

interface Scene {
  readonly build: string;
  /** What the CLI printed, verbatim. */
  readonly printed: string;
  /** The session files that were planted, in the order they were planted. */
  readonly planted: readonly Record<string, unknown>[];
  /** The live pids they were planted on, in that same order. */
  readonly pids: readonly number[];
}

interface Planted {
  readonly configDir: string;
  readonly alive: readonly ChildProcess[];
  /** The pid each entry of `scene.planted` was written for, in that order. */
  readonly pids: readonly number[];
}

async function theScene(): Promise<Scene> {
  return JSON.parse(await readFile(SCENE_FILE, 'utf8')) as Scene;
}

/**
 * The scene, planted.
 *
 * The file NAME has to be the pid -- measured 2026-08-27, and it cost a wrong
 * conclusion before it was measured: three shapes written under names of their
 * own came back as `[]`, which reads as "the CLI has stopped printing these" and
 * was nothing of the kind.
 */
async function plant(scene: Scene): Promise<Planted> {
  const configDir = join(tmpdir(), `gripterm-scene-${String(process.pid)}`);
  const sessions = join(configDir, 'sessions');
  await rm(configDir, { recursive: true, force: true });
  await mkdir(sessions, { recursive: true });

  const alive: ChildProcess[] = [];
  const pids: number[] = [];
  for (const body of scene.planted) {
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},120000)'], { stdio: 'ignore' });
    const pid = child.pid;
    assert.ok(pid !== undefined, 'a process this run started has no pid, so nothing here can be planted');
    alive.push(child);
    pids.push(pid);
    await writeFile(
      join(sessions, `${String(pid)}.json`),
      JSON.stringify({ pid, version: scene.build, peerProtocol: 1, entrypoint: 'cli', ...body }),
      'utf8'
    );
  }
  return { configDir, alive, pids };
}

async function unplant(planted: Planted): Promise<void> {
  for (const child of planted.alive) {
    // Only the processes this suite started, through the handle it started them
    // with. Nothing here goes near a list of processes.
    child.kill();
  }
  await rm(planted.configDir, { recursive: true, force: true });
}

function listed(listing: AgentListing): readonly AgentRecord[] {
  assert.ok(listing.kind === 'listed', JSON.stringify(listing));
  return listing.agents;
}

/**
 * One listing as something two readings can be compared by -- the same shape
 * `tests/agents/comparison.test.ts` builds, written out here because there is no
 * module both halves can import.
 *
 * The pid travels as its POSITION among the plantings rather than as itself:
 * this run gets whatever pids the machine hands it, and the capture holds the
 * ones another run was handed.
 */
function comparable(agents: readonly AgentRecord[], pids: readonly number[]): unknown[] {
  return [...agents]
    .map((agent) => ({
      sessionId: agent.sessionId.value,
      plantedAt: pids.indexOf(agent.pid ?? -1),
      cwd: agent.cwd,
      kind: agent.kind,
      startedAt: agent.startedAt,
      name: agent.name,
      status: agent.status,
    }))
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
}

async function theCli(): Promise<string> {
  const claude = await findExecutable(CLAUDE, {
    path: process.env.PATH,
    pathExt: process.env.PATHEXT,
    platform: process.platform,
  });
  // Not a skip. This extension exists to run Claude Code, and a machine without
  // it cannot make the claim this file is here to make -- so it says so rather
  // than passing quietly.
  assert.ok(claude !== null, 'Claude Code is not on the PATH this test inherited');
  return claude;
}

suite('reading what this machine is running', () => {
  test('the real CLI still prints the scene the recording beside it was taken from', async () => {
    const scene = await theScene();
    const claude = await theCli();
    const previous = process.env.CLAUDE_CONFIG_DIR;
    const planted = await plant(scene);
    process.env.CLAUDE_CONFIG_DIR = planted.configDir;

    try {
      const now = comparable(listed(await readAgentListing(claude, GENEROUS_MS)), planted.pids);
      // The capture read through the SAME reader, so that a difference here is a
      // difference in the CLI and never a difference between two parsers.
      const then = comparable(listed(parseAgentListing(scene.printed)), scene.pids);

      assert.deepEqual(
        now,
        then,
        `the CLI on this machine no longer prints the scene in ${SCENE_NAME}, so the recorded agent`
          + ' beside it is a copy of a CLI that no longer exists -- recapture the scene'
      );
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previous;
      }
      await unplant(planted);
    }
  });

  test('and it is the build the recording names, which is what makes the two halves one comparison', async () => {
    const scene = await theScene();
    const claude = await theCli();

    const installed = parseCliVersion((await probeVersionOutput(claude, GENEROUS_MS)).output ?? '');

    assert.equal(
      installed,
      scene.build,
      `the installed Claude Code is ${String(installed)} and the scene in ${SCENE_NAME} was captured`
        + ` from ${scene.build} -- recapture the scene against this build, or the fake is a copy of another one`
    );
  });
});
