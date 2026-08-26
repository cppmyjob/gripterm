/*
 * How many times an activation asks the CLI what is running, counted (Ш11,
 * causes 2 and 4).
 *
 * `claude agents --json` is a process spawn measured at 0.56-0.70 s (A24), and
 * a sweep runs one. Two things put extra ones on the path of an activation:
 *
 *   * the cross-window sweep is woken by THIS window's own repository, so every
 *     record the restore writes wakes it -- and the first wake finds no previous
 *     pass, so it is a full one, inside the restore (cause 2);
 *   * the composition root sweeps and then calls `start()`, which sweeps again
 *     (cause 4).
 *
 * Both are counted here against the real `Reconciler` and the real
 * `FileTerminalRepository`, with a `readAgents` that counts instead of spawning
 * -- the question is HOW MANY, and 0.6 s each is a number the plan already has.
 *
 *   node spikes/start-budget/activation-spawns.mjs --wired local
 *   node spikes/start-budget/activation-spawns.mjs --wired store
 *
 * `--wired local` is the wiring as it was: the sweep hangs off
 * `repository.watch`. `--wired store` is the wiring as it is: off the store
 * watcher's presence signal.
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
  OwnerId,
  Reconciler,
  RepositoryWatcher,
  SessionId,
  StorageLayout,
  TerminalId,
} = core;

/** Long enough for the watcher's 200 ms debounce and the sweep it starts. */
const SETTLE_MS = 1500;
const RECORDS = 8;

function chosen(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

const WIRED = chosen('wired', 'store');

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

function recordFor(store, id, ownerId) {
  return {
    terminalId: id,
    sessionId: null,
    sessionIdHistory: [],
    owner: { kind: 'window', ownerId, editorKind: 'vscode', workspaceFolder: null },
    metadata: { displayName: `record ${id}`, task: null, notes: [], tags: [], color: null },
    launch: { cwd: store, addDirs: [], permissionMode: null, agent: null, model: null, worktree: null, mcpConfigPaths: [], appendSystemPrompt: null, extraEnv: {} },
    createdAt: 1_786_500_000_000,
    closedAt: null,
    revision: 3,
  };
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
    writeFileSync(
      join(directory, 'record.json'),
      JSON.stringify(recordFor(store, id, 'a-window-that-is-gone')),
      'utf8'
    );
  }
}

const wait = async (ms) => { await new Promise((wake) => { setTimeout(wake, ms); }); };

async function main() {
  const store = join(REPO, '.test-output', 'start-budget', `spawns-${WIRED}`);
  rmSync(store, { recursive: true, force: true });
  seed(store, RECORDS);

  const layout = new StorageLayout(store);
  const ownerId = OwnerId.fromString(uuid(9001));
  const owner = { kind: 'window', ownerId, editorKind: 'vscode', workspaceFolder: null };
  const presence = new FileOwnerPresence({ layout, clock, logger: silent });
  await presence.announce({
    ownerId,
    kind: 'window',
    pid: process.pid,
    editorKind: 'vscode',
    editorVersion: '0.0.0-spike',
    workspaceFolders: [store],
  });
  const repository = new FileTerminalRepository({ layout, owner, presence, clock, logger: silent });

  let spawns = 0;
  const reconciler = new Reconciler({
    repository,
    registry: { own: () => [], ingest() {} },
    presence,
    self: ownerId,
    readAgents: async () => {
      spawns += 1;
      return await Promise.resolve({ kind: 'unavailable', reason: 'this spike counts the asking' });
    },
    isRunning: () => true,
    endProcess() {},
    clock,
    scheduler,
    logger: silent,
    uptimeSeconds: () => 1_000_000,
  });

  const watcher = new RepositoryWatcher({ layout, scheduler, logger: silent });
  const woken = WIRED === 'local'
    ? repository.watch(() => { void reconciler.sweepIfStale(); })
    : watcher.watchPresence(() => { void reconciler.sweepIfStale(); });
  watcher.start();

  // The restore, as far as this question is concerned: three records of our own
  // written into the base, which is what wakes a locally-wired sweep.
  const written = [];
  for (let at = 0; at < 3; at += 1) {
    const id = uuid(500 + at);
    await repository.write({
      terminalId: TerminalId.fromString(id),
      sessionId: SessionId.fromString(uuid(700 + at)),
      sessionIdHistory: [],
      owner,
      metadata: { displayName: `restored ${String(at)}`, task: null, notes: [], tags: [], color: null },
      launch: { cwd: store, addDirs: [], permissionMode: null, agent: null, model: null, worktree: null, mcpConfigPaths: [], appendSystemPrompt: null, extraEnv: {} },
      observed: { state: 'ended', lastEventAt: new Date(), currentTool: null, lastAssistantMessage: null, cost: null, contextWindow: null, pid: null },
      createdAt: new Date(),
      closedAt: null,
      revision: 1,
    });
    written.push(id);
  }
  await wait(SETTLE_MS);
  const insideTheRestore = spawns;

  // What the composition root then does: one pass, and `start()`.
  await reconciler.sweep();
  const afterTheSweep = spawns;
  reconciler.start();
  await wait(SETTLE_MS);
  const afterStart = spawns;

  reconciler.dispose();
  woken.dispose();
  watcher.dispose();

  console.log(`wiring of the out-of-turn sweep : ${WIRED}`);
  console.log(`records already in the store    : ${String(RECORDS)}`);
  console.log(`asks inside the restore         : ${String(insideTheRestore)}`);
  console.log(`asks after the activation sweep : ${String(afterTheSweep - insideTheRestore)}`);
  console.log(`asks that start() then added    : ${String(afterStart - afterTheSweep)}`);
  console.log(`asks in the whole activation    : ${String(afterStart)}`);
  console.log(`  at 0.56-0.70 s each           : ${String(Math.round(afterStart * 560))}-${String(Math.round(afterStart * 700))} ms`);
}

await main();
