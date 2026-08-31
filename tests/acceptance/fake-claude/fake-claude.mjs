/*
 * A stand-in for `claude`, so that the acceptance suite stops costing money.
 *
 * WHY IT EXISTS. `tests/acceptance` is the one set of ours that `tools/gate.mjs`
 * excludes by name, and the reason it gives is the whole of it: those suites
 * "start a real `claude` and spend real turns on the owner's account". That is
 * the largest hole in the gate, and it is also why П2, О3 and О1 had never been
 * walked under `gripterm.terminal.engine: own` -- the engine that became the
 * default on 2026-08-30. This program takes the CLI's place so that the four
 * suites can be run as often as anybody likes, on either engine, for nothing.
 *
 * ==========================================================================
 * WHAT THIS IS NOT. Read this before believing any green it produces.
 * ==========================================================================
 *
 * It is a DOUBLE OF OUR BELIEFS about Claude Code, not of Claude Code. Every
 * behaviour below is either measured -- and then the measurement, its date and
 * the build are named beside it -- or taken from our own code, and then it is
 * marked OUR SIDE, which means: the CLI's behaviour here was never measured, and
 * a test that passes against it proves only that we are consistent with
 * ourselves. A double that guesses wrong turns into a green test that certifies
 * the guess, which is worse than no test at all, because it looks like cover.
 *
 * Named, so that a reader of a passing acceptance run knows what it did NOT
 * establish. This program:
 *
 *   * has no model, no network and no account. Its answer to a prompt is the
 *     prompt, echoed back verbatim (see `answerTo`). П2 asserts that the
 *     assistant's last message contains "pineapple" -- against this program that
 *     assertion establishes that a message TRAVELLED from the agent to the row
 *     and nothing whatever about an agent producing one.
 *   * draws no interface. There is no prompt box, no spinner, no status line, no
 *     ANSI screen of any kind. Anything about how a terminal LOOKS is untested by
 *     a run against this.
 *   * asks nothing before it starts. The real CLI puts a trust prompt in front of
 *     a folder it has not seen (measured 2026-08-13, quoted in
 *     `p2-first-window.test.ts`); this program starts in an unseen folder without
 *     a word. The suites carry an Enter for that prompt and it is never needed
 *     here, so THAT branch of the suites is dead code under this double.
 *   * uses no tools, asks no permissions, starts no subagents and reports no
 *     cost. Of the thirteen hooks `hook-vocabulary.ts` translates it ever emits
 *     four: SessionStart, SessionEnd, UserPromptSubmit and Stop. PreToolUse,
 *     PostToolUse, PostToolUseFailure, PermissionRequest, Notification,
 *     StopFailure, SubagentStart, SubagentStop and CwdChanged are never sent by
 *     anything here, so every rule in this build that reads one of them is
 *     untouched by an acceptance run against this double.
 *   * reads `--add-dir`, `--mcp-config`, `--permission-mode`, `--model`,
 *     `--agent`, `--worktree` and `--append-system-prompt` only far enough to
 *     step over them. None of them does anything. A worktree is not created; a
 *     system prompt is not appended to anything.
 *   * is not one process. `claude.exe` is a single native program and reports NO
 *     arguments at all in `Win32_Process` (measured 2026-08-13, quoted in
 *     `tests/acceptance/run.mjs`). This is a small native launcher that starts
 *     `node` on this file, so the process tree has one process more than the real
 *     thing and its arguments ARE visible. Everything this build reads as "the
 *     pid of the conversation" is the LAUNCHER's pid -- see `theWorldsPidForUs`.
 *   * never talks to the Claude Code extension of the editor. There is no `/ide`
 *     channel, and `gripterm.terminal.ideChannel` does nothing against it.
 *   * knows only the four slash commands below. `/clear`, `/rename`, `/exit` and
 *     `/help`; anything else beginning with a slash is swallowed with a line on
 *     the terminal and no event at all.
 *   * says nothing about whether the real CLI still behaves as written here. The
 *     date that was last checked lives in `tests/acceptance/against-the-real-cli.json`,
 *     and `tests/fake-claude.test.ts` goes red when it is older than that file
 *     allows.
 *
 * ==========================================================================
 * WHAT IT COPIES, AND WHERE EACH ONE CAME FROM
 * ==========================================================================
 *
 * The rule this file obeys is the one `recorded-agent.ts` states for its own
 * subject: COPY the measured behaviour, do not improve on it. A double that
 * behaves better than the thing it stands for makes a rule out of a falsehood.
 * Every entry below is repeated at the code that implements it.
 *
 *   1. `--resume` on a conversation with no transcript sends exactly ONE report
 *      -- `SessionEnd` at about 1.6 s -- and then exits 1 at about 3.15 s.
 *      MEASURED: A45, 2026-08-20, CLI 2.1.233, under a real pty. The `reason` is
 *      `other`, which is also what an unrecognised one collapses into, so the
 *      payload cannot be made to tell this case from an ordinary end. The DELAYS
 *      are copied too: a double that failed instantly would make the restore
 *      timeout untestable and would be, precisely, better than the thing it
 *      stands for.
 *   2. `/clear` produces `SessionEnd(reason: clear)` and then
 *      `SessionStart(source: clear)` with a NEW conversation id, on the same
 *      endpoint. MEASURED: M0/A10, quoted in `p3-clear.test.ts`.
 *   3. `--name X` writes `name: X` into the CLI's own session file with NO
 *      `nameSource` key. MEASURED: M2.19, 2026-08-13, quoted in
 *      `launch-command-builder.ts`.
 *   4. A session started without `--name` carries `"nameSource":"derived"`, and
 *      `/rename` writes the new name and REMOVES the key. MEASURED: 2026-08-13
 *      against 2.1.228, quoted in `session-name.ts`. The absence of that key is
 *      the whole of the evidence that a person chose the name, so a double that
 *      never wrote it would make `readSessionName` untestable.
 *   5. The session file is named after the pid of the process holding the
 *      conversation and lives in `<config>/sessions/`. It SURVIVES a killed
 *      process. MEASURED: A22, quoted in `settings-locations.ts` and
 *      `session-name-mirror.ts`. This program therefore never deletes it on the
 *      way out.
 *   6. `claude agents --json` prints a JSON array and does NOT print a session
 *      whose pid nothing is running as. MEASURED: A24, 2026-08-12, and again
 *      2026-08-27 against 2.1.245 -- quoted in `recorded-agent.ts`. What is
 *      copied is that sentence and not a mechanism: HOW the CLI knows was never
 *      measured, and the first attempt here -- a stored pid plus
 *      `process.kill(pid, 0)` -- turned out to implement a DIFFERENT rule, "a
 *      session whose recorded pid is not in use", which Windows pid recycling
 *      made false within a minute. See `HEARTBEAT_IS_STALE_MS`.
 *   7. Transcripts are `<config>/projects/<directory>/<sessionId>.jsonl`, and the
 *      directory name is the working directory with punctuation replaced by
 *      dashes. READ OUT OF THE BINARY 2.1.228 by an earlier step, quoted in
 *      `settings-locations.ts`; this step measured nothing. What is deliberately
 *      NOT copied is the truncation-and-hash for names past 200 characters --
 *      reproducing a rule with a hash in it is how a second implementation starts
 *      lying, and `readTranscriptIndex` matches on the FILE name anyway.
 *   8. A terminal nothing was typed into leaves NO transcript. MEASURED: 64
 *      launches of 64, quoted in `recorded-agent.ts`. So this program writes the
 *      file on the first turn and not before -- which is what makes П2's wait for
 *      it mean anything.
 *   9. Every hook body names the transcript, whether or not the file is there yet.
 *      MEASURED: quoted in `p2-first-window.test.ts` ("The CLI names the path in
 *      every hook body; whether the FILE is there yet is a different question").
 *  10. `SessionStart` cannot travel over an HTTP hook: build 2.1.225 filters it
 *      unconditionally. READ OUT OF THE BINARY, quoted in
 *      `session-settings-builder.ts`; this step measured nothing. Copied because
 *      it is the entire reason the forwarder exists -- a double that accepted an
 *      HTTP `SessionStart` would let us delete the forwarder and stay green.
 *  11. A hook `timeout` is in SECONDS. READ OUT OF THE BINARY 2.1.224, quoted in
 *      `session-settings-builder.ts`. Copied for the same reason: read as
 *      milliseconds, our two-second hook would be a two-millisecond one and every
 *      event would be dropped by a double that was more patient than the CLI.
 *  12. `$VAR` inside a hook header is interpolated ONLY for names listed in
 *      `allowedEnvVars`; every other `$VAR` becomes an empty string. READ OUT OF
 *      THE BINARY 2.1.225, quoted in `session-settings-builder.ts`. Copied
 *      because it is the difference between our hooks authenticating and every
 *      one of them coming back 401 on a settings file that reads correctly.
 *  13. A command hook is the exec form: `command` is spawned directly with `args`
 *      and no shell, and the payload arrives on its standard input. READ OUT OF
 *      THE BINARY 2.1.225, quoted in `session-settings-builder.ts`.
 *  14. `--version` prints a version and then the product in brackets. OUR SIDE:
 *      `parseCliVersion` reads that shape. This program answers a version that is
 *      deliberately NOT the pinned one, so that a window running against it says
 *      out loud that it is not on the build every fact was measured against.
 *  15. `/exit` leaves with code 0. MEASURED: A13, 2026-08-10.
 *
 * OUR SIDE, and marked as such rather than dressed up as the CLI's:
 *
 *   * every flag it accepts, and the order they may come in. Those are what
 *     `launch-command-builder.ts` BUILDS. Whether the real CLI accepts them in
 *     that order was not measured by this step.
 *   * the field names in a hook body -- `session_id`, `transcript_path`, `cwd`,
 *     `hook_event_name`, `source`, `reason`, `user_input`,
 *     `last_assistant_message`. Those are what `hook-event-parser.ts` READS. The
 *     real bodies certainly carry more, and this program sends nothing else.
 *   * `--settings` being a path to a JSON file whose `hooks` key is the only one
 *     honoured. That is what `session-settings-builder.ts` writes, and A1's
 *     measurement (2026-08-10) is about the CLI MERGING `hooks` with its own
 *     levels, which this program does not do at all: it reads exactly the file it
 *     is given and no user, project or managed level.
 *   * `TURN_TAKES_MS`. A real turn takes seconds; this one has no work to do. The
 *     pause is here so that `working` is a state the suites can observe, and it
 *     is a fact about the harness rather than about any agent.
 *   * HOW `agents --json` knows what is running. The CLI's own mechanism was
 *     never measured -- A22 examined `<config>/sessions/` and refused it as a
 *     source of sessions for US, which says nothing about where the listing comes
 *     from. This double keeps a beat of its own in `<config>/fake-claude-running/`,
 *     a directory the CLI has no such thing as, deliberately outside the layout it
 *     copies. What is copied is the OBSERVABLE rule (6 above): a conversation
 *     whose process is gone is not listed.
 *   * the shape of `agents --json` entries. `kind` and `status` are NOT written,
 *     because nothing here knows what the CLI puts in them, and A24 established
 *     that a missing field is an ordinary sight in that listing. Inventing them
 *     would have been the guess this file exists to avoid.
 *
 * ==========================================================================
 *
 * It refuses to run without `CLAUDE_CONFIG_DIR`, and that is a guard rather than
 * a convenience: everything it writes goes under that directory, and without one
 * it would be writing session files and transcripts into the profile of whoever
 * is logged in.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/** Not `2.1.225`, on purpose: a window running against this must not read as one running against the pin. */
const VERSION_LINE = '0.0.0-double (not Claude Code: the Gripterm acceptance double)';

/** A45, 2026-08-20, CLI 2.1.233: one report at about 1.6 s, exit 1 at about 3.15 s. Copied, delays and all. */
const RESUME_REPORTS_AT_MS = 1600;
const RESUME_EXITS_AT_MS = 3150;

/**
 * OUR SIDE. How long a turn takes here.
 *
 * A real one takes seconds of real work; this one has none. The suites poll at
 * 200 ms and assert that they saw `working` before `idle`, so a turn that ended
 * in the same tick it began would make that assertion a race the harness wins or
 * loses by scheduling. It is the pacing of a test stand, not a claim about any
 * agent.
 */
const TURN_TAKES_MS = 1500;

/**
 * How often this asks whether the process the world sees as this conversation is
 * still there, and how often it says it is still here itself.
 */
const HEARTBEAT_MS = 1000;

/**
 * How old a heartbeat may be before `agents --json` stops counting it.
 *
 * FIVE beats, and the number is the correction of a defect this double had for
 * four runs (found 2026-08-31, editor engine): the listing was answered out of
 * the session files with a liveness check of `process.kill(pid, 0)`, and Windows
 * recycles pids. A `rename from the CLI` conversation that had ended thirty-five
 * seconds earlier came back onto the listing because an unrelated process had
 * taken its pid, and the second sitting of П2 reported two conversations running
 * where there was one. That is the DANGEROUS direction of wrong -- a conversation
 * that is not running, reported as running, is a restore refused -- so the pid is
 * no longer trusted on its own.
 */
const HEARTBEAT_IS_STALE_MS = HEARTBEAT_MS * 5;

/** Ours: the terminal is a pty, and a line arrives with either terminator or both. */
const LINE_BREAK = /\r\n|\r|\n/u;

function main() {
  const argv = process.argv.slice(2);
  // Asked first and in every mode, so that there is no way into this program
  // that skips the guard: everything it writes goes under that directory, and
  // without one it would be writing into somebody's real profile.
  configDirectory();

  if (argv.includes('--version')) {
    process.stdout.write(`${VERSION_LINE}\n`);
    return;
  }
  // A hidden mode, and it earns its keep: the native launcher beside this file
  // has to hand an argument vector across a Windows command line, and
  // `tests/acceptance/run.mjs` refuses to start anything until it has watched a
  // nasty vector come back unchanged through it.
  if (argv[0] === '--gripterm-echo-argv') {
    process.stdout.write(`${JSON.stringify(argv.slice(1))}\n`);
    return;
  }
  if (argv[0] === 'agents') {
    listAgents();
    return;
  }
  session(read(argv));
}

/** Where everything this program writes goes. Absent is a refusal, never a default. */
function configDirectory() {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  if (dir === undefined || dir.trim().length === 0) {
    process.stderr.write(
      'fake-claude: CLAUDE_CONFIG_DIR is not set. This double writes session files and transcripts, ' +
        'and without a profile directory of its own it would write them into a real one.\n'
    );
    process.exit(2);
  }
  return dir;
}

/**
 * The pid the world outside the pty has for this conversation.
 *
 * The editor starts the LAUNCHER, and the launcher starts this, so every pid the
 * product can see -- `ObservedState.pid` from the gateway, the name of the
 * session file `SessionNameMirror` opens, the pid in `agents --json` -- is the
 * launcher's and not this process's. Measured 2026-08-31 with node-pty 1.1.0:
 * the pid the pty reports is exactly the parent of the process it starts.
 *
 * When this file is run directly -- which is how `tests/fake-claude.test.ts`
 * runs it -- the parent is whatever started it, and that is the right answer for
 * the same reason.
 */
function theWorldsPidForUs() {
  return process.ppid > 0 ? process.ppid : process.pid;
}

/** Whether a process is there. The rule `agents --json` was measured to apply (A24). */
function isThere(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM is a process we are not allowed to signal, which is a process that
    // exists. Only ESRCH means gone.
    return error.code === 'EPERM';
  }
}

// --- the argument vector -----------------------------------------------------

/**
 * The flags this build BUILDS, read only as far as stepping over them.
 *
 * OUR SIDE, and the list is `launch-command-builder.ts`'s. Anything not named
 * here is refused rather than ignored: a double that shrugged at an unknown flag
 * would let a launch line grow one nobody implemented and stay green.
 */
const VARIADIC = new Set(['--add-dir', '--mcp-config']);
const SCALAR = new Set([
  '--permission-mode',
  '--model',
  '--agent',
  '--worktree',
  '--append-system-prompt',
]);

function read(argv) {
  const plan = {
    intent: null,
    sessionId: null,
    name: null,
    settingsPath: null,
    addDirs: [],
    mcpConfigPaths: [],
  };

  for (let at = 0; at < argv.length; at += 1) {
    const flag = argv[at];
    if (VARIADIC.has(flag)) {
      const into = flag === '--add-dir' ? plan.addDirs : plan.mcpConfigPaths;
      // `--add-dir <directories...>` swallows every token up to the next flag
      // (A2). OUR SIDE here: this reproduces how we BUILD the line, and the
      // behaviour of the real parser was not measured by this step.
      while (at + 1 < argv.length && !argv[at + 1].startsWith('--')) {
        at += 1;
        into.push(argv[at]);
      }
      continue;
    }
    if (SCALAR.has(flag)) {
      at += 1;
      continue;
    }
    if (flag === '--session-id' || flag === '--resume') {
      plan.intent = flag === '--session-id' ? 'launch' : 'resume';
      at += 1;
      plan.sessionId = argv[at] ?? null;
      continue;
    }
    if (flag === '--name') {
      at += 1;
      plan.name = argv[at] ?? null;
      continue;
    }
    if (flag === '--settings') {
      at += 1;
      plan.settingsPath = argv[at] ?? null;
      continue;
    }
    process.stderr.write(`fake-claude: this double was never taught the flag ${String(flag)}\n`);
    process.exit(64);
  }

  if (plan.intent === null || plan.sessionId === null) {
    process.stderr.write('fake-claude: neither --session-id nor --resume was given\n');
    process.exit(64);
  }
  return plan;
}

// --- the hooks ---------------------------------------------------------------

/**
 * The hook table out of the file `--settings` names.
 *
 * OUR SIDE: `hooks` is the only key this reads, because it is the only key
 * `SessionSettingsBuilder` writes. The CLI merges that key across its own
 * levels (A1, 2026-08-10) and this does not merge anything -- there is no user,
 * project or managed level here at all.
 */
function hooksFrom(settingsPath) {
  if (settingsPath === null) {
    return {};
  }
  try {
    const document = JSON.parse(readFileSync(settingsPath, 'utf8'));
    return document?.hooks ?? {};
  } catch (error) {
    process.stderr.write(`fake-claude: the settings file could not be read: ${String(error)}\n`);
    return {};
  }
}

/**
 * `$VAR` in a header value, for the names the file allowed and no others.
 *
 * Copied from the binary quote in `session-settings-builder.ts` [2.1.225]: "all
 * other $VAR references are left as empty strings". Read out of the binary by an
 * earlier step; this one measured nothing.
 */
function interpolate(value, allowed) {
  return String(value).replace(/\$([A-Za-z_]\w*)/gu, (_whole, name) =>
    allowed.includes(name) ? (process.env[name] ?? '') : ''
  );
}

async function postHook(hook, body) {
  const target = new URL(hook.url);
  const transport = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const allowed = Array.isArray(hook.allowedEnvVars) ? hook.allowedEnvVars : [];
  const headers = { 'content-type': 'application/json' };
  for (const [name, value] of Object.entries(hook.headers ?? {})) {
    headers[name] = interpolate(value, allowed);
  }
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  headers['content-length'] = payload.length;

  await new Promise((resolve) => {
    const done = () => { resolve(); };
    const call = transport(
      target,
      // SECONDS, not milliseconds [binary 2.1.224, quoted in
      // `session-settings-builder.ts`]. Copied: read as milliseconds, a
      // two-second hook would time out in two milliseconds and this double would
      // be less patient than the CLI in a way no test could see.
      { method: 'POST', timeout: secondsOf(hook.timeout, 2), headers },
      (answer) => {
        answer.resume();
        answer.on('end', done);
        answer.on('error', done);
      }
    );
    call.on('timeout', () => { call.destroy(); });
    call.on('error', done);
    call.end(payload);
  });
}

/**
 * The exec form: the command is spawned directly with its arguments and no
 * shell, and the payload arrives on standard input [binary 2.1.225, quoted in
 * `session-settings-builder.ts`].
 *
 * Its standard output is discarded here. The real CLI appends the stdout of a
 * `SessionStart` hook to the conversation as `additionalContext` -- which is the
 * reason the forwarder never writes a byte to it -- and there is no conversation
 * here to append anything to.
 */
async function runCommandHook(hook, body) {
  await new Promise((resolve) => {
    let child;
    try {
      child = spawn(hook.command, hook.args ?? [], { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch (error) {
      process.stderr.write(`fake-claude: a command hook would not start: ${String(error)}\n`);
      resolve();
      return;
    }
    const timer = setTimeout(() => { child.kill(); }, secondsOf(hook.timeout, 5));
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    child.on('error', done);
    child.on('close', done);
    child.stdin.on('error', done);
    child.stdin.end(JSON.stringify(body));
  });
}

function secondsOf(timeout, fallback) {
  return (typeof timeout === 'number' && timeout > 0 ? timeout : fallback) * 1000;
}

/**
 * One report, to whatever the settings file registered for it.
 *
 * The `SessionStart` rule is copied and not improved on: build 2.1.225 filters
 * that event out of every HTTP hook unconditionally [binary, quoted in
 * `session-settings-builder.ts`], so a registration for it over HTTP costs no
 * error and no event either. A double that delivered it anyway would let the
 * forwarder be deleted with every suite still green.
 */
async function report(hooks, hookEventName, body) {
  const full = { ...body, hook_event_name: hookEventName };
  for (const registration of hooks[hookEventName] ?? []) {
    for (const hook of registration.hooks ?? []) {
      if (hook.type === 'command') {
        await runCommandHook(hook, full);
      } else if (hook.type === 'http' && hookEventName !== 'SessionStart') {
        await postHook(hook, full);
      }
    }
  }
}

// --- what the CLI keeps on disk ----------------------------------------------

/**
 * Where the transcript of a conversation goes.
 *
 * The directory rule is the binary's [2.1.228, quoted in
 * `settings-locations.ts`]: the working directory with everything that is not a
 * letter or a digit replaced by a dash. The truncation-and-hash past 200
 * characters is deliberately NOT reproduced -- see the header.
 */
function transcriptPathFor(config, cwd, sessionId) {
  return join(config, 'projects', cwd.replace(/[^a-zA-Z0-9]/gu, '-'), `${sessionId}.jsonl`);
}

/** Whether this conversation has a transcript, asked the way `readTranscriptIndex` asks it: by file name. */
function hasTranscript(config, sessionId) {
  const projects = join(config, 'projects');
  if (!existsSync(projects)) {
    return false;
  }
  for (const project of readdirSync(projects, { withFileTypes: true })) {
    if (project.isDirectory() && existsSync(join(projects, project.name, `${sessionId}.jsonl`))) {
      return true;
    }
  }
  return false;
}

function sessionsDirectory(config) {
  return join(config, 'sessions');
}

/**
 * The double's OWN bookkeeping, and it is deliberately not in the CLI's layout.
 *
 * `sessions/` is a shape this program COPIES (behaviour 5), and nothing may be
 * added to it that the CLI does not put there -- a reader comparing the two would
 * be comparing our invention with a measurement. What lives here instead is the
 * one thing this program needs and the CLI presumably gets from somewhere we
 * never measured: a way to tell a live conversation from a session file left by a
 * dead process whose pid has been reused. A beat, written while the process is
 * alive, is the cheapest honest answer.
 */
function runningDirectory(config) {
  return join(config, 'fake-claude-running');
}

function beat(config, record) {
  const dir = runningDirectory(config);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${String(record.pid)}.json`);
  const scratch = `${file}.${String(process.pid)}.writing`;
  writeFileSync(scratch, JSON.stringify({ ...record, aliveAt: Date.now() }), 'utf8');
  renameSync(scratch, file);
}

/**
 * The CLI's own file about the process holding a conversation.
 *
 * Written whole and renamed into place, so that `readSessionName` -- which is
 * polled every two seconds from another process -- never opens half of one.
 * NEVER DELETED: A22 measured that this file survives a killed process, and
 * `agents --json` filters on liveness instead. A double that tidied up after
 * itself would hide the case that filter exists for.
 */
function writeSessionFile(config, record) {
  const dir = sessionsDirectory(config);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${String(record.pid)}.json`);
  const scratch = `${file}.${String(process.pid)}.writing`;
  writeFileSync(scratch, JSON.stringify(record, null, 2), 'utf8');
  renameSync(scratch, file);
}

/**
 * The name the CLI gives a conversation nobody named.
 *
 * Measured shape, quoted in `session-name.ts`: the CLI names a fresh
 * conversation after its folder (`trudocker-50`). The suffix is this double's
 * own and is not a claim about how the CLI picks one.
 */
function derivedName(cwd) {
  return `${basename(cwd)}-double`;
}

// --- `claude agents --json` ---------------------------------------------------

/**
 * What is running, out of the session files, minus everything whose process is
 * gone.
 *
 * The liveness filter is behaviour 6 in the header: measured A24 2026-08-12, and
 * again 2026-08-27 against 2.1.245. `kind` and `status` are absent because
 * nothing here knows what belongs in them, and A24 established that a field
 * missing from this listing is an ordinary sight rather than evidence of
 * anything.
 */
function listAgents() {
  const dir = runningDirectory(configDirectory());
  const running = [];
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) {
        continue;
      }
      let record;
      try {
        record = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      } catch {
        continue;
      }
      if (typeof record?.pid !== 'number' || !isThere(record.pid)) {
        continue;
      }
      if (typeof record.aliveAt !== 'number' || Date.now() - record.aliveAt > HEARTBEAT_IS_STALE_MS) {
        continue;
      }
      running.push({
        sessionId: record.sessionId,
        pid: record.pid,
        cwd: record.cwd,
        startedAt: record.startedAt,
        name: record.name,
      });
    }
  }
  process.stdout.write(`${JSON.stringify(running)}\n`);
}

// --- a session ---------------------------------------------------------------

/**
 * The one answer this program has, and the whole of what makes П2's assertion
 * about the last assistant message worth as little as it is worth.
 *
 * It echoes the prompt. There is no model here and there is not going to be one;
 * an echo is the rule a reader can check by eye, and it is chosen over anything
 * cleverer for exactly that reason -- a double that produced plausible answers
 * would invite somebody to believe the answer.
 */
function answerTo(prompt) {
  return prompt;
}

function session(plan) {
  const config = configDirectory();
  const cwd = process.cwd();
  const hooks = hooksFrom(plan.settingsPath);
  const state = {
    sessionId: plan.sessionId,
    name: plan.name,
    // Behaviour 4: a name nobody chose is marked `derived`, and that mark being
    // absent is the whole of the evidence that a person chose one.
    nameSource: plan.name === null ? 'derived' : null,
    startedAt: Date.now(),
    busy: Promise.resolve(),
  };
  if (state.name === null) {
    state.name = derivedName(cwd);
  }

  const bodyFor = (extra) => ({
    session_id: state.sessionId,
    transcript_path: transcriptPathFor(config, cwd, state.sessionId),
    cwd,
    ...extra,
  });

  /** Everything that touches the wire goes through here, so two turns cannot interleave. */
  const queue = (work) => {
    state.busy = state.busy.then(work, work);
    return state.busy;
  };

  if (plan.intent === 'resume' && !hasTranscript(config, state.sessionId)) {
    // Behaviour 1, delays included.
    process.stdout.write('No conversation found to resume.\n');
    setTimeout(() => {
      void report(hooks, 'SessionEnd', bodyFor({ reason: 'other' }));
    }, RESUME_REPORTS_AT_MS);
    setTimeout(() => {
      process.exit(1);
    }, RESUME_EXITS_AT_MS);
    return;
  }

  const publish = () => {
    const pid = theWorldsPidForUs();
    writeSessionFile(config, {
      sessionId: state.sessionId,
      pid,
      cwd,
      name: state.name,
      startedAt: state.startedAt,
      ...(state.nameSource === null ? {} : { nameSource: state.nameSource }),
    });
    beat(config, { sessionId: state.sessionId, pid, cwd, name: state.name, startedAt: state.startedAt });
  };

  publish();
  process.stdout.write(`${VERSION_LINE}\n`);
  process.stdout.write(`conversation ${state.sessionId} in ${cwd}\n`);
  void queue(async () => {
    await report(
      hooks,
      'SessionStart',
      bodyFor({ source: plan.intent === 'resume' ? 'resume' : 'startup' })
    );
  });

  const turn = (prompt) =>
    queue(async () => {
      await report(hooks, 'UserPromptSubmit', bodyFor({ user_input: prompt }));
      await new Promise((resolve) => setTimeout(resolve, TURN_TAKES_MS));
      const answer = answerTo(prompt);
      appendTranscript(config, cwd, state.sessionId, prompt, answer);
      process.stdout.write(`${answer}\n`);
      await report(hooks, 'Stop', bodyFor({ last_assistant_message: answer }));
    });

  const clear = () =>
    queue(async () => {
      // Behaviour 2: an end, then a beginning under a new id, on the same
      // endpoint.
      await report(hooks, 'SessionEnd', bodyFor({ reason: 'clear' }));
      state.sessionId = randomUUID();
      publish();
      process.stdout.write(`conversation ${state.sessionId}\n`);
      await report(hooks, 'SessionStart', bodyFor({ source: 'clear' }));
    });

  const rename = (name) => {
    // Behaviour 4: the new name, and the `derived` mark removed. No hook and no
    // event: the CLI offers neither, which is why `SessionNameMirror` polls this
    // file rather than listening for anything.
    state.name = name;
    state.nameSource = null;
    publish();
    process.stdout.write(`renamed to ${name}\n`);
  };

  listen({
    onLine: (line) => {
      const text = line.trim();
      if (text.length === 0) {
        return;
      }
      if (!text.startsWith('/')) {
        void turn(text);
        return;
      }
      const [command, ...rest] = text.split(/\s+/u);
      switch (command) {
        case '/clear':
          void clear();
          return;
        case '/rename':
          if (rest.length > 0) {
            rename(rest.join(' '));
          }
          return;
        case '/exit':
          // A13, 2026-08-10: `/exit` gives code 0.
          void state.busy.then(() => { process.exit(0); }, () => { process.exit(0); });
          return;
        default:
          process.stdout.write(`this double knows /clear, /rename, /exit and /help, and not ${command}\n`);
      }
    },
    onEnd: () => { process.exit(0); },
  });

  // The terminal is gone when the process the editor started is gone. Ours, and
  // it is here because this program is a grandchild of the pty: nothing else
  // would tell it that the window it was drawn in has closed.
  const watch = setInterval(() => {
    if (!isThere(theWorldsPidForUs())) {
      process.exit(0);
    }
    beat(config, {
      sessionId: state.sessionId,
      pid: theWorldsPidForUs(),
      cwd,
      name: state.name,
      startedAt: state.startedAt,
    });
  }, HEARTBEAT_MS);
  watch.unref();
}

/**
 * A transcript line per turn, and the file created on the first one.
 *
 * Behaviour 8: a terminal nothing was typed into leaves no transcript at all, so
 * this is the only place the file is ever made. Its CONTENT is this double's own
 * invention -- nothing in this build reads a transcript's contents, only whether
 * a file of that name exists -- and it is deliberately marked as a double's, so
 * that a person who opens one is not misled about where it came from.
 */
function appendTranscript(config, cwd, sessionId, prompt, answer) {
  const file = transcriptPathFor(config, cwd, sessionId);
  mkdirSync(join(file, '..'), { recursive: true });
  const at = new Date().toISOString();
  const lines = [
    JSON.stringify({ type: 'user', sessionId, timestamp: at, writtenBy: 'the Gripterm acceptance double', text: prompt }),
    JSON.stringify({ type: 'assistant', sessionId, timestamp: at, writtenBy: 'the Gripterm acceptance double', text: answer }),
  ];
  const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
  writeFileSync(file, `${before}${lines.join('\n')}\n`, 'utf8');
}

/** Typed lines, off a pty or off a pipe. */
function listen(handlers) {
  let pending = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split(LINE_BREAK);
    pending = lines.pop() ?? '';
    for (const line of lines) {
      handlers.onLine(line);
    }
  });
  process.stdin.on('end', handlers.onEnd);
  process.stdin.on('error', handlers.onEnd);
  process.stdin.resume();
}

main();
