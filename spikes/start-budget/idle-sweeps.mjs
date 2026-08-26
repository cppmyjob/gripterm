/*
 * What the new wiring COSTS, counted (Ш11).
 *
 * Cause 2's repair moves the out-of-turn sweep from this window's own repository
 * onto the store watcher's presence signal. That signal fires on every window's
 * heartbeat -- W times per pulse round in every one of W windows -- and each
 * wake calls `sweepIfStale`, which spawns `claude agents --json` when the floor
 * lets it through. So the obvious question is whether the repair traded one cost
 * for a worse one, and the obvious answer ("the floor is the interval, so no")
 * is exactly the kind of answer that has to be measured instead.
 *
 * Two runs, same length, same windows, one difference:
 *
 *   node spikes/start-budget/idle-sweeps.mjs --wired timer     (no presence signal)
 *   node spikes/start-budget/idle-sweeps.mjs --wired presence  (as it now is)
 *
 * The intervals are shortened by the same factor -- a beat every second against
 * a sweep every three, where the product beats every ten against a sweep every
 * thirty -- so a run takes twelve seconds instead of six minutes and the RATIO
 * being asked about is unchanged.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const core = require(join(REPO, 'packages', 'core', 'dist', 'index.js'));

const {
  FileOwnerPresence,
  FileTerminalRepository,
  OwnerHeartbeat,
  OwnerId,
  Reconciler,
  RepositoryWatcher,
  StorageLayout,
} = core;

/** The product's ten seconds and thirty seconds, divided by ten. */
const BEAT_MS = 1000;
const SWEEP_MS = 3000;
const FOR_MS = 12_000;
const WINDOWS = 3;
const RECORDS = 8;

function chosen(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

const WIRED = chosen('wired', 'presence');

const silent = { info() {}, warn() {}, error() {} };
const clock = { now: () => new Date() };
const scheduler = {
  after(ms, action) {
    const timer = setTimeout(action, ms);
    return { dispose: () => { clearTimeout(timer); } };
  },
};

function uuid(seed) {
  return `00000000-0000-4000-8000-${seed.toString(16).padStart(12, '0')}`;
}

function seed(store, howMany) {
  mkdirSync(join(store, 'terminals'), { recursive: true });
  mkdirSync(join(store, 'owners'), { recursive: true });
  writeFileSync(join(store, 'version'), '1', 'utf8');
  for (let at = 0; at < howMany; at += 1) {
    const id = uuid(at + 1);
    const directory = join(store, 'terminals', id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'observed.json'), JSON.stringify({
      state: 'ended', lastEventAt: 1_786_500_000_000, currentTool: null,
      lastAssistantMessage: null, cost: null, contextWindow: null, pid: null,
    }), 'utf8');
    writeFileSync(join(directory, 'record.json'), JSON.stringify({
      terminalId: id,
      sessionId: null,
      sessionIdHistory: [],
      owner: { kind: 'window', ownerId: 'a-window-that-is-gone', editorKind: 'vscode', workspaceFolder: null },
      metadata: { displayName: `record ${String(at)}`, task: null, notes: [], tags: [], color: null },
      launch: { cwd: store, addDirs: [], permissionMode: null, agent: null, model: null, worktree: null, mcpConfigPaths: [], appendSystemPrompt: null, extraEnv: {} },
      createdAt: 1_786_500_000_000 + at,
      closedAt: null,
      revision: 3,
    }), 'utf8');
  }
}

const wait = async (ms) => { await new Promise((wake) => { setTimeout(wake, ms); }); };

async function main() {
  const store = join(REPO, '.test-output', 'start-budget', `idle-${WIRED}`);
  rmSync(store, { recursive: true, force: true });
  seed(store, RECORDS);

  const windows = [];
  for (let at = 0; at < WINDOWS; at += 1) {
    const layout = new StorageLayout(store);
    const ownerId = OwnerId.fromString(uuid(2000 + at));
    const owner = { kind: 'window', ownerId, editorKind: 'vscode', workspaceFolder: null };
    const presence = new FileOwnerPresence({ layout, clock, logger: silent });
    const identity = {
      ownerId,
      kind: 'window',
      pid: process.pid,
      editorKind: 'vscode',
      editorVersion: '0.0.0-spike',
      workspaceFolders: [store],
    };
    const heartbeat = new OwnerHeartbeat({ presence, scheduler, logger: silent, intervalMs: BEAT_MS });
    await heartbeat.start(identity);
    const repository = new FileTerminalRepository({ layout, owner, presence, clock, logger: silent });

    const counted = { sweeps: 0 };
    const reconciler = new Reconciler({
      repository,
      registry: { own: () => [], ingest() {} },
      presence,
      self: ownerId,
      readAgents: async () => {
        counted.sweeps += 1;
        return await Promise.resolve({ kind: 'unavailable', reason: 'this spike counts the asking' });
      },
      isRunning: () => true,
      endProcess() {},
      clock,
      scheduler,
      logger: silent,
      intervalMs: SWEEP_MS,
      uptimeSeconds: () => 1_000_000,
    });
    const watcher = new RepositoryWatcher({ layout, scheduler, logger: silent });
    const woken = WIRED === 'presence'
      ? watcher.watchPresence(() => { void reconciler.sweepIfStale(); })
      : { dispose() {} };
    watcher.start();
    reconciler.start();
    windows.push({ counted, heartbeat, reconciler, watcher, woken });
  }

  await wait(FOR_MS);

  for (const one of windows) {
    one.reconciler.dispose();
    one.woken.dispose();
    one.watcher.dispose();
    await one.heartbeat.stop();
  }

  const sweeps = windows.reduce((sum, one) => sum + one.counted.sweeps, 0);
  console.log(`wiring                          : ${WIRED}`);
  console.log(`windows                         : ${String(WINDOWS)}, beating every ${String(BEAT_MS)} ms`);
  console.log(`sweep interval                  : ${String(SWEEP_MS)} ms, over ${String(FOR_MS)} ms`);
  console.log(`sweeps, all windows together    : ${String(sweeps)}`);
  console.log(`  per window                    : ${windows.map((one) => String(one.counted.sweeps)).join(', ')}`);
}

await main();
