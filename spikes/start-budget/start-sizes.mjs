/*
 * Which part of a start grows with the size of a store, and which stands still
 * (Ш22).
 *
 * **Why a harness and not the product.** The question is a CURVE, and a curve
 * needs the same thing measured over stores of several sizes. Driving a real
 * extension host per size costs a minute apiece and puts a real `claude` on the
 * machine each time; and the sizes worth asking about go up to thousands of
 * records, which no run of ours has ever had. So the parts that read the store
 * are run here directly -- the REAL `FileTerminalRepository`, the REAL
 * `FileOwnerPresence`, the REAL `BaseProjection`, the REAL `gatherRestoreInputs`
 * and `planRestore`, timed by the REAL `StartLedger` under the same phase names
 * the composition root uses. `tests/integration/start-breakdown.test.ts` is what
 * holds the other half: that the composition root prints these names at all.
 *
 * **What is NOT here, and it is left out rather than faked.** Bringing the
 * terminals back starts processes; a spike that did it would spawn a `claude`
 * per record. So `bringingTerminalsBack` has no row in the table below --
 * absent, not nought. `theAgentListing` is answered by a stub for the same kind
 * of reason: it asks the CLI about the conversations of whoever owns this
 * machine, and its cost is a fact about that CLI rather than about our store.
 * What it costs in a REAL start is in the integration log, which is where the
 * number in the report comes from.
 *
 *   node spikes/start-budget/start-sizes.mjs
 *   node spikes/start-budget/start-sizes.mjs --sizes 0,40,400,4000
 *   node spikes/start-budget/start-sizes.mjs --sizes 400 --slow theAgentListing 2000
 *
 * The last one is the positive control: a part is slowed on purpose, and the
 * breakdown must grow in THAT part and nowhere else -- the leftover included.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const core = require(join(REPO, 'packages', 'core', 'dist', 'index.js'));

const {
  BaseProjection,
  FileOwnerPresence,
  FileTerminalRepository,
  HookEventParser,
  OwnerId,
  SessionRegistry,
  StartLedger,
  StorageLayout,
  SystemClock,
  TerminalStateMachine,
  gatherRestoreInputs,
  planRestore,
  readTranscriptIndex,
} = core;

/**
 * How many conversations one project directory holds.
 *
 * Measured on this machine on 2026-08-12 and written down in
 * `readTranscriptIndex`: twelve project directories, 75 transcripts -- so about
 * six apiece. Eight is that, rounded to a number a reader can multiply.
 */
const TRANSCRIPTS_PER_PROJECT = 8;

/**
 * The sizes, and why these.
 *
 *   * **0** -- a machine where this build has never run. It is the control: what
 *     costs the same here as at 4000 does not depend on the store at all.
 *   * **40** -- the only number we have that stands for the owner's own machine.
 *     Ш11 measured the heartbeat storm "at W=4, R=40", so forty records is the
 *     scale that step was reasoning about.
 *   * **400** -- ten times that: a year of work, and the size at which a cost
 *     linear in the records is unmistakable even if forty of them is noise.
 *   * **4000** -- a hundred times, past any real machine on purpose. A part that
 *     is flat at 400 and flat here is flat.
 */
const SIZES = [0, 40, 400, 4000];

function chosen(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

const sizes = chosen('sizes', SIZES.join(','))
  .split(',')
  .map((one) => Number.parseInt(one, 10));
const slowAt = process.argv.indexOf('--slow');
const SLOW_PHASE = slowAt === -1 ? null : process.argv[slowAt + 1];
const SLOW_MS = slowAt === -1 ? 0 : Number.parseInt(process.argv[slowAt + 2], 10);

const silent = { info() {}, warn() {}, error() {} };
const clock = new SystemClock();
const wait = async (ms) => { await new Promise((wake) => { setTimeout(wake, ms); }); };

/** The delay the positive control injects, or nothing at all. */
async function perhapsSlow(phase) {
  if (phase === SLOW_PHASE && SLOW_MS > 0) {
    await wait(SLOW_MS);
  }
}

function uuid(seed) {
  return `00000000-0000-4000-8000-${seed.toString(16).padStart(12, '0')}`;
}

function recordFor(store, id, ownerId) {
  return {
    terminalId: id,
    sessionId: uuid(seedOf(id) + 2_000_000),
    sessionIdHistory: [],
    owner: { kind: 'window', ownerId, editorKind: 'vscode', workspaceFolder: null },
    metadata: { displayName: `record ${id}`, task: null, notes: [], tags: [], color: null },
    launch: {
      cwd: store,
      addDirs: [],
      permissionMode: null,
      agent: null,
      model: null,
      worktree: null,
      mcpConfigPaths: [],
      appendSystemPrompt: null,
      extraEnv: {},
    },
    createdAt: 1_786_500_000_000,
    closedAt: null,
    revision: 3,
  };
}

function seedOf(id) {
  return Number.parseInt(id.slice(-12), 16);
}

/**
 * A store with `howMany` records in it, and the CLI's transcripts to match.
 *
 * The records belong to windows that are GONE, which is the shape that makes the
 * planner do its full work on every one of them rather than skipping them as
 * somebody else's live business.
 */
function seed(store, transcripts, howMany) {
  rmSync(store, { recursive: true, force: true });
  rmSync(transcripts, { recursive: true, force: true });
  mkdirSync(join(store, 'terminals'), { recursive: true });
  mkdirSync(join(store, 'owners'), { recursive: true });
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
      // A different vanished window every eight records, so that the survey has
      // owners to ask about rather than one answer it can reuse.
      JSON.stringify(recordFor(store, id, `a-window-that-is-gone-${String(Math.floor(at / 8))}`)),
      'utf8'
    );
  }
  const projects = Math.ceil(howMany / TRANSCRIPTS_PER_PROJECT);
  for (let project = 0; project < projects; project += 1) {
    const directory = join(transcripts, 'projects', `D--projects-one-${String(project)}`);
    mkdirSync(directory, { recursive: true });
    for (let file = 0; file < TRANSCRIPTS_PER_PROJECT; file += 1) {
      const conversation = uuid(project * TRANSCRIPTS_PER_PROJECT + file + 2_000_001);
      writeFileSync(join(directory, `${conversation}.jsonl`), '{}\n', 'utf8');
    }
  }
}

/** How much of each run nobody times. See `measureOne`. */
const UNTIMED_MS = 20;

/** One start's worth of store reading, under the composition root's own names. */
async function measureOne(howMany) {
  const store = join(REPO, '.vscode-test', 'start-sizes', `store-${String(howMany)}`);
  const transcripts = join(REPO, '.vscode-test', 'start-sizes', `claude-${String(howMany)}`);
  seed(store, transcripts, howMany);

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
  const projection = new BaseProjection({ repository, registry, owner, logger: silent });

  const ledger = new StartLedger({ clock, wokeAtMs: clock.now().getTime() });
  // The composition nobody times, standing in for the objects a real activation
  // builds between its measured calls. A fixed cost, so that the positive
  // control can show the leftover NOT moving.
  await wait(UNTIMED_MS);
  // `shareTheBase`, as far as the store is concerned: this window announces
  // itself and then reads the whole base once.
  await ledger.measure('readingTheStore', async () => {
    await presence.announce({
      ownerId,
      kind: 'window',
      pid: process.pid,
      editorKind: 'vscode',
      editorVersion: '0.0.0-spike',
      workspaceFolders: [store],
    });
    await projection.refresh();
  });

  let inputs = null;
  await ledger.measure('readingTheMachine', async () => {
    inputs = await gatherRestoreInputs({
      repository,
      presence,
      windowFolders: [],
      readTranscripts: async () =>
        await ledger.measure('theTranscriptIndex', async () => {
          await perhapsSlow('theTranscriptIndex');
          return await readTranscriptIndex(join(transcripts, 'projects'));
        }),
      readAgents: async () =>
        await ledger.measure('theAgentListing', async () => {
          await perhapsSlow('theAgentListing');
          // A stub, and named as one: what the real one costs is a fact about
          // the CLI on the machine, not about the size of our store.
          return await Promise.resolve({ kind: 'running', agents: [] });
        }),
      nowMs: Date.now(),
      uptimeSeconds: 1_000_000,
      logger: silent,
    });
  });
  const plan = ledger.time('planningTheRestore', () => planRestore(inputs));

  return { howMany, breakdown: ledger.breakdown(), rows: registry.list().length, steps: plan.steps.length };
}

function padded(text, width) {
  return String(text).padStart(width, ' ');
}

async function main() {
  const results = [];
  for (const howMany of sizes) {
    // Twice, and the second one is the answer: the first pass over a directory
    // this process has just written pays for a cold cache, which is a fact about
    // this minute and not about the store.
    await measureOne(howMany);
    results.push(await measureOne(howMany));
  }

  const names = [];
  for (const one of results) {
    for (const phase of Object.keys(one.breakdown.phases)) {
      if (!names.includes(phase)) {
        names.push(phase);
      }
    }
  }

  if (SLOW_PHASE !== null) {
    console.log(`SLOWED ON PURPOSE: ${SLOW_PHASE} by ${String(SLOW_MS)} ms\n`);
  }
  const width = 12;
  console.log(`${'part'.padEnd(24, ' ')}${results.map((one) => padded(`${String(one.howMany)} rec`, width)).join('')}`);
  console.log('-'.repeat(24 + width * results.length));
  for (const phase of names) {
    const cells = results.map((one) => padded(one.breakdown.phases[phase] ?? '-', width)).join('');
    console.log(`${phase.padEnd(24, ' ')}${cells}`);
  }
  console.log(`${'the leftover'.padEnd(24, ' ')}${results.map((one) => padded(one.breakdown.remainderMs, width)).join('')}`);
  console.log('-'.repeat(24 + width * results.length));
  console.log(`${'the whole'.padEnd(24, ' ')}${results.map((one) => padded(one.breakdown.tookMs, width)).join('')}`);
  console.log(`${'rows in the list'.padEnd(24, ' ')}${results.map((one) => padded(one.rows, width)).join('')}`);
  console.log(`${'records to bring back'.padEnd(24, ' ')}${results.map((one) => padded(one.steps, width)).join('')}`);
  console.log('');
  for (const one of results) {
    const summed = Object.values(one.breakdown.phases).reduce((total, ms) => total + ms, 0);
    const adds = summed + one.breakdown.remainderMs === one.breakdown.tookMs;
    console.log(
      `${padded(one.howMany, 6)} records: ${String(summed)} + ${String(one.breakdown.remainderMs)}` +
      ` = ${String(one.breakdown.tookMs)} ${adds ? 'OK' : 'DOES NOT ADD UP'}`
    );
  }
}

await main();
