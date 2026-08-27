/*
 * What bringing the terminals back costs, record by record (Ш23).
 *
 * **The question.** Ш22 measured an activation and found 87-92 % of it in
 * process spawns, and the step that follows was written around one guess: that
 * the spawns which matter are the `claude` per RESTORED RECORD, so that a person
 * with forty of them waits a minute. The product's own log already prices
 * `bringingTerminalsBack` at ONE record; nothing has ever priced it at five or
 * at ten, and nothing has ever said whether the records are brought back one
 * after another or all at once.
 *
 * **Why a harness rather than the host.** The number wanted is a SLOPE, and the
 * host's own spread swallows it: the same one-record restore measured 104, 115,
 * 126, 184, 194, 206, 221, 230, 269 and 3753 ms over ten runs of the two live
 * labels on 2026-08-27. A slope needs the same thing measured many times over
 * several sizes, which is minutes here and an hour there. And ten records in a
 * live host is ten real `claude` left running inside somebody's editor; here the
 * processes are this file's own and it ends them itself.
 *
 * **What is REAL in it.** `FileTerminalRepository`, `FileOwnerPresence`,
 * `SessionRegistry`, `TerminalLifecycleService`, `ClaudeCodeCommandFactory`,
 * `FileSessionSettingsStore`, `ProcessLaunchStrategy`, `gatherRestoreInputs`,
 * `planRestore`, `RestoreOrchestrator` and `StartLedger` -- the whole restore
 * path of the composition root, under the same phase names. What stands in is
 * the GATEWAY, and only in what it spawns: `--exe real` runs the `claude` the
 * command factory built, `--exe standin` runs a process that starts and waits,
 * and both go through the same `node-pty` the `own` engine uses. The editor's
 * engine cannot be reproduced outside a host at all; it is CHEAPER than this one
 * -- `vscode.window.createTerminal` returns before the process exists -- so a
 * cost measured here is an upper bound for it.
 *
 *   node spikes/start-budget/restore-shape.mjs --records 1,5,10
 *   node spikes/start-budget/restore-shape.mjs --records 1,5,10 --exe real
 *   node spikes/start-budget/restore-shape.mjs --records 5 --at-once 4
 *
 * `--at-once N` is the ceiling on how many records are brought back together.
 * `1` is the behaviour this file was written to measure.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const core = require(join(REPO, 'packages', 'core', 'dist', 'index.js'));

const {
  ClaudeCodeCommandFactory,
  FileOwnerPresence,
  FileSessionSettingsStore,
  FileTerminalRepository,
  HookEventParser,
  ListeningAddress,
  OwnerId,
  ProcessLaunchStrategy,
  RestoreOrchestrator,
  SessionRegistry,
  StartLedger,
  StorageLayout,
  SystemClock,
  TerminalStateMachine,
  gatherRestoreInputs,
  planRestore,
} = core;

/** Where `build:extension` leaves the native pty this spike spawns through. */
const NODE_PTY = join(REPO, 'packages', 'extension', 'assets', 'node-pty');

/** Everything this file writes, and the only directory it ever deletes. */
const GROUND = join(REPO, '.vscode-test', 'restore-shape');

function chosen(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

const SIZES = chosen('records', '1,5,10').split(',').map((one) => Number.parseInt(one, 10));
const ROUNDS = Number.parseInt(chosen('rounds', '3'), 10);
const AT_ONCE = Number.parseInt(chosen('at-once', '1'), 10);
const EXE = chosen('exe', 'standin');

/**
 * The `claude` of this machine, resolved rather than named.
 *
 * node-pty is handed an executable, not a command line, so a bare name would be
 * a spawn that fails on Windows -- and a failed spawn measured as a start is the
 * one mistake this file cannot make.
 */
function claudeOnThisMachine() {
  const found = execFileSync('where', ['claude'], { encoding: 'utf8' })
    .split(/\s+/u)
    .find((line) => line.trim().toLowerCase().endsWith('.exe'));
  if (found === undefined) {
    throw new Error('no claude.exe on the PATH this spike inherited');
  }
  return found.trim();
}

const REAL_CLAUDE = EXE === 'real' ? claudeOnThisMachine() : process.execPath;

const silent = { info() {}, warn() {}, error() {} };
const clock = new SystemClock();
const scheduler = {
  after(ms, action) {
    const timer = setTimeout(action, ms);
    return { dispose: () => { clearTimeout(timer); } };
  },
};

function uuid(seed) {
  return `00000000-0000-4000-8000-${seed.toString(16).padStart(12, '0')}`;
}

/**
 * A record of a window that is gone, holding a conversation nothing has heard
 * of.
 *
 * The same shape `tools/seed-restorable-record.mjs` lays for the live host, and
 * for its reasons: no transcript means the planner answers `launch` rather than
 * `--resume`, so nothing here can attach a second process to a real
 * conversation of anybody's. `CLAUDE_CONFIG_DIR` is pinned for the other half of
 * the same reason.
 */
function recordFor(store, id, ownerId) {
  return {
    terminalId: id,
    sessionId: uuid(Number.parseInt(id.slice(-12), 16) + 5_000_000),
    sessionIdHistory: [],
    owner: { kind: 'window', ownerId, editorKind: 'vscode', workspaceFolder: null },
    metadata: { displayName: `record ${id}`, task: null, notes: [], tags: [], color: null },
    launch: {
      // The ground rather than the store: a child holds its working directory
      // open, and the store of a size just measured has to be removable before
      // the next round can seed it.
      cwd: GROUND,
      addDirs: [],
      permissionMode: null,
      agent: null,
      model: null,
      worktree: null,
      mcpConfigPaths: [],
      appendSystemPrompt: null,
      extraEnv: { CLAUDE_CONFIG_DIR: join(store, 'claude-config') },
    },
    createdAt: 1_786_500_000_000,
    closedAt: null,
    revision: 3,
  };
}

function seed(store, howMany) {
  if (!store.includes(join('.vscode-test', 'restore-shape'))) {
    throw new Error(`refusing to empty a directory that is not this spike's own: ${store}`);
  }
  rmSync(store, { recursive: true, force: true });
  mkdirSync(join(store, 'terminals'), { recursive: true });
  mkdirSync(join(store, 'owners'), { recursive: true });
  mkdirSync(join(store, 'claude-config'), { recursive: true });
  writeFileSync(join(store, 'version'), '1', 'utf8');
  for (let at = 0; at < howMany; at += 1) {
    const id = uuid(at + 1);
    const directory = join(store, 'terminals', id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'observed.json'), JSON.stringify({
      state: 'ended',
      lastEventAt: 1_786_500_000_000,
      currentTool: null,
      lastAssistantMessage: null,
      cost: null,
      contextWindow: null,
      pid: null,
    }), 'utf8');
    writeFileSync(
      join(directory, 'record.json'),
      JSON.stringify(recordFor(store, id, 'a-window-that-is-gone')),
      'utf8'
    );
  }
}

/**
 * A gateway that really spawns, and writes down when.
 *
 * The two timestamps per record are the whole point: `bringingTerminalsBack` as
 * one number cannot say whether ten records were ten waits in a row or ten
 * starts at once, and the overlap between these intervals can.
 */
function spawningGateway(started) {
  const pty = EXE === 'none' ? null : require(NODE_PTY);
  const children = [];
  const handles = new Map();
  return {
    engine: 'own',
    children,
    async create(spec) {
      const openedAt = Date.now();
      const env = {};
      for (const [name, value] of Object.entries({ ...process.env, ...spec.env })) {
        if (value !== null && value !== undefined) {
          env[name] = String(value);
        }
      }
      if (EXE !== 'none') {
        const [command, args] = EXE === 'real'
          ? [spec.shellPath, [...spec.shellArgs]]
          : [process.execPath, ['-e', 'setTimeout(() => {}, 600000)']];
        const child = pty.spawn(command, args, {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd: spec.cwd,
          env,
        });
        children.push(child);
      }
      started.push({ terminalId: spec.terminalId.value, openedAt, closedAt: Date.now() });
      const child = children.at(-1) ?? null;
      const handle = {
        terminalId: spec.terminalId,
        processId: async () => await Promise.resolve(child?.pid ?? null),
        sendText() {},
        runLaunchCommand() {},
        show() {},
        rename() {},
        dispose() {},
        onDidClose: () => ({ dispose() {} }),
      };
      handles.set(spec.terminalId.value, handle);
      return await Promise.resolve(handle);
    },
    listKnown: () => [...handles.values()],
    handleFor: (terminalId) => handles.get(terminalId.value),
    dispose() {},
  };
}

/** One size, brought back for real, timed by the ledger the product uses. */
async function measureOne(howMany, round) {
  // A directory of its own per round: a pty child on Windows outlives its kill
  // by a moment, and a round that reused the name would race the last one's
  // handles rather than measure anything.
  const store = join(GROUND, `store-${String(howMany)}-${String(round)}`);
  seed(store, howMany);

  const layout = new StorageLayout(store);
  const ownerId = OwnerId.fromString(uuid(9001));
  const owner = { kind: 'window', ownerId, editorKind: 'vscode', workspaceFolder: null };
  const presence = new FileOwnerPresence({ layout, clock, logger: silent });
  const registry = new SessionRegistry({
    stateMachine: new TerminalStateMachine(),
    reader: new HookEventParser(),
    clock,
    logger: silent,
  });
  const repository = new FileTerminalRepository({ layout, owner, presence, clock, logger: silent });
  const started = [];
  const gateway = spawningGateway(started);
  const lifecycle = new core.TerminalLifecycleService({
    registry,
    gateway,
    commands: new ClaudeCodeCommandFactory({
      executablePath: REAL_CLAUDE,
      address: ListeningAddress.loopback(59_999),
      token: 'a-token-of-this-spike',
      sessionStart: null,
      settings: new FileSessionSettingsStore(layout),
    }),
    strategy: new ProcessLaunchStrategy(),
    ids: { newUuid: () => uuid(Math.floor(Math.random() * 1_000_000) + 700_000) },
    clock,
    owner,
    logger: silent,
  });
  const orchestrator = new RestoreOrchestrator({
    repository,
    registry,
    lifecycle,
    scheduler,
    logger: silent,
    atOnce: AT_ONCE,
  });

  await presence.announce({
    ownerId,
    kind: 'window',
    pid: process.pid,
    editorKind: 'vscode',
    editorVersion: '0.0.0-spike',
    workspaceFolders: [],
  });
  const inputs = await gatherRestoreInputs({
    repository,
    presence,
    windowFolders: [],
    readTranscripts: async () => await Promise.resolve({ kind: 'indexed', sessionIds: new Set(), skipped: 0 }),
    readAgents: async () => await Promise.resolve({ kind: 'running', agents: [] }),
    nowMs: Date.now(),
    uptimeSeconds: 1_000_000,
    logger: silent,
  });
  const ledger = new StartLedger({ clock, wokeAtMs: clock.now().getTime() });
  const plan = ledger.time('planningTheRestore', () => planRestore(inputs));
  const report = await ledger.measure('bringingTerminalsBack', async () => await orchestrator.run(plan));

  orchestrator.dispose();
  for (const child of gateway.children) {
    try {
      child.kill();
      if (child.pid !== undefined) {
        // Both, and on purpose: node-pty ends the pseudoconsole, and on Windows
        // the process behind it has been seen to outlive that. A spike that
        // leaves real processes on somebody's machine is not a measurement.
        process.kill(child.pid);
      }
    } catch {
      // A child that has already gone is a child that has already gone.
    }
  }
  // Windows lets go of a killed process's handles a moment after the kill, and
  // the next round starts by deleting the directory this one was writing in.
  await new Promise((wake) => { setTimeout(wake, 300); });

  const breakdown = ledger.breakdown();
  return {
    howMany,
    planned: plan.steps.length,
    started: report.started,
    skipped: plan.skipped.length,
    bringingTerminalsBack: breakdown.phases.bringingTerminalsBack,
    overlap: mostAtOnce(started),
    spawns: started.length,
  };
}

/**
 * The greatest number of starts in flight at one instant.
 *
 * `1` says the records were brought back one after another; anything higher says
 * they were not. Read off the intervals rather than from the code, because the
 * code is what is being asked about.
 */
function mostAtOnce(started) {
  const edges = [];
  for (const one of started) {
    edges.push({ at: one.openedAt, delta: 1 });
    edges.push({ at: one.closedAt, delta: -1 });
  }
  edges.sort((a, b) => (a.at === b.at ? a.delta - b.delta : a.at - b.at));
  let now = 0;
  let most = 0;
  for (const edge of edges) {
    now += edge.delta;
    most = Math.max(most, now);
  }
  return most;
}

function padded(text, width) {
  return String(text).padStart(width, ' ');
}

async function main() {
  console.log(`exe=${EXE} at-once=${String(AT_ONCE)} rounds=${String(ROUNDS)}\n`);
  const table = new Map();
  for (const howMany of SIZES) {
    const runs = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      runs.push(await measureOne(howMany, round));
    }
    table.set(howMany, runs);
  }

  console.log(`${'records'.padEnd(10)}${'planned'.padEnd(10)}${'started'.padEnd(10)}${'at once'.padEnd(10)}${'bringingTerminalsBack, ms'}`);
  console.log('-'.repeat(75));
  for (const [howMany, runs] of table) {
    const times = runs.map((one) => one.bringingTerminalsBack);
    const each = times.map((ms) => Math.round(ms / Math.max(1, howMany)));
    console.log(
      `${padded(howMany, 7)}   ${padded(runs[0].planned, 7)}   ${padded(runs[0].started, 7)}   `
      + `${padded(Math.max(...runs.map((one) => one.overlap)), 7)}   `
      + `${times.map((ms) => padded(ms, 6)).join('')}   (per record: ${each.map((ms) => padded(ms, 5)).join('')})`
    );
  }
  // The processes were killed as each size finished; this is the belt for the
  // braces, so that a spike that threw halfway does not leave a terminal behind.
  process.exit(0);
}

await main();
