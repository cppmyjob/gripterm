import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as os from 'node:os';
import * as vscode from 'vscode';
import type { GriptermApi } from '../../packages/extension/src/extension';

/**
 * The archive, installed and asked to work.
 *
 * The last acceptance line of M3.12: "a VSIX installed from the archive brings a
 * terminal up on this machine". Every other suite in this repository runs the
 * extension from `--extensionDevelopmentPath`, which is a directory with
 * `node_modules` in it, sources beside the bundle and nothing filtered by
 * `.vscodeignore`. That layout answers a different question from the one a person
 * installing the extension asks, and the difference is not theoretical: a
 * dependency cannot reach a published archive by being a dependency (`vsce`
 * ignores `node_modules/**` in its own glob), so the `own` engine's addon travels
 * as a COPY -- and until this run existed, nothing had ever loaded that copy from
 * the place the editor unpacks it to.
 *
 * **Not mocha, and not `@vscode/test-cli`.** `extensionTestsPath` needs a module
 * with a `run()`, and that is all this needs to be: five checks, named, run in
 * order, each one reported. The runner would have to be given an
 * `extensionDevelopmentPath` -- it always passes one -- and a development copy of
 * this same extension loaded beside the installed one is exactly the confusion
 * this run exists to avoid.
 *
 * **The anti-vacuum checks come first.** A run against a development copy would
 * pass every assertion below about terminals and prove nothing about packaging,
 * so the first check asserts where the code came from, and the third asserts
 * which engine answered.
 */

/** Where `tests/vsix/run.mjs` installed the archive. The suite refuses to guess. */
const EXTENSIONS_DIR = process.env.GRIPTERM_VSIX_EXTENSIONS;

/**
 * Who `run.mjs` chose to answer as `claude`, and where it put the double.
 *
 * Both come from the run rather than from this file's own reading of the
 * environment: the answer to "is a real CLI about to be started" has to be the
 * one the run acted on, not a second guess at it.
 */
const AGENT = process.env.GRIPTERM_VSIX_AGENT ?? 'fake';
const DOUBLE = process.env.GRIPTERM_VSIX_DOUBLE ?? '';

const EXTENSION_ID = 'gripterm-placeholder.gripterm';

/** Everything a gateway said while it was under test, so a refusal can be read rather than assumed. */
class CollectedLog {
  public readonly lines: string[] = [];

  public info(message: string): void {
    this.lines.push(`info: ${message}`);
  }

  public warn(message: string): void {
    this.lines.push(`warn: ${message}`);
  }

  public error(message: string): void {
    this.lines.push(`error: ${message}`);
  }
}

function extension(): vscode.Extension<GriptermApi> {
  const found = vscode.extensions.getExtension<GriptermApi>(EXTENSION_ID);
  assert.ok(found, `${EXTENSION_ID} is not in this editor at all`);
  return found;
}

async function api(): Promise<GriptermApi> {
  return await extension().activate();
}

/** Every file under a directory, as `/` separated paths relative to it. */
function filesUnder(root: string, prefix = ''): readonly string[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    return statSync(join(root, entry.name)).isDirectory()
      ? filesUnder(join(root, entry.name), relative)
      : [relative];
  });
}

/** Waits for something on somebody else's schedule, or gives up saying what it wanted. */
async function waitFor(what: string, ready: () => boolean, ms = 30_000): Promise<void> {
  const until = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > until) {
      throw new Error(`gave up waiting for ${what} after ${String(ms)} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Waits for an answer rather than for a condition, so what was waited for can be used afterwards. */
async function waitUntil<T>(what: string, ready: () => T | null, ms = 30_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const answer = ready();
    if (answer !== null) {
      return answer;
    }
    if (Date.now() > until) {
      throw new Error(`gave up waiting for ${what} after ${String(ms)} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Whether a pid is still a process. The only honest answer about something we started. */
function stillThere(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function nodePath(): string {
  const found = execFileSync('where', ['node'], { encoding: 'utf8' }).split(/\r?\n/u)[0];
  return found === undefined ? 'node' : found.trim();
}

interface Check {
  readonly what: string;
  readonly run: () => Promise<void>;
}

const CHECKS: readonly Check[] = [
  {
    what: 'the extension under test is the installed archive and not the repository',
    run: async () => {
      assert.ok(
        EXTENSIONS_DIR !== undefined,
        'GRIPTERM_VSIX_EXTENSIONS is unset -- run this through tests/vsix/run.mjs, which is what installs the archive'
      );
      const where = extension().extensionPath;
      assert.ok(
        where.toLowerCase().startsWith(EXTENSIONS_DIR.toLowerCase()),
        `the extension answering here lives in ${where}, not under the temporary extensions directory ${EXTENSIONS_DIR} -- ` +
        'this run is testing a development copy, and every check after this one would be about the wrong tree'
      );
      // The two halves of "this is an archive": the bundle is there, and the
      // sources `.vscodeignore` strips are not.
      assert.ok(existsSync(join(where, 'dist', 'extension.js')), 'the installed extension has no bundle');
      assert.equal(existsSync(join(where, 'src')), false, 'the installed extension carries its own sources');
      assert.equal(
        existsSync(join(where, 'node_modules')),
        false,
        'the installed extension carries a node_modules tree, which is what the copy of node-pty exists to avoid'
      );
    },
  },
  {
    what: 'the copy of node-pty came through installation whole, and no heavier than it left',
    run: async () => {
      const where = extension().extensionPath;
      const copied = filesUnder(join(where, 'assets', 'node-pty'));
      assert.ok(copied.length > 0, 'the installed extension has no copy of node-pty at all');
      for (const asked of [
        'package.json',
        'LICENSE',
        'lib/index.js',
        'lib/conpty_console_list_agent.js',
        'lib/worker/conoutSocketWorker.js',
        'lib/shared/conout.js',
        'prebuilds/win32-x64/pty.node',
        'prebuilds/win32-x64/conpty.node',
      ]) {
        assert.ok(copied.includes(asked), `the installed copy of node-pty is missing ${asked}`);
      }
      // What the archive promised to leave out, checked where a person's editor
      // unpacked it rather than where `vsce ls` printed it.
      assert.deepEqual(copied.filter((file) => file.endsWith('.pdb')), []);
      assert.deepEqual(copied.filter((file) => file.includes('/conpty/')), []);
      /*
       * The three files whose absence is silent: the licence Apache-2.0 asks
       * for, the notices the font and the MIT packages ask for, and the hook
       * script `SessionStart` is the only event that travels through.
       *
       * `LICENSE.txt` is the name in the ARCHIVE. `vsce` appends `.txt` to a
       * licence file that has no extension as it packs it, and goes on printing
       * the source name from `vsce ls` -- so on 2026-08-18 the reconciliation in
       * `tests/extension/packaging.test.ts` was green about a `LICENSE` and this
       * check, reading the directory the editor had unpacked, found none. The
       * file is now called `LICENSE.txt` in the repository as well, which is why
       * the two names agree again.
       */
      for (const asked of ['LICENSE.txt', 'NOTICE.md', join('assets', 'gripterm-forwarder.js')]) {
        assert.ok(existsSync(join(where, asked)), `the installed extension has no ${asked}`);
      }
    },
  },
  {
    what: 'the engine that answered in this window is our own',
    run: async () => {
      /*
       * The check that makes the two after it mean anything. `run.mjs` seeds
       * `gripterm.terminal.engine: own` into the profile it launches, and a
       * missing addon sends the engine back to the editor's -- audibly in the
       * log and invisibly on screen. Without this assertion a run whose whole
       * subject is the packaged addon could be the editor's engine twice over.
       */
      const { readiness, gateway } = await api();
      assert.equal(readiness.engine, gateway.engine);
      assert.equal(
        readiness.engine,
        'own',
        'this window is not on the engine the run asked for, so nothing here is about the packaged addon'
      );
    },
  },
  {
    what: 'a pty made from the installed copy runs a real process and reports its end',
    run: async () => {
      const log = new CollectedLog();
      const gripterm = await api();
      const gateway = gripterm.makeGateway({
        setting: 'own',
        mode: 'process',
        location: 'panel',
        // What the product ships with, because this suite is about the
        // installed copy rather than about anybody's settings.
        ideChannel: false,
        // The installed directory, which is the point: this is the `require` of
        // an addon out of an unpacked VSIX.
        extensionPath: extension().extensionPath,
        editor: { termProgram: 'vscode', termProgramVersion: vscode.version },
        logger: log,
      });
      assert.equal(gateway.engine, 'own', `the addon in the archive did not load: ${log.lines.join(' | ')}`);
      try {
        const handle = await gateway.create({
          terminalId: { value: '550e8400-e29b-41d4-a716-446655440ff1' } as never,
          name: 'gripterm-vsix-pty',
          cwd: os.tmpdir(),
          env: {},
          shellPath: nodePath(),
          shellArgs: ['-e', 'process.stdout.write("from-the-archive\\n"); setTimeout(() => process.exit(3), 250);'],
        });
        const { screen } = handle;
        assert.ok(screen, 'a gateway calling itself own has no screen');

        let seen = '';
        const data = screen.onData((chunk) => {
          seen += chunk;
        });
        let code: number | undefined;
        let exits = 0;
        screen.onExit((exit) => {
          exits += 1;
          code = exit.code;
        });

        // A successful `require` proves nothing -- measured M3.4-B, where a probe
        // that stopped at `typeof spawn === 'function'` reported success on a
        // package with no addon at all. Bytes through a pipe prove it.
        await waitFor('the process to print through the pty', () => seen.includes('from-the-archive'));
        await waitFor('the pty to report the exit', () => exits > 0);
        assert.equal(code, 3, 'the screen lost the code the process exited with');
        data.dispose();
      } finally {
        gateway.dispose();
      }
    },
  },
  {
    what: 'the button a person presses brings a terminal up',
    run: async () => {
      /*
       * The acceptance line itself, taken by the path a person takes: the
       * command, the composed lifecycle, the record, an agent on a pty out of the
       * archive. Nothing is typed at it, so it costs no tokens either way.
       *
       * ================================================================
       * WHAT THIS CHECK STOPPED ESTABLISHING ON 2026-08-31
       * ================================================================
       *
       * It is a real loss and not a rewording, so it is written here rather than
       * only in a report nobody will read beside the code.
       *
       * UNTIL that day the agent here was a real `claude`, and this check
       * established that an extension installed from the archive brings up THE
       * PROGRAM A PERSON USES. It established that at a price nobody had chosen:
       * this run never moved `CLAUDE_CONFIG_DIR`, so the conversation went into
       * the profile of whoever ran it -- their own store, on every packaging run.
       *
       * SINCE that day, under `GRIPTERM_VSIX_AGENT=fake`, which is the default,
       * it establishes that the installed extension brings up A PROCESS: the
       * command runs, the composed lifecycle answers, a pty is made by the addon
       * out of the unpacked archive, something is spawned on it, the record is
       * given that process's pid, and the pid is running. Nothing below says the
       * thing on that pty was Claude Code, because it was not: it was the double
       * of `tests/acceptance/fake-claude/`, which has no model, no account, no
       * interface of any kind and no `/ide` channel. "A terminal came up with
       * Claude Code in it" is no longer measured by any run that does not cost a
       * conversation.
       *
       * THE CONDITION UNDER WHICH THE TRADE HOLDS. That the SUBJECT of this run
       * is the ARCHIVE and not the agent. The four checks before this one are the
       * subject -- the tree the code answered from, the copy of node-pty, which
       * engine answered, and an addon out of the unpacked directory moving real
       * bytes through a real pty -- and not one of them involves an agent. This
       * last check is here for the last link of the chain, "and then a terminal
       * comes up", and a process is enough to tell that link whole from broken.
       * The day this run's subject becomes what the agent DOES, the trade is off.
       *
       * WHEN IT IS LIFTED. `GRIPTERM_VSIX_AGENT=real` is the check as it was, in
       * the profile its person is logged into, and it is the only run that puts
       * the first sentence back. Whether the double still resembles the CLI at
       * all is a separate debt and already has a keeper:
       * `tests/acceptance/against-the-real-cli.json`, which goes red in the unit
       * suite when nobody has paid it for long enough.
       */
      const gripterm = await api();
      const { registry, lifecycle, readiness } = gripterm;
      assert.notEqual(
        readiness.cliPath,
        null,
        'nothing answering to `claude` was found on PATH, and this check starts whatever does'
      );
      /*
       * That the substitution took effect, and not merely that it was asked for.
       *
       * `run.mjs` puts the double in front of the real CLI on PATH; if that
       * failed -- a build that produced no `claude.exe`, an environment the
       * editor did not inherit -- `findExecutable` would walk on and reach the
       * real one, this check would pass exactly as it does now, and a run whose
       * whole point is to stop touching a person's profile would be touching it
       * in silence. That is the defect this switch exists for, so it is refused
       * here rather than assumed away.
       */
      if (AGENT === 'fake') {
        assert.ok(
          DOUBLE !== '' && (readiness.cliPath ?? '').toLowerCase().startsWith(DOUBLE.toLowerCase()),
          `the agent is the double and it was put in ${DOUBLE}, but this window resolved \`claude\` to ` +
          `${String(readiness.cliPath)} -- which is a real CLI, in the profile of whoever ran this`
        );
      }
      const before = new Set(registry.own().map((entry) => entry.terminalId.value));

      await vscode.commands.executeCommand('gripterm.newTerminal');

      const terminalId = await waitUntil(
        'the record of the terminal the command started',
        () => registry.own().find((entry) => !before.has(entry.terminalId.value))?.terminalId ?? null
      );

      let pid: number | null = null;
      try {
        pid = await waitUntil(
          'the record to name the process it started',
          () => registry.get(terminalId)?.observed.pid ?? null
        );
        assert.ok(pid > 0, 'the terminal came up without a process behind it');
        assert.equal(stillThere(pid), true, 'the record names a pid that is not running');
      } finally {
        // Ended as a window leaving would end it, which is what our own engine
        // does with its ptys, and then taken off the strip and out of the store:
        // this profile is temporary, but a `claude` left running is not.
        gripterm.endOwnProcesses();
        gripterm.stage.removed(terminalId.value);
        await waitFor('the process to go', () => pid === null || !stillThere(pid)).catch(() => null);
        if (pid !== null && stillThere(pid)) {
          process.kill(pid, 'SIGKILL');
        }
        lifecycle.discard(terminalId);
      }
    },
  },
];

/**
 * Runs every check, reports each by name, and fails with all of them rather than
 * with the first.
 *
 * One failure hiding the four behind it is how a packaging run turns into three
 * separate sittings.
 */
export async function run(): Promise<void> {
  console.log(`\nchecking the extension installed at ${String(EXTENSIONS_DIR)}`);
  // Which agent, on the line above the checks, for the reason `run.mjs` gives at
  // its own last line: the last check means a different thing under each.
  console.log(
    AGENT === 'fake'
      ? `the agent is the double in ${DOUBLE} -- the last check is about a process, not about Claude Code\n`
      : 'the agent is a real `claude`, in the profile of whoever is running this\n'
  );
  const failures: string[] = [];
  for (const check of CHECKS) {
    try {
      await check.run();
      console.log(`  ok   ${check.what}`);
    } catch (cause: unknown) {
      const said = cause instanceof Error ? cause.message : String(cause);
      console.log(`  FAIL ${check.what}\n         ${said}`);
      failures.push(`${check.what}: ${said}`);
    }
  }
  console.log(`\n${String(CHECKS.length - failures.length)} of ${String(CHECKS.length)} checks passed`);
  if (failures.length > 0) {
    throw new Error(`the installed archive failed ${String(failures.length)} check(s):\n- ${failures.join('\n- ')}`);
  }
}
