/*
 * How many full reads of the base the presence pulse costs, counted rather than
 * argued about (Ш11, cause 1).
 *
 * The plan states the arithmetic: `owners/` is watched, only journal paths are
 * filtered out, so every window's heartbeat wakes every window's watcher and
 * each wake is one `readAll()` of the whole store. At W windows that is W x W
 * full reads per pulse round, and there are six rounds a minute.
 *
 * This composes the real objects -- `FileOwnerPresence`, `RepositoryWatcher`,
 * `BaseProjection`, `FileTerminalRepository` -- against a real directory of the
 * run's own, beats each simulated window once, and counts. Nothing here is a
 * mock of the file system: the whole question is what the platform reports.
 *
 * **It carries its own positive control.** A watcher that never fires would
 * report nought reads and look like a fix. So after the beats it touches one
 * `record.json` and counts the wakes THAT produces: a run whose control is
 * nought is a run that measured nothing, and it says so and exits non-zero.
 *
 *   node spikes/start-budget/idle-reads.mjs --windows 4 --records 40
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const core = require(join(REPO, 'packages', 'core', 'dist', 'index.js'));

const {
  BaseProjection,
  FileOwnerPresence,
  FileTerminalRepository,
  OwnerId,
  RepositoryWatcher,
  StorageLayout,
} = core;

/** Far enough apart that the watcher's 200 ms debounce cannot absorb two beats. */
const BETWEEN_BEATS_MS = 350;
/** Long enough for the debounce to fire and the read it starts to finish. */
const SETTLE_MS = 1200;

function argument(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : Number(process.argv[at + 1]);
}

const WINDOWS = argument('windows', 4);
const RECORDS = argument('records', 40);

const silent = { info() {}, warn() {}, error() {} };
const clock = { now: () => new Date() };
const scheduler = {
  after(ms, action) {
    const timer = setTimeout(action, ms);
    return { dispose: () => { clearTimeout(timer); } };
  },
};

function uuid(seed) {
  const hex = seed.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

function seed(store, howMany) {
  mkdirSync(join(store, 'terminals'), { recursive: true });
  mkdirSync(join(store, 'owners'), { recursive: true });
  writeFileSync(join(store, 'version'), '1', 'utf8');
  const ids = [];
  for (let at = 0; at < howMany; at += 1) {
    const id = uuid(at + 1);
    ids.push(id);
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
  return ids;
}

/** One simulated window: what `shareTheBase` builds, and a counter around the read. */
function openWindow(store, ordinal) {
  const layout = new StorageLayout(store);
  const ownerId = OwnerId.fromString(uuid(1000 + ordinal));
  const owner = { kind: 'window', ownerId, editorKind: 'vscode', workspaceFolder: null };
  const presence = new FileOwnerPresence({ layout, clock, logger: silent });
  const repository = new FileTerminalRepository({ layout, owner, presence, clock, logger: silent });

  const counted = { reads: 0, ms: 0 };
  const watched = {
    readAll: async () => {
      const at = Date.now();
      try {
        return await repository.readAll();
      } finally {
        counted.reads += 1;
        counted.ms += Date.now() - at;
      }
    },
  };

  const projection = new BaseProjection({
    repository: watched,
    registry: { replaceForeign() {} },
    owner,
    logger: silent,
  });
  const watcher = new RepositoryWatcher({ layout, scheduler, logger: silent });
  watcher.watch(() => { void projection.refresh(); });
  watcher.start();

  return {
    ordinal,
    counted,
    identity: {
      ownerId,
      kind: 'window',
      pid: process.pid,
      editorKind: 'vscode',
      editorVersion: '0.0.0-stand',
      workspaceFolders: [store],
    },
    presence,
    close: () => {
      watcher.dispose();
      projection.dispose();
    },
  };
}

const wait = async (ms) => { await new Promise((wake) => { setTimeout(wake, ms); }); };

async function main() {
  const store = join(REPO, '.test-output', 'start-budget', `w${String(WINDOWS)}-r${String(RECORDS)}`);
  rmSync(store, { recursive: true, force: true });
  const ids = seed(store, RECORDS);

  const windows = [];
  for (let at = 0; at < WINDOWS; at += 1) {
    const one = openWindow(store, at);
    await one.presence.announce(one.identity);
    windows.push(one);
  }
  // The announcements themselves are writes into `owners/`. They are not what is
  // being measured, so the settle below absorbs them and the counters are then
  // taken back to nought.
  await wait(SETTLE_MS);
  for (const one of windows) {
    one.counted.reads = 0;
    one.counted.ms = 0;
  }

  const startedAt = Date.now();
  for (const one of windows) {
    await one.presence.heartbeat();
    await wait(BETWEEN_BEATS_MS);
  }
  await wait(SETTLE_MS);
  const pulseMs = Date.now() - startedAt;

  const reads = windows.reduce((sum, one) => sum + one.counted.reads, 0);
  const insideMs = windows.reduce((sum, one) => sum + one.counted.ms, 0);
  for (const one of windows) {
    one.counted.reads = 0;
    one.counted.ms = 0;
  }

  // The positive control: a change to a RECORD must still wake every window.
  const first = ids[0];
  writeFileSync(
    join(store, 'terminals', first, 'record.json'),
    JSON.stringify({
      terminalId: first,
      sessionId: null,
      sessionIdHistory: [],
      owner: { kind: 'window', ownerId: 'a-window-that-is-gone', editorKind: 'vscode', workspaceFolder: null },
      metadata: { displayName: 'renamed by the control', task: null, notes: [], tags: [], color: null },
      launch: { cwd: store, addDirs: [], permissionMode: null, agent: null, model: null, worktree: null, mcpConfigPaths: [], appendSystemPrompt: null, extraEnv: {} },
      createdAt: 1_786_500_000_001,
      closedAt: null,
      revision: 4,
    }),
    'utf8'
  );
  await wait(SETTLE_MS);
  const control = windows.reduce((sum, one) => sum + one.counted.reads, 0);

  for (const one of windows) {
    one.close();
  }

  // Six rounds a minute, because `HEARTBEAT_INTERVAL_MS` is ten seconds. NOT
  // extrapolated from `pulseMs`: this run compresses the beats on purpose, so a
  // rate taken from its own clock would be a number about the harness.
  const ROUNDS_PER_MINUTE = 6;
  const perMinute = reads * ROUNDS_PER_MINUTE;
  console.log(`windows                        : ${String(WINDOWS)}`);
  console.log(`records in the store           : ${String(RECORDS)}`);
  console.log(`one pulse round took           : ${String(pulseMs)} ms`);
  console.log(`full base reads in that round  : ${String(reads)}`);
  console.log(`  time spent inside them       : ${String(insideMs)} ms`);
  console.log(`at the real 10 s cadence       : ${String(perMinute)} full reads/min`);
  console.log(`control: reads after ONE record changed: ${String(control)} (must be ${String(WINDOWS)})`);
  if (control < WINDOWS) {
    console.log('THE CONTROL FAILED: this watcher does not report record changes, so the number above measures nothing.');
    process.exitCode = 1;
  }
}

await main();
