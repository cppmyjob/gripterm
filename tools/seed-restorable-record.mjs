import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * One record of a window that is gone, written into a run's own store BEFORE the
 * host that will read it starts.
 *
 * **Why it cannot be written by a test.** The thing under test is what
 * ACTIVATION does, and activation is over before the first test runs
 * (`onStartupFinished`). A record seeded from inside a suite is a record the
 * restore has already walked past, so the only place a seed can be laid is here
 * -- in the process that composes the run, before VS Code is launched at all.
 *
 * **Why it is safe to lay it.** The store is the run's own
 * (`tools/host-user-data.mjs`), and the extension refuses to open any other one
 * in a test host (`readStorageDir`). Both halves are needed: this file makes a
 * run start a real `claude`, and the second half is what keeps that `claude`
 * away from the conversations of whoever owns this machine.
 *
 * **What the record is shaped to produce, rule by rule (`planRestore`).**
 *
 *   * `closedAt: null` -- nobody threw it away, so it is restorable at all;
 *   * an owner no presence file names -- a window that is GONE, which is the
 *     only kind of record another window may take;
 *   * `workspaceFolder: null` against a host that opens no folder -- `.vscode-test.mjs`
 *     sets no `workspaceFolder`, so `belongsHere(null, [])` is true. A run given
 *     a folder would have to name it here too;
 *   * `state: 'ended'` -- a witnessed end, so our own evidence says no `claude`
 *     is on that conversation and the record is not held back as `session-running`;
 *   * a conversation id nothing on this machine has ever heard of, which is
 *     deliberate and is the one place this file is opinionated. It means the
 *     planner answers `no-transcript`, and the product's own answer to that
 *     (owner's decision 2026-08-21) is to bring the record back holding a NEW
 *     conversation rather than to refuse it. So the run exercises the `launch`
 *     half of the restore, not the `--resume` half. The `--resume` half needs a
 *     transcript, and the only transcripts on this machine are the owner's --
 *     which is exactly what the fake CLI of the plan's Ш4б is for.
 *
 * **`CLAUDE_CONFIG_DIR` is pinned into the record's environment**, so that the
 * `claude` this seed starts writes its session files into the run's directory
 * rather than into the `~/.claude` of whoever owns this machine. The store was
 * moved for that reason; the CLI's own profile is the other half of the same
 * reason.
 */

/**
 * The id of the seeded record.
 *
 * **Written down twice on purpose**, here and in
 * `tests/integration/activation-restore.test.ts`. This file is loaded by the
 * runner as ESM before VS Code exists; the suite is compiled to CommonJS and
 * loaded inside the extension host. There is no module both of them can import,
 * so the id is a constant in each, and the suite says this file's name in the
 * message it fails with.
 */
export const SEEDED_TERMINAL_ID = '0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0';

/**
 * A conversation id no `claude` on this machine can have.
 *
 * Invented rather than taken from anywhere, and that is the safety property:
 * were it an id the owner's transcripts hold, the planner would answer `resume`
 * and the run would attach a second `claude --resume` to a real conversation of
 * theirs. Nothing generates this value; it is read only by a test that knows it.
 */
const SEEDED_SESSION_ID = '9e8d7c6b-5a4f-4312-8021-fedcba987654';

/**
 * What the ids of the EXTRA records all begin with.
 *
 * The named seed shares it -- the extras are that id with its tail replaced --
 * which is why the sweep below has to name the seed as the one exception. One
 * prefix rather than two so that a directory left by a run cannot be mistaken
 * for anybody's record but this file's.
 */
const EXTRA_PREFIX = '0f1e2d3c-4b5a-4968-8776-';

/** An owner id no presence file names, which is what makes the window "gone". */
const CLOSED_WINDOW = 'a-window-that-closed-before-this-run';

/** Long enough ago to be plainly not this run, and irrelevant to every rule. */
const LAST_HEARD_FROM_MS = 1_786_500_000_000;

/**
 * Lays the seed, replacing whatever the previous run left of it.
 *
 * The whole directory goes first rather than the two files being overwritten,
 * and both halves of that matter. The run before this one restored this record,
 * adopted it into its own window and closed it, so what is on disk names an
 * owner that is not gone and a terminal that is over -- a seed that inherited
 * any of it would be a different test on the second run. And the file the suite
 * reads as proof of a start, `starts.jsonl`, is APPENDED to: left in place it
 * would carry yesterday's line, and the suite would read a run that is not this
 * one as evidence about this one.
 *
 * The recursive delete is the one in this repository that needs no argument
 * about reversibility: its path is `.vscode-test/store-<label>`, a directory
 * this same runner creates, and the next line writes back everything it took.
 *
 * @param {string} store the run's own storage directory
 * @returns {string} the id of the record that was seeded
 */
export function seedRestorableRecord(store) {
  return seedOne(store, SEEDED_TERMINAL_ID, SEEDED_SESSION_ID);
}

/**
 * How many records this run is to seed: one, unless somebody asked for more.
 *
 * **What it is for, and it is not the gate.** A run seeds ONE record, and a
 * restore of one record cannot say what a restore of ten costs -- which is the
 * question Ш23 was set. So the count is a knob, its default is the number every
 * gate has always run with, and `activation-restore.test.js` reads the same
 * function rather than a constant of its own.
 *
 * **Every extra record is a real `claude`**, started inside the host and living
 * as long as it. Ten is not a number to reach for idly: Ш21 measured a machine
 * that ran out of processes, and it took a whole gate with it.
 */
export function howManyToSeed() {
  const asked = Number.parseInt(process.env.GRIPTERM_SEED_RECORDS ?? '1', 10);
  return Number.isFinite(asked) && asked >= 1 ? asked : 1;
}

/**
 * The extra records, when a run was told to seed more than one -- and the
 * removal of the ones a previous run was told to seed.
 *
 * Each is the same shape as the first and differs only in the two ids, so that
 * what a bigger restore costs is the only thing that changes with the count.
 *
 * **It takes the old ones away FIRST, and that is not tidiness.** Measured on
 * 2026-08-27, by writing this without it: a run told to seed ten left nine
 * behind, the next run was told nothing and seeded one, and the host found ten.
 * Four tests failed in the label that had never been asked for ten -- the plan
 * held ten, a window ended ten processes where one was expected, and two more
 * timed out behind them. A knob whose old position survives being turned back is
 * a knob that makes every later run a different test.
 *
 * The recursive delete is bounded twice: to `<store>/terminals`, which this same
 * file writes, and to directory names carrying the prefix nothing but this file
 * produces.
 *
 * @param {string} store the run's own storage directory
 * @param {number} howMany the total, the named record included
 */
export function seedMoreRestorableRecords(store, howMany) {
  const terminals = join(store, 'terminals');
  if (existsSync(terminals)) {
    for (const name of readdirSync(terminals)) {
      if (name.startsWith(EXTRA_PREFIX) && name !== SEEDED_TERMINAL_ID) {
        rmSync(join(terminals, name), { recursive: true, force: true });
      }
    }
  }
  for (let at = 1; at < howMany; at += 1) {
    const tail = at.toString(16).padStart(12, '0');
    seedOne(store, `${EXTRA_PREFIX}${tail}`, `9e8d7c6b-5a4f-4312-8021-${tail}`);
  }
}

function seedOne(store, terminalId, sessionId) {
  const directory = join(store, 'terminals', terminalId);
  const claudeConfigDir = join(store, 'claude-config');
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  mkdirSync(claudeConfigDir, { recursive: true });

  const record = {
    terminalId,
    sessionId,
    sessionIdHistory: [],
    owner: {
      kind: 'window',
      ownerId: CLOSED_WINDOW,
      editorKind: 'vscode',
      workspaceFolder: null,
    },
    metadata: {
      displayName: 'the record this run seeded for itself',
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
      extraEnv: { CLAUDE_CONFIG_DIR: claudeConfigDir },
    },
    createdAt: LAST_HEARD_FROM_MS,
    closedAt: null,
    revision: 3,
  };
  const observed = {
    state: 'ended',
    lastEventAt: LAST_HEARD_FROM_MS,
    currentTool: null,
    lastAssistantMessage: null,
    cost: null,
    contextWindow: null,
    pid: null,
  };

  // `observed` first, then `record`: the store finds a record by its
  // `record.json`, so writing that one last is the nearest this has to an atomic
  // seed. Nothing is reading the directory at this moment anyway -- the host
  // does not exist yet -- and the order costs nothing.
  writeFileSync(join(directory, 'observed.json'), JSON.stringify(observed), 'utf8');
  writeFileSync(join(directory, 'record.json'), JSON.stringify(record), 'utf8');
  return terminalId;
}
