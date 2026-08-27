import * as assert from 'node:assert/strict';
import { readFile, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { GriptermApi, RestoreSummary } from '../../packages/extension/src/extension';

/**
 * S01, in a run: a window opens and the terminals of the window before it come
 * back by themselves.
 *
 * **What this suite is for.** Until Ш2 the extension refused to read the machine
 * at all in a test host, so the restore executed NOWHERE -- not here, not in the
 * acceptance stand, not in the VSIX run. `restore.test.ts` drives the
 * orchestrator by hand and proves it can bring a record back; nothing proved
 * that ACTIVATION does, which is the only form of it a person ever meets. The
 * plan's own words: without this, the stand is blind.
 *
 * **Why it may run at all.** The refusal it removed was a stand-in for the one
 * that matters, and the one that matters is now in the product:
 * `readStorageDir` THROWS in a test host that was not pointed at a store, so a
 * window with `~/.gripterm` open cannot get as far as this file. The record
 * below is therefore started for real -- a real `claude`, a real terminal --
 * inside a store the run made for itself, `.vscode-test/store-<label>`.
 *
 * **Where the seed comes from and why not from here.** Activation is over before
 * mocha loads its first file (`onStartupFinished`), so a record written by a test
 * is a record the restore has already walked past. The seed is laid by
 * `tools/seed-restorable-record.mjs`, in the process that composes the run,
 * before VS Code exists.
 *
 * **What it does NOT claim.** The seeded conversation has no transcript -- none
 * could be given it without writing into the owner's `~/.claude` -- so the
 * planner answers `no-transcript` and the record comes back holding a NEW
 * conversation (`intent: 'launch'`, the owner's decision of 2026-08-21). The
 * `--resume` half of the restore is exercised by `restore.test.ts`, which drives
 * it explicitly; that activation chooses `resume` for a record with a transcript
 * behind it is still unmeasured here, and it is what the plan's fake CLI (Ш4б)
 * is for.
 */

/**
 * The record `tools/seed-restorable-record.mjs` lays before this host starts.
 *
 * Written down in both places on purpose: that file is ESM loaded by the runner
 * before VS Code exists, this one is CommonJS loaded inside the extension host,
 * and there is no module both can import. The failure messages below name the
 * seeder, so a drift between the two ids reads as itself rather than as a
 * restore that did not happen.
 */
const SEEDED_TERMINAL = '0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0';

/**
 * How many records the seeder laid, which is ONE unless somebody measuring a
 * bigger restore asked for more.
 *
 * Read from the environment rather than written down as `1`, and it is the same
 * variable `tools/seed-restorable-record.mjs` reads: a run told to seed ten
 * records and asserted against one would fail for the reason it was started.
 * The host inherits the runner's environment, which is what makes the two agree.
 */
const SEEDED = Math.max(1, Number.parseInt(process.env.GRIPTERM_SEED_RECORDS ?? '1', 10) || 1);
const SEEDER = 'tools/seed-restorable-record.mjs';

/** Long enough for a file the launch appends after it has answered. */
const TRACE_APPEARS_WITHIN_MS = 10_000;
/** The terminal is destroyed, not waited out: this is tidying, not a measurement. */
const TERMINAL_GOES_WITHIN_MS = 15_000;
/**
 * Long enough for the writer to finish the write it was making and then the
 * deletion behind it -- measured at about 20 ms on an idle machine. Ten seconds
 * is not a guess at the cost, it is a bound on how long a WEDGED store is
 * allowed to look like a slow one before this says so.
 */
const STORE_CATCHES_UP_WITHIN_MS = 10_000;
const POLL_MS = 100;

/**
 * Everything about the instant activation finished, read once and kept.
 *
 * Read in a hook rather than in the tests because the world moves: the restored
 * record holds a live `claude`, and leaving it running while every other suite
 * looks at the same window would make this file's cost somebody else's failure.
 * So the facts are taken first and the terminal is taken away second, and the
 * tests below assert about a moment that has already passed.
 */
interface AtActivation {
  readonly restore: RestoreSummary;
  readonly storageDir: string;
  /** Whether this window holds the seeded record at all -- the adoption. */
  readonly held: boolean;
  /** Whether the record's owner is now this window, which is what adoption means. */
  readonly ownedByThisWindow: boolean;
  /** The record's own `starts.jsonl`, or `''` when there is none. */
  readonly starts: string;
  /** Kept for the failure messages: what the CLI had made of it by then. */
  readonly observedState: string | null;
}

let atActivation: AtActivation | null = null;
/** What went wrong while capturing, so that a broken hook is not a silent pass. */
let captureFailed: string | null = null;

async function api(): Promise<GriptermApi> {
  const extension = vscode.extensions.getExtension<GriptermApi>('gripterm-placeholder.gripterm');
  assert.ok(extension, 'extension not found in the host');
  return await extension.activate();
}

async function until(what: () => boolean, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (what()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return what();
}

/**
 * Waits for the deletion this hook asked for to reach the disk, and answers with
 * whatever the store still had not taken away.
 *
 * **Why waiting is not optional.** `lifecycle.discard` is SYNCHRONOUS and does
 * not write anything: it forgets the record, and `BaseWriter` -- one write in
 * flight, one queued state per record -- carries the removal to the disk after
 * whatever it was already writing. Between the two, `record.json` and
 * `observed.json` are still in the directory and the writer is still working
 * inside it.
 *
 * **What deleting the directory in that window did.** `fs.rm` recursive lists a
 * directory, unlinks what the listing named, and then `rmdir`s it -- so a write
 * that lands between the listing and the `rmdir` makes the `rmdir` fail with
 * `ENOTEMPTY`, and this hook's failure fails all four tests below. That is the
 * `ENOTEMPTY ... rmdir 'terminals/<uuid>'` open since 2026-08-21 and red in the
 * gate of 2026-08-25.
 *
 * Measured rather than reasoned, 1500 collisions per arm: a write landing while
 * the directory goes -- which is what `BaseWriter` is doing here -- produced 365
 * of them, and what it left behind was `observed.json`, the file the store
 * writes LAST. The removal's own two renames produced 0, in EITHER order, so the
 * order `e886dee` swapped is not what this was.
 *
 * **Why the wait is enough.** Once both files have gone, the registry has
 * forgotten the record, so nothing can queue another write for it; what stays --
 * `settings.json`, `starts.jsonl` and the journal -- `remove` leaves on purpose
 * and nothing appends to once the conversation is over.
 *
 * @returns the names still there, empty when the store has caught up
 */
async function storeCaughtUp(directory: string): Promise<readonly string[]> {
  const deadline = Date.now() + STORE_CATCHES_UP_WITHIN_MS;
  for (;;) {
    const left = (await readdir(directory).catch(() => [])).filter(
      (name) => name === 'record.json' || name === 'observed.json'
    );
    if (left.length === 0 || Date.now() >= deadline) {
      return left;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function captured(): AtActivation {
  assert.equal(captureFailed, null, `activation could not be read: ${String(captureFailed)}`);
  assert.ok(atActivation, 'nothing was captured at activation');
  return atActivation;
}

/*
 * A ROOT hook, deliberately: mocha runs every root `suiteSetup` before the first
 * test of the whole run, whatever order the files were loaded in. That is the
 * only place where "read what activation did, then put the window back the way
 * the other suites expect it" can be written -- the alternative is this file
 * sorting first by its name, which is not a property anybody maintains.
 */
suiteSetup(async function () {
  this.timeout(60_000);
  const gripterm = await api();
  const { readiness, registry, identity, lifecycle, gateway } = gripterm;
  const directory = join(readiness.storageDir, 'terminals', SEEDED_TERMINAL);
  const held = registry.list().find((one) => one.terminalId.value === SEEDED_TERMINAL);

  // Only when something was started, and only then: the trace is appended after
  // the launch has answered, so it can lag the report by a moment -- but waiting
  // for a file nobody is going to write would spend ten seconds re-proving what
  // the report has already said.
  if (readiness.restore.kind === 'ran' && readiness.restore.started > 0) {
    const deadline = Date.now() + TRACE_APPEARS_WITHIN_MS;
    while (Date.now() < deadline) {
      const there = await readFile(join(directory, 'starts.jsonl'), 'utf8').catch(() => null);
      if (there !== null) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  atActivation = {
    restore: readiness.restore,
    storageDir: readiness.storageDir,
    held: held !== undefined,
    ownedByThisWindow: held?.owner.ownerId.value === identity.ownerId.value,
    starts: await readFile(join(directory, 'starts.jsonl'), 'utf8').catch(() => ''),
    observedState: held?.observed.state ?? null,
  };

  try {
    if (held !== undefined) {
      // `close` and not `discard`: the record says a conversation is running, and
      // `discard` refuses exactly then. This is the same act as the cross on the
      // tab, and it is what takes the `claude` with it.
      lifecycle.close(held.terminalId);
      await until(
        () => !gateway.listKnown().some((one) => one.terminalId.value === SEEDED_TERMINAL),
        TERMINAL_GOES_WITHIN_MS
      );
      lifecycle.discard(held.terminalId);
      // And then WAIT for it, which is the whole of the fix for a run that went
      // red four times on one machine. See `storeCaughtUp`.
      const left = await storeCaughtUp(directory);
      assert.deepEqual(
        left,
        [],
        `the store had not caught up with the deletion when the directory was taken away: [${left.join(' ')}]`
      );
    }
    // The store goes back to what it was, so that the run after this one meets
    // the seed and nothing else. Reversible by construction: everything here was
    // written by the seeder, into a directory the runner made.
    await rm(directory, { recursive: true, force: true });
  } catch (cause: unknown) {
    captureFailed = `the seeded terminal could not be put away: ${String(cause)}`;
  }
});

suite('what a window does at activation about the records of windows that are gone', () => {
  test('it reads the machine and runs the restore, rather than refusing because this is a test host', () => {
    const { restore } = captured();

    assert.equal(
      restore.kind,
      'ran',
      `activation did not run the restore: ${JSON.stringify(restore)}`
    );
  });

  test('the seeded record came back by itself: planned, started, and adopted by this window', () => {
    const seen = captured();
    const { restore } = seen;
    assert.equal(restore.kind, 'ran', `activation did not run the restore: ${JSON.stringify(restore)}`);

    assert.equal(
      restore.planned,
      SEEDED,
      `the plan held ${String(restore.planned)} records rather than the ${String(SEEDED)} ${SEEDER} seeded`
        + ` (refused: ${String(restore.refused)})`
    );
    assert.equal(
      restore.started,
      SEEDED,
      `not every record ${SEEDER} seeded was started; the window's state for the named one was `
        + String(seen.observedState)
    );
    // Adoption is what lets a record be written at all (§4.8), so it is asserted
    // as the two things it is: this window holds the row, and the store now
    // names this window as its owner rather than the window that closed.
    assert.equal(seen.held, true, `this window does not hold the record ${SEEDER} seeded`);
    assert.equal(seen.ownedByThisWindow, true, 'the record was started without being adopted');
  });

  test('and the start is on disk in the record\'s own trace, which is what S01 asks to see', () => {
    const seen = captured();

    // The one piece of evidence that outlives the process: `starts.jsonl` is
    // appended by the launch itself, in the record's own directory, and the
    // seeder deletes the directory before every run -- so a line here is this
    // run's doing and nobody else's. The record's own id is not in the line,
    // because the line is IN the record: the directory is the id.
    assert.notEqual(seen.starts, '', `no starts.jsonl was written for the record ${SEEDER} seeded`);
    assert.equal(
      seen.starts.includes('"what":"start"'),
      true,
      `the launch trace holds no start at all: ${seen.starts}`
    );
    /*
     * `launch` and not `resume`, asserted rather than tolerated.
     *
     * The seeded conversation has no transcript, and the product's answer to
     * that is a NEW conversation in the same record (owner, 2026-08-21) -- so
     * this word is the difference between the restore reading the machine and
     * the restore having been handed a step. If it ever says `resume`, this run
     * has found a transcript for an id that was invented, and that is worth
     * stopping for rather than passing.
     */
    assert.equal(
      seen.starts.includes('"intent":"launch"'),
      true,
      `the restore did not start the seeded record the way the planner decides: ${seen.starts}`
    );
  });

  test('all of which is allowed only because the store belongs to the run', () => {
    const { storageDir } = captured();

    // Not decoration. Everything above is this suite starting a real `claude` on
    // a record it invented, and the only reason that is not somebody's morning
    // is the store it happens in. If this line ever fails, the three above are
    // not results -- they are an incident.
    assert.notEqual(
      storageDir.toLowerCase(),
      join(homedir(), '.gripterm').toLowerCase(),
      'this run restored records in the store of whoever owns this machine'
    );
  });
});
