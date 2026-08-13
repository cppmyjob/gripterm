/*
 * П2 and О3, run rather than described.
 *
 * П2: a person writes a terminal a task and a note, closes the editor
 * completely, opens it again -- the list comes back, the conversations are
 * resumed through `--resume`, the task and the notes are where they were, and
 * nobody typed `claude --resume <id>` by hand.
 * О3: a full restart creates no duplicate terminal.
 *
 * Three sittings, three processes, because "closes the editor completely" cannot
 * be done inside one:
 *
 *   1. a test host, which opens the terminal and holds the conversation
 *      (`p2-first-window.test.ts`);
 *   2. a real editor in development mode, where ACTIVATION restores -- a test
 *      host is forbidden to (`bringTerminalsBack`), and the whole point of П2 is
 *      that nobody asked for it;
 *   3. the same again, which is О3.
 *
 * What it costs, said out loud: one real turn on the person's account in the
 * first sitting, and one `--resume` per sitting after it. What it does NOT touch
 * is the person's store -- everything lives under a temporary directory, and the
 * first sitting refuses to run if that did not take effect.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BASE = join(tmpdir(), 'gripterm-acceptance');
const PROJECT = join(BASE, 'project');
const STORE = join(BASE, 'store');
const USER_DATA = join(BASE, 'user-data');
const EXTENSIONS = join(BASE, 'extensions');
const EXTENSION = join(REPO, 'packages', 'extension');

const CODE = join(
  process.env.LOCALAPPDATA ?? '',
  'Programs',
  'Microsoft VS Code',
  'Code.exe'
);

const RESTORE_WITHIN_MS = 120_000;
const CLOSES_WITHIN_MS = 60_000;
const QUIETENS_WITHIN_MS = 120_000;
const POLL_MS = 500;

if (process.env.GRIPTERM_ACCEPTANCE !== 'yes') {
  console.error(
    [
      'This run starts a real editor and a real `claude`, and spends a real turn',
      'on whoever is logged in. Set GRIPTERM_ACCEPTANCE=yes to mean it.',
    ].join('\n')
  );
  process.exit(1);
}

// --- the plumbing ------------------------------------------------------------

/**
 * A path as it can be pasted inside a PowerShell single-quoted `-like` pattern.
 *
 * Backslashes are NOT doubled, and that is the correction of a defect this stand
 * had for one run: `-like` treats a backslash literally, so a doubled one
 * matched nothing, `editorProcesses()` found no window, and the run closed
 * NOTHING while reporting that everything had closed -- which read, further
 * down, as "the CLI will not stop listing this conversation". A quote in a
 * directory name would end the string early, so that one is escaped.
 */
function quoted(path) {
  const quote = '\'';
  return path.replaceAll(quote, quote + quote);
}

function powershell(script) {
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
  }).trim();
}

async function until(what, ready, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const answer = await ready();
    if (answer !== null) {
      return answer;
    }
    if (Date.now() > deadline) {
      throw new Error(`gave up waiting for ${what} after ${ms} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** Every record in the acceptance store, as it is on disk. */
function records() {
  const dir = join(STORE, 'terminals');
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir).flatMap((id) => {
    const file = join(dir, id, 'record.json');
    if (!existsSync(file)) {
      return [];
    }
    return [{ id, record: JSON.parse(readFileSync(file, 'utf8')) }];
  });
}

/** The journal of one terminal, every day of it, as lines. */
function journal(id) {
  const dir = join(STORE, 'terminals', id, 'events');
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .flatMap((day) => readFileSync(join(dir, day), 'utf8').split(/\r?\n/u))
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/**
 * The conversations the CLI counts as running in the acceptance project.
 *
 * Asked of the CLI rather than of the process table, and measured rather than
 * assumed: `claude.exe` reports NO arguments at all in `Win32_Process`
 * (2026-08-13), so a filter on `--settings <our store>` matches nothing however
 * many of them are running. The CLI's own list carries `cwd`, which cannot
 * reach a conversation of the person's own.
 */
function runningHere() {
  const out = execFileSync('claude', ['agents', '--json'], { encoding: 'utf8', shell: true });
  return JSON.parse(out).filter((one) => String(one.cwd ?? '').toLowerCase().includes('gripterm-acceptance'));
}

/** The editor windows started by this run, found by the user data directory nobody else uses. */
function editorProcesses() {
  const needle = quoted(USER_DATA);
  const out = powershell(
    `@(Get-CimInstance Win32_Process -Filter "Name='Code.exe'" |` +
      ` Where-Object { $_.CommandLine -like '*${needle}*' -and $_.CommandLine -notlike '*--type=*' })` +
      ` | ForEach-Object { $_.ProcessId }`
  );
  return out.length === 0 ? [] : out.split(/\r?\n/u).map((line) => Number(line.trim()));
}

/**
 * Whether the CLI still counts a conversation as running.
 *
 * This is the same list the restore predicate asks (§6, A24), and it does not go
 * quiet the moment the editor does: measured 2026-08-13, a sitting started three
 * seconds after the previous one closed was refused with `session-running`. The
 * refusal is the guard working -- two processes on one conversation is the thing
 * ownership exists to prevent -- so the stand waits for the CLI to agree that the
 * conversation is over, and prints how long that took.
 */
function listedAsRunning(sessionId) {
  return runningHere().some((one) => one.sessionId === sessionId);
}

/**
 * What the window itself said, from the log the editor persists for every output
 * channel. The only way to read a development window's mind after it has closed.
 */
function extensionLog() {
  const logs = join(USER_DATA, 'logs');
  const runs = existsSync(logs) ? readdirSync(logs).sort() : [];
  const last = runs.at(-1);
  if (last === undefined) {
    return [];
  }
  const file = join(logs, last, 'window1', 'exthost', 'gripterm-placeholder.gripterm', 'Gripterm.log');
  return existsSync(file)
    ? readFileSync(file, 'utf8').split(/\r?\n/u).filter((line) => line.trim().length > 0)
    : [];
}

/** A window closed the way a person closes it, not killed: deactivation has to run. */
function closeEditors() {
  for (const pid of editorProcesses()) {
    powershell(
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue;` +
        ` if ($p) { $null = $p.CloseMainWindow() }`
    );
  }
}

// --- the sittings ------------------------------------------------------------

function prepare() {
  rmSync(BASE, { recursive: true, force: true });
  mkdirSync(PROJECT, { recursive: true });
  mkdirSync(STORE, { recursive: true });
  mkdirSync(join(USER_DATA, 'User'), { recursive: true });
  mkdirSync(EXTENSIONS, { recursive: true });
  writeFileSync(join(PROJECT, 'README.md'), '# the project of the acceptance run\n', 'utf8');
  writeFileSync(
    join(USER_DATA, 'User', 'settings.json'),
    JSON.stringify(
      {
        // `application` scope: a workspace file would be ignored, which is why
        // the whole run carries a user data directory of its own.
        'gripterm.storage.path': STORE,
        'security.workspace.trust.enabled': false,
        'window.restoreWindows': 'none',
        'telemetry.telemetryLevel': 'off',
        'update.mode': 'none',
        'workbench.startupEditor': 'none',
      },
      null,
      2
    ),
    'utf8'
  );
}

/**
 * One host, running the suites whose names match.
 *
 * П3 and П2 run in hosts of their own, with the store wiped between them: П3
 * leaves a record of its own, and П2 counts records to answer О3.
 */
function host(grep) {
  execFileSync(
    process.execPath,
    [
      join(REPO, 'node_modules', '@vscode', 'test-cli', 'out', 'bin.mjs'),
      '--config', '.vscode-test.acceptance.mjs',
      '--grep', grep,
    ],
    {
      cwd: REPO,
      stdio: 'inherit',
      env: {
        ...process.env,
        GRIPTERM_ACCEPTANCE_PROJECT: PROJECT,
        GRIPTERM_ACCEPTANCE_UD: USER_DATA,
      },
    }
  );
}

/** The store, emptied without touching the project or the trusted-folder history. */
function emptyStore() {
  rmSync(STORE, { recursive: true, force: true });
  mkdirSync(STORE, { recursive: true });
}

/**
 * A real editor, in development mode, doing on its own what П2 says it does.
 *
 * Waits for the evidence in the store rather than for a fixed time: the record
 * changing owner is this window adopting it, and a `SessionStart` with
 * `source: resume` in the journal is the CLI saying the conversation came back.
 */
async function sitting(number, terminalId, sessionId) {
  const quietFrom = Date.now();
  await until(
    `the CLI to stop listing ${sessionId} as running (it lists ${JSON.stringify(runningHere().map((one) => `${one.sessionId} pid=${one.pid}`))})`,
    () => (listedAsRunning(sessionId) ? null : true),
    QUIETENS_WITHIN_MS
  );
  console.log(`--- sitting ${number}`);
  console.log(`  waited for quiet   : ${Date.now() - quietFrom} ms`);

  const before = journal(terminalId).length;
  const editor = spawn(
    CODE,
    [
      '--extensionDevelopmentPath', EXTENSION,
      '--user-data-dir', USER_DATA,
      '--extensions-dir', EXTENSIONS,
      '--disable-workspace-trust',
      '--new-window',
      PROJECT,
    ],
    { stdio: 'ignore', detached: false }
  );
  editor.unref();

  const started = Date.now();
  const resumed = await until(
    `sitting ${number} to bring the conversation back`,
    () => {
      const line = journal(terminalId)
        .slice(before)
        .find((one) => one.body?.hook_event_name === 'SessionStart');
      return line === undefined ? null : line;
    },
    RESTORE_WITHIN_MS
  );
  const took = Date.now() - started;

  const [record] = records().filter((one) => one.id === terminalId);
  // A person does not close a window two seconds after it opened. The pause is
  // also what makes the close a fair test of the shutdown path rather than of a
  // process that had not finished starting.
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const running = runningHere().length;
  const owner = record.record.owner.ownerId;

  console.log(`  resumed after      : ${took} ms (editor start to SessionStart)`);
  console.log(`  SessionStart source: ${String(resumed.body?.source)}`);
  console.log(`  records in store   : ${records().length}`);
  console.log(`  claude processes   : ${running}`);
  console.log(`  conversation       : ${record.record.sessionId}`);
  console.log(`  same conversation  : ${record.record.sessionId === sessionId}`);
  console.log(`  owner              : ${owner}`);
  console.log(`  task               : ${JSON.stringify(record.record.metadata.task)}`);
  console.log(`  notes              : ${JSON.stringify(record.record.metadata.notes.map((n) => n.text))}`);

  for (const line of extensionLog().filter((one) => /bring|restor/iu.test(one))) {
    console.log(`  log                : ${line}`);
  }

  closeEditors();
  await until(
    `sitting ${number} to close`,
    () => (editorProcesses().length === 0 ? true : null),
    CLOSES_WITHIN_MS
  );
  const leftBehind = runningHere();
  console.log(`  running after close: ${leftBehind.length === 0 ? 'none' : JSON.stringify(leftBehind.map((one) => one.sessionId))}`);

  return { took, running, leftBehind: leftBehind.length, record: record.record, count: records().length };
}

// --- the run -----------------------------------------------------------------

if (!existsSync(CODE)) {
  throw new Error(`no editor at ${CODE}`);
}

prepare();
console.log(`acceptance store: ${STORE}`);

// П3 first, because it is the cheap one and it needs an empty store.
host('П3');
emptyStore();

host('П2');

const [first] = records();
if (first === undefined || records().length !== 1) {
  throw new Error(`the first sitting left ${records().length} records, expected exactly one`);
}
const terminalId = first.id;
const sessionId = first.record.sessionId;
const firstOwner = first.record.owner.ownerId;
console.log(`--- after the first sitting`);
console.log(`  terminal           : ${terminalId}`);
console.log(`  conversation       : ${sessionId}`);
console.log(`  owner (now gone)   : ${firstOwner}`);
console.log(`  running here       : ${runningHere().length}`);

const second = await sitting(2, terminalId, sessionId);
const third = await sitting(3, terminalId, sessionId);

const failures = [];
for (const [name, sat] of [['second', second], ['third', third]]) {
  if (sat.count !== 1) {
    failures.push(`the ${name} sitting left ${sat.count} records`);
  }
  if (sat.running !== 1) {
    failures.push(`the ${name} sitting had ${sat.running} claude processes, expected exactly one`);
  }
  if (sat.leftBehind !== 0) {
    failures.push(`the ${name} sitting left ${sat.leftBehind} claude processes behind`);
  }
  if (sat.record.sessionId !== sessionId) {
    failures.push(`the ${name} sitting changed the conversation`);
  }
  if (sat.record.metadata.task === null || sat.record.metadata.notes.length !== 1) {
    failures.push(`the ${name} sitting lost the task or the note`);
  }
  if (sat.record.owner.ownerId === firstOwner) {
    failures.push(`the ${name} sitting did not adopt the record`);
  }
}

console.log('--- verdict');
if (failures.length === 0) {
  console.log('  П2 and О3 hold on this machine, in this build');
} else {
  for (const failure of failures) {
    console.log(`  FAILED: ${failure}`);
  }
  process.exitCode = 1;
}
