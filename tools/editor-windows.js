'use strict';

const { execFileSync } = require('node:child_process');

/**
 * What a runner that opens a real editor asks the operating system, and how
 * often it is allowed to ask.
 *
 * **The defect this exists for, measured 2026-08-26.** A full gate on `78f3eb0`
 * went red at the `stand` stage, and the stand died in its fourth sitting
 * WITHOUT A VERDICT -- an uncaught `execFileSync` failure with
 * `status: 3221225794` (`0xC0000142`, `STATUS_DLL_INIT_FAILED`) and empty
 * `stdout` and `stderr`. That is not the script failing and not PowerShell
 * failing: it is Windows declining to create the process at all, which is why
 * neither stream holds a character. The same commit re-run was green, so what
 * decides it is what else the machine is holding open.
 *
 * Two answers, and this file is both of them.
 *
 *   * **A wait asks `process.kill(pid, 0)`, which starts nothing.** Enumerating
 *     windows costs a whole `powershell.exe`, and the stand's close-wait paid
 *     that once every 500 ms with no bound but its own deadline. PowerShell is
 *     left where an answer needs a WINDOW and not a process -- which is once at
 *     the top of a sitting, once after it, and once to ask a window to close.
 *   * **A refusal to create a process is said in words, and asked again.** A
 *     stack ending in `at powershell (...)` says nothing about a machine out of
 *     desktop heap, and it is the whole reason such a run has no verdict.
 *
 * **The count, measured rather than read off the shape of the code.** A whole
 * run of the stand on 2026-08-26 started TWENTY `powershell.exe`, five per
 * sitting -- and only ONE of the five was a poll. One enumeration takes 750 to
 * 1462 ms on this machine, longer than a window takes to go, so the close-wait
 * answered on its first look every time. Removing the loop takes twenty to
 * sixteen and no further, which is why `ASKED_AGAIN` below is part of the same
 * fix and not a second thought: the run has to survive being told no.
 *
 * **CommonJS, and for the reason written at the head of `tools/fork-build.js`.**
 * Three module systems read the tools: the runners are ESM and reach them
 * through `createRequire`, and `tests/editor-windows.test.ts` is Jest. Nothing
 * builds this, so a runner can name its own death before anything is compiled.
 *
 * **What it deliberately does not do: replace the copies in
 * `tests/eyes/run.mjs` and `tests/acceptance/run.mjs`.** Both hold the same
 * `powershell` and `editorWindows`, and the eyes has the same per-poll
 * enumeration in its close-wait. Moving them here is right and is not this
 * change: neither runner was measured today, and a runner that opens an editor
 * is not something to alter without running it.
 */

/** How many times this module has started `powershell.exe` in this process. */
let launched = 0;

/**
 * The launches so far, which is the number the fix of 2026-08-26 is about.
 *
 * Counted here rather than by watching the machine, and the limit of that is
 * worth saying: it counts what OUR runners start and cannot see a process the
 * editor starts for itself.
 */
function powershellRuns() {
  return launched;
}

/** Where an NTSTATUS failure begins. Anything at or above it is the operating system answering, not a script. */
const NTSTATUS_FAILURE = 0xc0000000;

/** The NTSTATUS codes seen on this machine, by name. Anything else is still named, by its number. */
const NTSTATUS_NAMES = new Map([
  [0xc0000142, 'STATUS_DLL_INIT_FAILED'],
  [0xc0000017, 'STATUS_NO_MEMORY'],
  [0xc000012d, 'STATUS_COMMITMENT_LIMIT'],
  [0xc0000135, 'STATUS_DLL_NOT_FOUND'],
]);

/** What libuv says when the machine had nothing left to make a process out of. */
const OUT_OF = new Set(['EMFILE', 'ENFILE', 'ENOMEM', 'EAGAIN']);

/** `0xC0000142`, from `3221225794`. */
function hex(status) {
  return `0x${status.toString(16).toUpperCase().padStart(8, '0')}`;
}

/**
 * The sentence a failure to CREATE the process gets, or `null` for a failure
 * that is the script's own business.
 *
 * The two halves are two layers saying no to the same thing. Windows declines
 * with an NTSTATUS and no output at all; Node declines before it gets that far
 * and says `EMFILE` or `ENOMEM`. A reader should not have to know which layer
 * answered in order to read "too much is open".
 *
 * **Output means the process ran**, whatever killed it afterwards, so a failure
 * that wrote anything is left alone. Renaming those would hide a real error
 * behind a sentence about desktop heap -- which is the same defect as the one
 * this fixes, pointed the other way.
 */
function refusedToStart(failure) {
  const { code, status, stdout, stderr } = failure;
  const spoke = String(stdout ?? '').length > 0 || String(stderr ?? '').length > 0;
  const why =
    typeof code === 'string' && OUT_OF.has(code)
      ? `Node could not start it at all and said ${code}`
      : typeof status === 'number' && status >= NTSTATUS_FAILURE && !spoke
        ? `powershell.exe came back with status ${String(status)} (${hex(status)}, ` +
          `${NTSTATUS_NAMES.get(status) ?? 'an NTSTATUS failure this file has no name for'}) ` +
          'and NOTHING on either stream, which is what it looks like when nothing of it ever ran'
        : null;
  if (why === null) {
    return null;
  }
  return (
    `this run asked for a process and did not get one: ${why}. ` +
    'Windows refused to create the process, or ended it before it could write a character. ' +
    'On this machine that is the session running out of something the windows already open are ' +
    'holding -- desktop heap, handles, memory -- and not a fault in the script it was handed. ' +
    'Nothing was measured from here on, so this run has no verdict for anyone to read: close ' +
    'what can be closed and run it again.'
  );
}

/**
 * How many times a refusal to create the process is answered by asking again,
 * and how long is left between the asks.
 *
 * **This is a symptom being treated, and here is the bargain (II.5).** MEASURED
 * 2026-08-26: one whole run of the stand starts TWENTY `powershell.exe` over
 * four minutes, four per sitting at the edges plus one poll -- and the gate that
 * died was refused one of those twenty. Twenty launches spread over four minutes
 * is not what exhausts a session; the four editor windows the stand opens, and
 * the editor the owner of the machine is working in, are. So making the number
 * smaller prevents nothing on its own, and what the run actually needs is to
 * survive being told no once.
 *
 * **Conditions it holds under:** the shortage is TRANSIENT -- windows are
 * closing and handles are coming back -- and asking again is free when it is
 * not, because a `CreateProcess` that was refused consumed nothing. Five seconds
 * of waiting is cheap against a seven-minute gate that ends with no verdict.
 *
 * **Condition for taking it away:** a runner that no longer starts a process to
 * find out what it can find out without one. The stand is down to four launches
 * a sitting and every one of them is a question about WINDOWS; the day it knows
 * its own window by the pid it spawned, three of the four go, and this goes with
 * them.
 */
const ASKED_AGAIN = 2;
const BEFORE_ASKING_AGAIN_MS = 2000;

/**
 * Waits without giving the event loop away.
 *
 * `powershell` is synchronous -- its whole point is that a runner blocks on the
 * answer -- so the wait between two attempts has to be synchronous too, and
 * `Atomics.wait` on a lock nobody else holds is the one way Node has of doing
 * that.
 */
function holdOn(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Runs one PowerShell script, counts every attempt, and names a refusal to start.
 *
 * `run` and `pause` are seams, and narrow ones on purpose: the outcome this file
 * exists for cannot be produced by a test that does not exhaust the machine it
 * runs on, and a rule no test can reach is a rule nobody can say still holds. It
 * is the same argument the product's `SignalProbe` is written under.
 */
function powershell(script, run = execFileSync, pause = holdOn) {
  let refused = null;
  for (let attempt = 1; ; attempt += 1) {
    launched += 1;
    try {
      return run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
      }).trim();
    } catch (failure) {
      const named = refusedToStart(failure);
      if (named === null) {
        throw failure;
      }
      refused = failure;
      if (attempt > ASKED_AGAIN) {
        // `cause` and not a replacement: the status, the streams and the
        // original stack are the evidence, and a sentence that threw them away
        // would read well and answer nothing.
        throw new Error(`${named} Windows refused it ${String(attempt)} times.`, {
          cause: refused,
        });
      }
      pause(BEFORE_ASKING_AGAIN_MS);
    }
  }
}

/**
 * The editor windows on this machine right now, by pid.
 *
 * A window and not a process: an editor is a dozen processes and one of them has
 * a main window handle. `Cursor` and `Code` by name, because both are editors a
 * runner may have started and either may be the one the owner is sitting in.
 *
 * `Get-Process -Name Cursor,Code` is NOT what this asks, and the difference cost
 * the stand its first run: a name in that list that nothing is running under is
 * a non-terminating error, `-ErrorAction SilentlyContinue` hides the message and
 * not the failed status, and PowerShell then exits 1 with the right answer on
 * its stdout. `execFileSync` reads that as a crash. Every process is enumerated
 * instead and the names are matched here, which cannot fail whichever editors
 * happen to be running; `@()` around it keeps a single match a list rather than
 * a scalar.
 */
function editorWindows() {
  const out = powershell(
    '@(Get-Process | Where-Object {' +
      ' ($_.ProcessName -eq \'Cursor\' -or $_.ProcessName -eq \'Code\')' +
      ' -and $_.MainWindowHandle -ne 0 }) | ForEach-Object { $_.Id }'
  );
  return out.length === 0 ? [] : out.split(/\r?\n/u).map((line) => Number(line.trim()));
}

/** Which of these pids still have a window, at the cost of a whole process. */
function windowsAmong(pids) {
  const open = editorWindows();
  return pids.filter((pid) => open.includes(pid));
}

/** Asks one window to close the way a person closes it, so that deactivation runs. */
function closeWindow(pid) {
  powershell(
    `$p = Get-Process -Id ${String(pid)} -ErrorAction SilentlyContinue;` +
      ' if ($p) { $null = $p.CloseMainWindow() }'
  );
}

/** The one `process.kill` outcome that means the process is not there. */
const NO_SUCH_PROCESS = 'ESRCH';

const sendSignalZero = (pid) => {
  process.kill(pid, 0);
};

/**
 * Whether a process answers to that pid, asked without starting anything.
 *
 * The table is the product's own, in
 * `packages/core/src/infrastructure/process-liveness.ts`, and it is spelled a
 * second time here rather than imported for two reasons: nothing under `out/`
 * resolves `@gripterm/core`, and a harness that measures the product should not
 * decide when to stop waiting by asking the product. No exception means it is
 * there, `ESRCH` means it is not, and every other refusal -- `EPERM` above all
 * -- means it is there and not ours to signal. A pid that cannot be signalled at
 * all is answered "there": `process.kill(0, 0)` signals the CALLER's own process
 * group and never throws, and a negative pid gives `ESRCH`, so one bad number
 * would otherwise produce two opposite wrong answers. Every caller here reads
 * "there" as "keep waiting", which is the direction that never walks on over
 * somebody else's window.
 */
function isRunning(pid, probe = sendSignalZero) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return true;
  }
  try {
    probe(pid);
    return true;
  } catch (cause) {
    return cause.code !== NO_SUCH_PROCESS;
  }
}

/** Which of these pids are still running, at the cost of nothing at all. */
function runningAmong(pids) {
  return pids.filter((pid) => isRunning(pid));
}

const wait = (ms) => new Promise((wake) => setTimeout(wake, ms));

/**
 * Waits until not one of `pids` is left, and says how long each of them took.
 *
 * `still` is what decides, and it defaults to the question that starts nothing.
 * `also` is a second question that is WRITTEN DOWN and decides nothing, and it
 * exists for one reason: "the window is gone" and "the process is gone" are two
 * events, and moving a wait from the first to the second is only honest if
 * somebody has measured the gap. A watcher that never settles costs the wait its
 * deadline and never its life -- the answer the wait was for is already in.
 */
async function waitUntilGone(pids, options) {
  const {
    withinMs,
    pollMs,
    sleep = wait,
    now = Date.now,
    still = runningAmong,
    also = null,
  } = options;
  const started = now();
  const deadline = started + withinMs;
  const when = new Map(pids.map((pid) => [pid, { pid, afterMs: null, alsoAfterMs: null }]));
  let waiting = [...pids];
  let watching = also === null ? [] : [...pids];
  let polls = 0;
  for (;;) {
    polls += 1;
    if (waiting.length > 0) {
      const left = still(waiting);
      for (const pid of waiting.filter((one) => !left.includes(one))) {
        when.get(pid).afterMs = now() - started;
      }
      waiting = left;
    }
    if (watching.length > 0) {
      const left = also(watching);
      for (const pid of watching.filter((one) => !left.includes(one))) {
        when.get(pid).alsoAfterMs = now() - started;
      }
      watching = left;
    }
    if (waiting.length === 0 && watching.length === 0) {
      return { polls, gone: [...when.values()] };
    }
    if (now() > deadline) {
      if (waiting.length === 0) {
        return { polls, gone: [...when.values()] };
      }
      throw new Error(
        `gave up waiting for ${waiting.join(', ')} to be gone after ${String(withinMs)} ms`
      );
    }
    await sleep(pollMs);
  }
}

/**
 * Of the windows open now, the ones this run opened -- and nothing else.
 *
 * The one rule that keeps a runner away from the window the owner of this
 * machine is working in. A difference of pid sets and not a filter on the
 * command line, which breaks the day somebody opens a second copy with the same
 * user data directory, and not a kill by name, which would close the owner's
 * window every time.
 */
function opened(before, now) {
  return now.filter((pid) => !before.includes(pid));
}

/** Of the windows that were there before, the ones that are not there now. */
function lost(before, survivors) {
  return before.filter((pid) => !survivors.includes(pid));
}

module.exports = {
  closeWindow,
  editorWindows,
  isRunning,
  lost,
  opened,
  powershell,
  powershellRuns,
  refusedToStart,
  runningAmong,
  waitUntilGone,
  windowsAmong,
};
