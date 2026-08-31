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
 * WHAT IT COSTS, said out loud, and it depends on WHO answers as `claude`.
 *
 * By default nobody does: `GRIPTERM_ACCEPTANCE_AGENT` is `fake` and the agent is
 * `fake-claude/`, a double of our own beliefs about Claude Code that spends
 * nothing and needs no account (Ш32). Read the head of `fake-claude.mjs` before
 * believing a green run: it names, one by one, what the double does NOT do, and a
 * suite that never exercises a behaviour proves nothing about it.
 *
 * With `GRIPTERM_ACCEPTANCE_AGENT=real` the run is what it always was: a real
 * `claude`, one real turn on the person's account in the first sitting, and one
 * `--resume` per sitting after it. That is the run this repository owes the
 * double, and `tests/acceptance/against-the-real-cli.json` is the debt -- it goes
 * red in the unit suite when nobody has paid it for long enough.
 *
 * What NEITHER mode touches is the person's store: everything lives under a
 * temporary directory, and the first sitting refuses to run if that did not take
 * effect. In the `fake` mode the same is true of the CLI's own profile --
 * `CLAUDE_CONFIG_DIR` is moved into the run's directory, so no session file and no
 * transcript of this run goes near a real one.
 */

import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { buildFakeClaude } from './fake-claude/build.mjs';

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BASE = join(tmpdir(), 'gripterm-acceptance');
const PROJECT = join(BASE, 'project');
const STORE = join(BASE, 'store');
const USER_DATA = join(BASE, 'user-data');
const EXTENSIONS = join(BASE, 'extensions');
const EXTENSION = join(REPO, 'packages', 'extension');

/**
 * Where the agent keeps what it keeps: session files and transcripts.
 *
 * Only used in the `fake` mode. `CLAUDE_CONFIG_DIR` MOVES the CLI's whole user
 * level rather than adding to it [binary 2.1.228, quoted in
 * `settings-locations.ts`], so pointing it here is what keeps a run of the double
 * out of a person's own profile -- and this build reads the same variable, which
 * is why `rename-to-cli.test.ts` finds the double's session file where it looks
 * for the CLI's. In the `real` mode it is deliberately NOT set: a real `claude`
 * has to run in the profile the person is logged into.
 */
const CLAUDE_CONFIG = join(BASE, 'claude-config');

/**
 * Who answers as `claude`, and which engine the windows run on.
 *
 * `fake` is the default because it is the one that costs nothing; `real` is the
 * run the double owes and cannot replace (see the head of this file). The engine
 * is chosen rather than defaulted for the reason
 * `tests/every-run-names-its-engine.test.ts` states at length -- a run that sets
 * nothing measures whatever the manifest last defaulted to and says so nowhere.
 * `own` is the default here because it is the product's, since 2026-08-30.
 */
const AGENT = process.env.GRIPTERM_ACCEPTANCE_AGENT ?? 'fake';
const ENGINE = process.env.GRIPTERM_ACCEPTANCE_ENGINE ?? 'own';

/**
 * The profile each engine gets, written out twice rather than interpolated.
 *
 * Both spellings are literal on purpose: `every-run-names-its-engine.test.ts`
 * reads this file as TEXT, and a run that composed its engine out of a variable
 * would satisfy that check while naming nothing a reader could see.
 */
const ENGINE_SETTINGS = {
  editor: { 'gripterm.terminal.engine': 'editor' },
  own: { 'gripterm.terminal.engine': 'own' },
};

/**
 * The suites that cannot run under our own engine, by name and with the reason.
 *
 * FOUND BY RUNNING IT, 2026-08-31, the first time this acceptance was walked
 * under `own` at all: `rename from the CLI` asks the EDITOR for a terminal
 * object -- `vscode.window.terminals`, `vscode.window.activeTerminal`, and the
 * `name` drawn on a tab -- and under our own engine there is no editor terminal
 * to ask about. It failed on its third line with "the editor has no terminal
 * called project", which is the suite being right rather than the engine being
 * wrong.
 *
 * The criterion is the one `.vscode-test.mjs` uses for `NOT_UNDER_OWN`, and no
 * wider: a suite is out when its SUBJECT is the terminal's place among the
 * editor's own objects. What is LOST by excluding it is stated rather than
 * buried -- the half of M2.17 that is engine-neutral, `/rename` typed inside the
 * terminal reaching the ROW and the record, is not walked under `own` by
 * anything. Splitting the suite in two would cover it and is a change to an
 * acceptance criterion's shape, which is not this step's to make.
 *
 * The other three run under both engines. `rename to the CLI`, П3 and П2 ask the
 * registry, the gateway and the store, none of which is the editor's.
 */
const NOT_UNDER_OWN = new Map([
  [
    'rename from the CLI',
    'its subject is the name on an EDITOR terminal -- it reads `window.terminals`, `window.activeTerminal` and a tab`s `name`, and our own engine makes none of those',
  ],
]);

/** Runs a suite, or says why this engine cannot have it. */
function hostUnlessTheEngineForbidsIt(grep) {
  const why = ENGINE === 'own' ? NOT_UNDER_OWN.get(grep) : undefined;
  if (why !== undefined) {
    console.log(`--- NOT RUN under the own engine: ${grep}`);
    console.log(`    ${why}`);
    return;
  }
  host(grep);
}

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
  console.error('This run opens real editor windows on this desktop, several times over.');
  console.error(
    AGENT === 'real'
      ? 'It also starts a real `claude` and spends a real turn on whoever is logged in.'
      : 'It spends nothing: the agent is the double in tests/acceptance/fake-claude.'
  );
  console.error('Set GRIPTERM_ACCEPTANCE=yes to mean it.');
  process.exit(1);
}

if (AGENT !== 'fake' && AGENT !== 'real') {
  throw new Error(`GRIPTERM_ACCEPTANCE_AGENT is '${AGENT}', and there are two: fake, real`);
}
if (ENGINE_SETTINGS[ENGINE] === undefined) {
  throw new Error(`GRIPTERM_ACCEPTANCE_ENGINE is '${ENGINE}', and there are two: editor, own`);
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

/**
 * The runner itself: the process of the extension host that is holding the
 * store open.
 *
 * Taken from our own presence file rather than from the process table, and that
 * is not a shortcut -- there is no other honest way. In VS Code 1.132 the
 * extension host is a `--type=utility` child among several of them, with nothing
 * in its command line to tell it from the file watcher or the pty host, while
 * `owners/<id>.json` carries the pid the extension itself announced (§4.8).
 */
function runnerPids() {
  const dir = join(STORE, 'owners');
  const files = existsSync(dir) ? readdirSync(dir) : [];
  return files
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')).pid)
    .filter((pid) => Number.isInteger(pid));
}

/** Whether the operating system still has this process. The instrument О1 is measured with. */
function processAlive(pid) {
  return pid === null
    ? 'no pid'
    : powershell(`if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'alive' } else { 'gone' }`);
}

/** Packages this build and installs it into the run's own extensions directory. */
function install() {
  execFileSync('pnpm', ['run', 'package'], { cwd: REPO, stdio: 'ignore', shell: true });
  // One quoted command line rather than an argument vector: the launcher is a
  // `.cmd`, which needs a shell, and a shell needs the spaces in "Microsoft VS
  // Code" quoted. `--force` because a second run installs the same version
  // again, and the launcher calls that a failure.
  const launcher = join(dirname(CODE), 'bin', 'code.cmd');
  execFileSync(
    `"${launcher}" --install-extension "${join(EXTENSION, 'gripterm-0.0.1.vsix')}"` +
      ` --user-data-dir "${USER_DATA}" --extensions-dir "${EXTENSIONS}" --force`,
    { stdio: 'ignore', shell: true }
  );
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

/**
 * Puts the double where `claude` would be, and says so.
 *
 * The whole substitution is one directory in front of PATH, and that is not a
 * trick: `findExecutable` is what this build uses to find `claude`, it walks
 * PATH in order, and every process of this run -- the test hosts, the
 * development windows, the installed editor, and this file's own
 * `claude agents --json` -- inherits the environment set here.
 *
 * `CLAUDE_CONFIG_DIR` goes with it, and it is doing two jobs at once: it tells
 * the double where to keep its session files and transcripts, and it tells THIS
 * BUILD where to look for them (`claudeSessionsDirectory`,
 * `claudeTranscriptsDirectory`, and `rename-to-cli.test.ts`). Both sides reading
 * one variable is what makes the double findable at all -- and it is also what
 * keeps a run of it out of the profile of whoever is logged in.
 *
 * @returns {string|null} where the double was put, or null when the agent is real
 */
function putTheDoubleOnThePath() {
  if (AGENT === 'real') {
    return null;
  }
  const where = buildFakeClaude();
  process.env.PATH = `${where};${process.env.PATH ?? ''}`;
  process.env.CLAUDE_CONFIG_DIR = CLAUDE_CONFIG;
  // The interpreter by absolute path: the launcher starts `node` on the double,
  // and a bare `node` on the PATH a terminal inherits is not guaranteed (C5-2).
  process.env.GRIPTERM_FAKE_CLAUDE_NODE = process.execPath;
  return where;
}

function prepare() {
  rmSync(BASE, { recursive: true, force: true });
  mkdirSync(PROJECT, { recursive: true });
  mkdirSync(STORE, { recursive: true });
  mkdirSync(join(USER_DATA, 'User'), { recursive: true });
  mkdirSync(EXTENSIONS, { recursive: true });
  if (AGENT === 'fake') {
    // Only where it is used: in the `real` mode the agent's profile is the
    // person's own, and an empty directory of ours beside it would read as one.
    mkdirSync(CLAUDE_CONFIG, { recursive: true });
  }
  writeFileSync(join(PROJECT, 'README.md'), '# the project of the acceptance run\n', 'utf8');
  writeFileSync(
    join(USER_DATA, 'User', 'settings.json'),
    JSON.stringify(
      {
        // `application` scope: a workspace file would be ignored, which is why
        // the whole run carries a user data directory of its own.
        'gripterm.storage.path': STORE,
        // WHICH ENGINE, and it is no longer a debt.
        //
        // Until 2026-08-30 this run set no engine at all and took the manifest's
        // default, which was `editor`; on that day the owner moved the default
        // to `own`, and a run that went on setting nothing would have spent a
        // real turn of his account measuring an engine it had no evidence about,
        // under the name of an acceptance that passed. It was then pinned to
        // `editor` -- the one this acceptance had actually been walked on -- with
        // a comment saying that covering the other one cost real turns, needed
        // its own decision, and was Ш32.
        //
        // Ш32 is done: `GRIPTERM_ACCEPTANCE_AGENT=fake` costs nothing, so both
        // engines can be walked as often as anybody likes, and `ENGINE` chooses
        // which. What is NOT settled by that is whether the REAL CLI holds up
        // under either of them -- that run is still owed, and
        // `against-the-real-cli.json` is what will not let it be forgotten.
        ...ENGINE_SETTINGS[ENGINE],
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


/**
 * Where the CLI said it keeps a conversation, taken from the journal this store
 * already holds. The same reading `p2-first-window.test.ts` makes, from outside
 * a host.
 */
function transcriptOf(terminalId) {
  for (const line of journal(terminalId)) {
    const path = line.body?.transcript_path;
    if (typeof path === 'string') {
      return path;
    }
  }
  return null;
}

/**
 * A record closed by a person's own hand, put into the store while the О1 window
 * is up.
 *
 * **What it is for.** О1 under our own engine asks four things of a host that
 * dies, and the fourth is the one that is not about rescue: a terminal the
 * person closed THEMSELVES must not come back. The other three are about the
 * conversation П2 left; this one needs a record nobody wants back, and the О1
 * window is an INSTALLED editor with no test host in it, so there is no hand
 * inside it to close a terminal with.
 *
 * **It is a COPY, not a second spelling of the format.** The record this run's
 * own product wrote is read back off the disk and four fields of it are moved:
 * the two ids, so it is a different terminal on a different conversation, and
 * the pair a close writes. Everything else -- the owner, the folder, the launch,
 * the schema -- is whatever the build under test put there, so this cannot drift
 * from the format the way a hand-written fixture would. `closedBy: 'person'` is
 * the point of the whole thing: it is the one hand whose closes a window may act
 * on without asking (`UNASKED` in `cleanup-planner.ts`).
 *
 * Its owner is left exactly as copied -- the window that is about to be killed --
 * because that is the case the criterion describes: the person closed it in the
 * window whose host then died.
 */
function plantARecordClosedByHand(terminalId) {
  const record = JSON.parse(readFileSync(join(STORE, 'terminals', terminalId, 'record.json'), 'utf8'));
  const planted = {
    ...record,
    terminalId: randomUUID(),
    sessionId: randomUUID(),
    sessionIdHistory: [],
    metadata: { ...record.metadata, displayName: 'closed by hand', task: null, notes: [] },
    closedAt: Date.now(),
    closedBy: 'person',
    revision: 1,
  };
  const dir = join(STORE, 'terminals', planted.terminalId);
  mkdirSync(dir, { recursive: true });
  // The snapshot too, and with the process taken out of it: a terminal somebody
  // closed has no `claude` behind it, and a pid copied from a live one would be
  // the one field of this record that is a lie.
  const observed = JSON.parse(readFileSync(join(STORE, 'terminals', terminalId, 'observed.json'), 'utf8'));
  writeFileSync(
    join(dir, 'observed.json'),
    JSON.stringify({ ...observed, state: 'ended', pid: null }, null, 2),
    'utf8'
  );
  writeFileSync(join(dir, 'record.json'), JSON.stringify(planted, null, 2), 'utf8');
  return planted;
}

/**
 * О1, and it has TWO HEADS, because the two engines put the terminal in
 * different processes.
 *
 * M1.15 measured this without a restore, on a terminal a person had started. The
 * plan asks for it again here for the reason it gives: in M1 there is no restore,
 * and the restore is what could break it -- a window that comes back could start
 * a SECOND `claude` on a conversation the first one is still holding.
 *
 * The extension host is killed rather than the whole editor, because that is the
 * shape of the failure the criterion is about.
 *
 * **Under `editor`, as written and without exceptions.** That terminal belongs
 * to the editor and its `claude` is a child of the pty host, so a killed runner
 * means our hooks knock at a dead address -- and a non-2xx or a timeout on a
 * hook is a NON-BLOCKING error for the CLI. The agent carries on, in the same
 * process, on the same conversation.
 *
 * **Under `own` that letter is UNMEETABLE, and structurally so.** We make the
 * terminal, and its pty lives inside our own extension host. Kill the host and
 * the agent goes with it: what is lost is not the address of a hook but the
 * process itself. Owner's refinement, 2026-08-31, and what it requires under
 * `own` instead is exactly О1's former meaning rather than a smaller one -- the
 * death of our host must not cost the person a conversation. Namely: the record
 * and the transcript are whole; at the next activation the conversation comes
 * back through `--resume` ON THE SAME SESSION, with the task and the notes; no
 * duplicates appear; and a terminal the person closed THEMSELVES does not come
 * back. What О1 does NOT promise under `own` is the turn the agent was making in
 * that second.
 *
 * The first walk under `own` was 2026-08-31 and it went red on the `editor`
 * head -- `claude=gone`, and a NEW pid on the SAME conversation. That reading is
 * the four points above passing, presented against the wrong criterion.
 *
 * THE EXTENSION IS INSTALLED FOR THIS ONE, and that is not tidiness. Measured
 * 2026-08-13: in a development host (`--extensionDevelopmentPath`) killing the
 * extension host takes the terminal's `claude` with it within seven seconds,
 * while the same kill against the same build INSTALLED leaves it running for as
 * long as it was watched. О1 is a promise about what a person has installed, so
 * that is the configuration it is measured in. Under `own` the same kill takes
 * the agent either way, which is the point.
 */
async function killTheRunner(terminalId, sessionId) {
  const before = journal(terminalId).length;
  install();
  const editor = spawn(
    CODE,
    [
      '--user-data-dir', USER_DATA,
      '--extensions-dir', EXTENSIONS,
      '--disable-workspace-trust',
      '--new-window',
      PROJECT,
    ],
    { stdio: 'ignore', detached: false }
  );
  editor.unref();

  await until(
    'the conversation to come back before the runner is killed',
    () => {
      const line = journal(terminalId).slice(before).find((one) => one.body?.hook_event_name === 'SessionStart');
      return line === undefined ? null : line;
    },
    RESTORE_WITHIN_MS
  );
  await new Promise((resolve) => setTimeout(resolve, 5000));

  const running = runningHere();
  const claudePid = running[0]?.pid ?? null;
  const transcript = transcriptOf(terminalId);
  // Only under `own`: the fourth point is one only that head asks, and putting a
  // record nobody wants back into the store of a run measuring the other head
  // would change what that run measures.
  const closedByHand = ENGINE === 'own' ? plantARecordClosedByHand(terminalId) : null;
  console.log('--- О1: the runner is killed while a restored conversation is running');
  console.log(`  the build          : installed, not a development host`);
  console.log(
    `  the criterion      : ${ENGINE === 'own'
      ? 'the four points of the refinement of 2026-08-31'
      : 'the same process on the same conversation'}`
  );
  console.log(`  running before     : ${JSON.stringify(running.map((one) => `${one.sessionId} pid=${one.pid}`))}`);
  console.log(`  transcript         : ${String(transcript)}`);
  if (closedByHand !== null) {
    console.log(`  closed by hand     : terminal ${closedByHand.terminalId}, conversation ${closedByHand.sessionId}`);
  }

  const sinceTheKill = journal(terminalId).length;
  const hosts = runnerPids();
  if (hosts.length === 0) {
    throw new Error('no runner to kill: the store has no presence file');
  }
  for (const pid of hosts) {
    powershell(`Stop-Process -Id ${pid} -Force`);
  }
  console.log(`  killed             : the runner, pid ${JSON.stringify(hosts)}`);
  const killedAt = Date.now();

  // Long enough for the editor to restart the host and for a restarted one to
  // pass the minute after which a window that left no goodbye counts as gone --
  // which is when a second `claude --resume` would appear if anything were
  // going to start one.
  for (let waited = 0; waited < 90_000; waited += 15_000) {
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    const now = runningHere();
    console.log(
      `  +${Math.round((Date.now() - killedAt) / 1000)}s: claude=${processAlive(claudePid)}` +
        ` listed=${JSON.stringify(now.map((one) => `${one.sessionId} pid=${one.pid}`))}`
    );
  }

  const after = runningHere();
  const sameOne = processAlive(claudePid) === 'alive'
    && after.length === 1
    && after[0].sessionId === sessionId
    && after[0].pid === claudePid;
  const [record] = records().filter((one) => one.id === terminalId);
  const resumed = journal(terminalId)
    .slice(sinceTheKill)
    .find((one) => one.body?.hook_event_name === 'SessionStart');
  console.log(`  the same process still holds the same conversation: ${String(sameOne)}`);
  console.log(`  records in store   : ${records().length}`);
  console.log(
    `  after the kill     : ${resumed === undefined
      ? 'no SessionStart at all'
      : `SessionStart source ${String(resumed.body?.source)}`}`
  );
  for (const line of extensionLog().filter((one) => /bring|restor|adopt|goodbye/iu.test(one))) {
    console.log(`  log                : ${line}`);
  }

  const failures = ENGINE === 'own'
    ? theFourPoints({ sessionId, record, transcript, resumed, after, closedByHand })
    : sameOne
      ? []
      : ['killing the runner did not leave the same process on the same conversation'];
  for (const failure of failures) {
    console.log(`  NOT MET            : ${failure}`);
  }

  closeEditors();
  await until('the О1 window to close', () => (editorProcesses().length === 0 ? true : null), CLOSES_WITHIN_MS);
  const leftBehind = runningHere();
  console.log(`  running after close: ${leftBehind.length === 0 ? 'none' : JSON.stringify(leftBehind.map((one) => one.sessionId))}`);
  return { failures, count: records().length, leftBehind: leftBehind.length };
}

/**
 * О1 under our own engine, one point at a time and named after the sentence it
 * comes from.
 *
 * Nothing here is weaker than the head it stands beside. "The conversation came
 * back somehow" would be: it is the SAME session, with the task and the notes
 * still on it, exactly one of it, and the record the person threw away still
 * gone. Each of those four is a way for a rescue to be worth nothing, and each
 * has a line of its own so that a red run says WHICH.
 */
function theFourPoints(seen) {
  const { sessionId, record, transcript, resumed, after, closedByHand } = seen;
  const failures = [];

  // 1. The record and the transcript are whole.
  if (record === undefined) {
    failures.push('the killed runner left no record at all');
  } else {
    if (record.record.sessionId !== sessionId) {
      failures.push(`the record names ${record.record.sessionId} rather than the conversation it had`);
    }
    if (record.record.metadata.task === null || record.record.metadata.notes.length !== 1) {
      failures.push('the killed runner cost the record its task or its note');
    }
  }
  if (transcript === null) {
    failures.push('no hook ever said where the transcript would be, so nothing could have been resumed');
  } else if (!existsSync(transcript)) {
    failures.push(`the transcript at ${transcript} is gone, so the conversation cannot be resumed`);
  }

  // 2. The conversation comes back through `--resume`, on the same session.
  if (resumed === undefined) {
    failures.push('the conversation never came back after the runner was killed');
  } else if (String(resumed.body?.source) !== 'resume') {
    failures.push(`the conversation came back as ${String(resumed.body?.source)} rather than a resume`);
  }

  // 3. No duplicates.
  if (after.length !== 1) {
    failures.push(`${String(after.length)} conversations are running after the kill, expected exactly one`);
  } else if (after[0].sessionId !== sessionId) {
    failures.push(`what is running is ${after[0].sessionId} rather than the conversation that was there`);
  }

  // 4. What the person closed themselves did not come back.
  if (closedByHand === null) {
    failures.push('nothing was closed by hand, so the fourth point of О1 was never asked');
  } else {
    if (after.some((one) => one.sessionId === closedByHand.sessionId)) {
      failures.push('the conversation the person closed themselves was started again');
    }
    const [back] = records().filter((one) => one.id === closedByHand.terminalId);
    if (back !== undefined && back.record.closedAt === null) {
      failures.push('the record the person closed themselves was reopened by the restart');
    }
  }
  return failures;
}

// --- the run -----------------------------------------------------------------

if (!existsSync(CODE)) {
  throw new Error(`no editor at ${CODE}`);
}

/**
 * Which criteria this run is for.
 *
 * Named on the command line or all of them. It exists because the parts cost
 * wildly different things -- `rename` and П3 spend nothing, П2 spends a turn and
 * О1 packages and installs the extension -- and a person re-checking one of them
 * should not have to buy the others.
 */
const only = process.argv.slice(2);
const wanted = (name) => only.length === 0 || only.includes(name);

const startedAt = Date.now();
prepare();
const doubleAt = putTheDoubleOnThePath();
console.log(`acceptance store: ${STORE}`);
console.log(`agent           : ${AGENT === 'real' ? 'the real `claude` on this PATH' : `the double at ${doubleAt}`}`);
console.log(`engine          : ${ENGINE}`);
console.log(`criteria        : ${only.length === 0 ? 'all of them' : JSON.stringify(only)}`);

// The cheap ones first, each with a store of its own: both leave a record, and
// П2 counts records to answer О3.
if (wanted('rename')) {
  // Two hosts and not one: each of these opens a terminal, and each asserts on
  // an empty store first -- which is how they know they are looking at their
  // own record and not at one left behind.
  emptyStore();
  hostUnlessTheEngineForbidsIt('rename from the CLI');
  emptyStore();
  hostUnlessTheEngineForbidsIt('rename to the CLI');
  emptyStore();
}
if (wanted('П3')) {
  host('П3');
  emptyStore();
}

if (!wanted('П2')) {
  console.log('--- verdict');
  console.log(`  ran ${JSON.stringify(only)} and nothing else`);
  console.log(`  took ${Math.round((Date.now() - startedAt) / 1000)} s on the ${ENGINE} engine, agent ${AGENT}`);
  process.exit(0);
}

/*
 * The machine, quiet, before П2 begins.
 *
 * FOUND BY RUNNING IT, 2026-08-31, under the editor's engine: the second sitting
 * reported `claude processes: 2` and left one behind, and the extra one was the
 * `rename from the CLI` conversation -- started thirty-five seconds earlier, in a
 * test host that had already exited, and still alive. The store had been emptied
 * between the phases, so nothing in П2 or О3 is about that conversation; but the
 * counts below are `runningHere().length`, which is every conversation in this
 * project's directory, and a leftover makes them mean something else.
 *
 * It is a WAIT and not a kill, and that is the point: the run's own comment
 * records the same lingering against a real CLI (2026-08-13, a sitting three
 * seconds after the previous one closed was refused with `session-running`), so
 * hurrying it along would be the stand editing the machine it is measuring. How
 * long it took is printed, because that number is the thing being tolerated.
 */
const quietFrom = Date.now();
await until(
  `the cheap suites' conversations to end (${JSON.stringify(runningHere().map((one) => `${one.sessionId} pid=${one.pid}`))} still running)`,
  () => (runningHere().length === 0 ? true : null),
  QUIETENS_WITHIN_MS
);
console.log(`--- before П2`);
console.log(`  waited for quiet   : ${Date.now() - quietFrom} ms`);

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
const o1 = await killTheRunner(terminalId, sessionId);

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

for (const failure of o1.failures) {
  failures.push(failure);
}
if (o1.count !== 1) {
  failures.push(`killing the runner left ${o1.count} records`);
}
if (o1.leftBehind !== 0) {
  failures.push(`the О1 window left ${o1.leftBehind} conversations running`);
}

console.log('--- verdict');
console.log(`  took ${Math.round((Date.now() - startedAt) / 1000)} s on the ${ENGINE} engine, agent ${AGENT}`);
if (failures.length === 0) {
  console.log(
    AGENT === 'real'
      ? '  П2, О3 and О1 hold on this machine, in this build, against a real `claude`'
      : '  П2, О3 and О1 hold on this machine, in this build, against the double -- which is our own beliefs about `claude` and not `claude`'
  );
} else {
  for (const failure of failures) {
    console.log(`  FAILED: ${failure}`);
  }
  process.exitCode = 1;
}
