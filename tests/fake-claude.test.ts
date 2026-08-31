import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Server } from 'node:http';

/**
 * The test double that stands in for `claude` while the acceptance suite runs.
 *
 * It is a FILE another program starts, so it is tested by being started -- a
 * real `node`, a real socket, a real settings file, the product's own forwarder.
 * Nothing here imports it: what ships to `tests/acceptance/run.mjs` is a
 * process, and a module would be a different thing under the same name (the
 * rule `tests/extension/forwarder.test.ts` states for the forwarder).
 *
 * **What every assertion below is worth, said before any of them.** This suite
 * checks that the double behaves as this repository BELIEVES `claude` behaves.
 * It cannot check that belief. Where a line of the double came from a
 * measurement, the measurement is named in `fake-claude.mjs` beside it; where it
 * came from our own code, that is said there too. The date the belief was last
 * held against the real CLI lives in `tests/acceptance/against-the-real-cli.json`
 * and is checked at the bottom of this file -- because a double nobody ever
 * re-checks is a green test that stopped meaning anything on a day nobody
 * noticed.
 */

const DOUBLE = join(__dirname, '..', 'tests', 'acceptance', 'fake-claude', 'fake-claude.mjs');
const FORWARDER = join(__dirname, '..', 'packages', 'extension', 'assets', 'gripterm-forwarder.js');
const RECEIPT = join(__dirname, '..', 'tests', 'acceptance', 'against-the-real-cli.json');
const BUILD = join(__dirname, '..', 'tests', 'acceptance', 'fake-claude', 'build.mjs');

const TOKEN = 'a-token-of-this-activation';
const SESSION = '3f1c2b8a-4d5e-4f60-9a71-b2c3d4e5f607';
const OTHER_SESSION = '11111111-2222-4333-8444-555555555555';

/** Long enough for a loopback round trip several thousand times over. */
const SETTLES_WITHIN_MS = 20_000;
const POLL_MS = 25;

interface Posted {
  readonly body: Record<string, unknown>;
  readonly authorization: string | undefined;
  readonly url: string | undefined;
}

interface Receiver {
  readonly server: Server;
  readonly origin: string;
  readonly posted: Posted[];
}

async function receiver(): Promise<Receiver> {
  const posted: Posted[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        parsed = { unreadable: body };
      }
      posted.push({
        body: parsed,
        authorization: request.headers.authorization,
        url: request.url,
      });
      response.writeHead(202);
      response.end();
    });
  });
  return await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, origin: `http://127.0.0.1:${port.toString()}`, posted });
    });
  });
}

/**
 * The settings document the product writes, in the shape it writes it.
 *
 * Built here rather than imported from `SessionSettingsBuilder`, and that is the
 * point of the whole double: if this file took the builder's own output, a
 * settings file that registered nothing would still satisfy every test below.
 * The literal is what a reader can compare with the builder by eye.
 */
function settingsFor(origin: string, terminalId: string): unknown {
  const url = `${origin}/ev/${terminalId}`;
  const http = [
    {
      hooks: [
        {
          type: 'http',
          url,
          headers: { Authorization: 'Bearer $GRIPTERM_TOKEN' },
          allowedEnvVars: ['GRIPTERM_TOKEN'],
          timeout: 2,
        },
      ],
    },
  ];
  return {
    hooks: {
      SessionStart: [
        {
          hooks: [
            { type: 'command', command: process.execPath, args: [FORWARDER, url], timeout: 5 },
          ],
        },
      ],
      SessionEnd: http,
      UserPromptSubmit: http,
      PreToolUse: http,
      PostToolUse: http,
      PostToolUseFailure: http,
      PermissionRequest: http,
      Notification: http,
      Stop: http,
      StopFailure: http,
      SubagentStart: http,
      SubagentStop: http,
      CwdChanged: http,
    },
  };
}

interface Room {
  readonly base: string;
  readonly config: string;
  readonly cwd: string;
  readonly settings: string;
  readonly terminalId: string;
}

function room(origin: string): Room {
  const base = mkdtempSync(join(tmpdir(), 'gripterm-fake-claude-'));
  const config = join(base, 'claude-config');
  const cwd = join(base, 'project');
  mkdirSync(config, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const terminalId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const settings = join(base, 'settings.json');
  writeFileSync(settings, JSON.stringify(settingsFor(origin, terminalId), null, 2), 'utf8');
  return { base, config, cwd, settings, terminalId };
}

interface Session {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly exited: Promise<number | null>;
}

function start(where: Room, args: readonly string[]): Session {
  const child = spawn(process.execPath, [DOUBLE, ...args], {
    cwd: where.cwd,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: where.config,
      GRIPTERM_TOKEN: TOKEN,
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on('close', (code) => {
      resolve(code);
    });
  });
  return { child, stdout: () => stdout, stderr: () => stderr, exited };
}

async function within(what: string, ready: () => boolean, ms = SETTLES_WITHIN_MS): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error(`gave up waiting for ${what} after ${ms.toString()} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function named(posted: readonly Posted[], hook: string): Posted[] {
  return posted.filter((one) => one.body.hook_event_name === hook);
}

function sessionFile(where: Room, pid: number): Record<string, unknown> | null {
  const file = join(where.config, 'sessions', `${pid.toString()}.json`);
  if (!existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Every session file this run left behind, whatever it is named. */
function sessionFiles(where: Room): Record<string, unknown>[] {
  const dir = join(where.config, 'sessions');
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>);
}

describe('the double that stands in for `claude`', () => {
  let listening: Receiver;
  const rooms: Room[] = [];
  const running: Session[] = [];

  beforeAll(async () => {
    listening = await receiver();
  });

  afterAll(() => {
    listening.server.close();
  });

  afterEach(async () => {
    for (const session of running) {
      session.child.kill();
      await session.exited;
    }
    running.length = 0;
    listening.posted.length = 0;
    for (const where of rooms) {
      rmSync(where.base, { recursive: true, force: true });
    }
    rooms.length = 0;
  });

  function open(): Room {
    const where = room(listening.origin);
    rooms.push(where);
    return where;
  }

  function launch(where: Room, args: readonly string[]): Session {
    const session = start(where, args);
    running.push(session);
    return session;
  }

  it('answers `--version` with a build that is not the one this repository pinned', async () => {
    const where = open();
    const session = launch(where, ['--version']);
    await session.exited;

    expect(session.stdout()).toMatch(/^\d+\.\d+\.\d+/u);
    expect(session.stdout()).not.toContain('2.1.225');
    expect(session.stdout().toLowerCase()).toContain('not claude');
  });

  it('reports a session it was started with, over the COMMAND hook and never over HTTP', async () => {
    const where = open();
    launch(where, [
      '--session-id', SESSION,
      '--name', 'the first terminal',
      '--settings', where.settings,
    ]);

    await within('the session to be reported', () => named(listening.posted, 'SessionStart').length === 1);
    const [began] = named(listening.posted, 'SessionStart');
    expect(began?.body.session_id).toBe(SESSION);
    expect(began?.body.source).toBe('startup');
    expect(began?.body.cwd).toBe(where.cwd);
    expect(typeof began?.body.transcript_path).toBe('string');
    expect(began?.url).toBe(`/ev/${where.terminalId}`);
    // The forwarder sends the token; an HTTP hook would have carried the header
    // this file wrote. Both arrive as the same string, so the difference has to
    // be read off the double: it must have SPAWNED something.
    expect(began?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('interpolates only the environment variables the settings file allowed', async () => {
    const where = open();
    const settings = JSON.parse(readFileSync(where.settings, 'utf8')) as {
      hooks: Record<string, { hooks: { allowedEnvVars?: string[] }[] }[]>;
    };
    for (const registration of settings.hooks.Stop ?? []) {
      for (const hook of registration.hooks) {
        hook.allowedEnvVars = [];
      }
    }
    writeFileSync(where.settings, JSON.stringify(settings), 'utf8');

    const session = launch(where, ['--session-id', SESSION, '--name', 'n', '--settings', where.settings]);
    await within('the session to start', () => named(listening.posted, 'SessionStart').length === 1);
    session.child.stdin.write('say something\r');

    await within('the turn to end', () => named(listening.posted, 'Stop').length === 1);
    // `Bearer` and not `Bearer ` with the space the double wrote: Node's HTTP
    // client trims a header value's trailing whitespace, and this assertion is
    // about the double's substitution rather than about the transport.
    expect(named(listening.posted, 'Stop')[0]?.authorization).toBe('Bearer');
    expect(named(listening.posted, 'UserPromptSubmit')[0]?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('turns a typed line into a prompt and a turn, and answers with the line itself', async () => {
    const where = open();
    const session = launch(where, ['--session-id', SESSION, '--name', 'n', '--settings', where.settings]);
    await within('the session to start', () => named(listening.posted, 'SessionStart').length === 1);

    session.child.stdin.write('reply with only the word pineapple\r');

    await within('the turn to end', () => named(listening.posted, 'Stop').length === 1);
    expect(named(listening.posted, 'UserPromptSubmit')[0]?.body.user_input).toBe(
      'reply with only the word pineapple'
    );
    expect(named(listening.posted, 'Stop')[0]?.body.last_assistant_message).toBe(
      'reply with only the word pineapple'
    );
  });

  it('leaves no transcript for a session nothing was typed into, and one for a session that had a turn', async () => {
    const quiet = open();
    launch(quiet, ['--session-id', SESSION, '--name', 'n', '--settings', quiet.settings]);
    await within('the quiet session to start', () => named(listening.posted, 'SessionStart').length === 1);
    const path = String(named(listening.posted, 'SessionStart')[0]?.body.transcript_path);
    expect(existsSync(path)).toBe(false);

    const spoken = open();
    const session = launch(spoken, [
      '--session-id', OTHER_SESSION,
      '--name', 'n',
      '--settings', spoken.settings,
    ]);
    await within('the second session to start', () => named(listening.posted, 'SessionStart').length === 2);
    session.child.stdin.write('a word\r');
    await within('its turn to end', () => named(listening.posted, 'Stop').length === 1);

    const wrote = String(named(listening.posted, 'SessionStart')[1]?.body.transcript_path);
    await within('the transcript to appear', () => existsSync(wrote));
    expect(wrote.endsWith(`${OTHER_SESSION}.jsonl`)).toBe(true);
    expect(wrote.includes(join(spoken.config, 'projects'))).toBe(true);
  });

  it('answers `/clear` with an end and a beginning under a new conversation id', async () => {
    const where = open();
    const session = launch(where, ['--session-id', SESSION, '--name', 'n', '--settings', where.settings]);
    await within('the session to start', () => named(listening.posted, 'SessionStart').length === 1);

    session.child.stdin.write('/clear\r');

    await within('the second beginning', () => named(listening.posted, 'SessionStart').length === 2);
    const [ended] = named(listening.posted, 'SessionEnd');
    expect(ended?.body.reason).toBe('clear');
    expect(ended?.body.session_id).toBe(SESSION);
    const second = named(listening.posted, 'SessionStart')[1];
    expect(second?.body.source).toBe('clear');
    expect(second?.body.session_id).not.toBe(SESSION);
    expect(String(second?.body.session_id)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
    );
  });

  it('writes the name it was started with into its own session file, with no `nameSource`', async () => {
    const where = open();
    launch(where, ['--session-id', SESSION, '--name', 'the row calls it this', '--settings', where.settings]);
    await within('the session to start', () => named(listening.posted, 'SessionStart').length === 1);

    await within('the session file', () => sessionFiles(where).length === 1);
    const [file] = sessionFiles(where);
    expect(file?.name).toBe('the row calls it this');
    expect(file?.sessionId).toBe(SESSION);
    expect(file?.cwd).toBe(where.cwd);
    expect('nameSource' in (file ?? {})).toBe(false);
    // Named after the pid the world outside the pty sees, which for a double
    // started by this test is this process.
    expect(sessionFile(where, process.pid)).not.toBeNull();
  });

  it('derives a name, and says it derived it, when it was started without one', async () => {
    const where = open();
    launch(where, ['--session-id', SESSION, '--settings', where.settings]);
    await within('the session to start', () => named(listening.posted, 'SessionStart').length === 1);
    await within('the session file', () => sessionFiles(where).length === 1);

    const [file] = sessionFiles(where);
    expect(file?.nameSource).toBe('derived');
    expect(typeof file?.name).toBe('string');
  });

  it('takes the name a person types with `/rename`, and drops the mark that says it derived one', async () => {
    const where = open();
    const session = launch(where, ['--session-id', SESSION, '--settings', where.settings]);
    await within('the session to start', () => named(listening.posted, 'SessionStart').length === 1);
    await within('the session file', () => sessionFiles(where).length === 1);

    session.child.stdin.write('/rename told-by-a-person\r');

    await within('the new name', () => sessionFiles(where)[0]?.name === 'told-by-a-person');
    expect('nameSource' in (sessionFiles(where)[0] ?? {})).toBe(false);
    // A local command spends no turn, so it must not look like one.
    expect(named(listening.posted, 'UserPromptSubmit')).toHaveLength(0);
  });

  it('lists what is running, and drops a session whose process is gone or has stopped saying so', async () => {
    const where = open();
    launch(where, ['--session-id', SESSION, '--name', 'n', '--settings', where.settings]);
    await within('the session file', () => sessionFiles(where).length === 1);

    const beats = join(where.config, 'fake-claude-running');
    mkdirSync(beats, { recursive: true });
    // A pid nothing is running as.
    writeFileSync(
      join(beats, '999999.json'),
      JSON.stringify({ sessionId: OTHER_SESSION, pid: 999999, cwd: where.cwd, name: 'gone', aliveAt: Date.now() }),
      'utf8'
    );
    // And the case a pid alone cannot answer: a LIVE pid -- this very process --
    // carrying a conversation that stopped beating a minute ago, which is what a
    // recycled pid looks like from here. It is the defect of 2026-08-31.
    writeFileSync(
      join(beats, '424242.json'),
      JSON.stringify({
        sessionId: OTHER_SESSION,
        pid: process.pid,
        cwd: where.cwd,
        name: 'a pid that was handed on',
        aliveAt: Date.now() - 60_000,
      }),
      'utf8'
    );

    const listing = launch(where, ['agents', '--json']);
    await listing.exited;
    const agents = JSON.parse(listing.stdout()) as { sessionId: string, pid: number, cwd: string }[];
    expect(agents.map((one) => one.sessionId)).toStrictEqual([SESSION]);
    expect(agents[0]?.pid).toBe(process.pid);
    expect(agents[0]?.cwd).toBe(where.cwd);
  });

  it('refuses to resume a conversation with no transcript, with one report and exit 1', async () => {
    const where = open();
    const session = launch(where, ['--resume', SESSION, '--name', 'n', '--settings', where.settings]);

    const code = await session.exited;
    expect(code).toBe(1);
    expect(named(listening.posted, 'SessionEnd')).toHaveLength(1);
    expect(named(listening.posted, 'SessionStart')).toHaveLength(0);
  }, 30_000);

  it('resumes the same conversation when a transcript is there', async () => {
    const where = open();
    const first = launch(where, ['--session-id', SESSION, '--name', 'n', '--settings', where.settings]);
    await within('the session to start', () => named(listening.posted, 'SessionStart').length === 1);
    first.child.stdin.write('a word\r');
    await within('the turn to end', () => named(listening.posted, 'Stop').length === 1);
    first.child.stdin.write('/exit\r');
    expect(await first.exited).toBe(0);

    launch(where, ['--resume', SESSION, '--name', 'n', '--settings', where.settings]);
    await within('the resume to be reported', () => named(listening.posted, 'SessionStart').length === 2);
    const resumed = named(listening.posted, 'SessionStart')[1];
    expect(resumed?.body.session_id).toBe(SESSION);
    expect(resumed?.body.source).toBe('resume');
  });

  it('refuses to run at all without a profile directory of its own', async () => {
    const where = open();
    const child = spawn(process.execPath, [DOUBLE, '--version'], {
      cwd: where.cwd,
      env: { ...process.env, CLAUDE_CONFIG_DIR: undefined },
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const code = await new Promise<number | null>((resolve) => {
      child.on('close', resolve);
    });

    expect(code).not.toBe(0);
    expect(stderr).toContain('CLAUDE_CONFIG_DIR');
  });
});

/**
 * The native half, which is what actually goes on PATH.
 *
 * It is here rather than left to the acceptance run because of what it replaced
 * and why (measured 2026-08-31): a `claude.cmd` shim starts perfectly well under
 * a pty and is refused by `execFile` with `spawn EINVAL` -- so `agents --json`,
 * which the restore path asks before it brings a conversation back, would fail
 * against a shim while every window looked fine. The one assertion that matters
 * below is therefore the one nobody would think to write: that `execFile` can
 * run it.
 */
describe('the executable the acceptance run puts on PATH', () => {
  const into = join(tmpdir(), 'gripterm-fake-claude-build');

  afterAll(() => {
    rmSync(into, { recursive: true, force: true });
  });

  it('compiles, and hands the double the argument vector it was given', () => {
    // `build.mjs` refuses to hand back a directory whose launcher mangled a
    // deliberately nasty vector, so reaching this line is the round trip.
    const said = execFileSync(process.execPath, [BUILD, into], { encoding: 'utf8' }).trim();

    expect(said).toBe(into);
    expect(existsSync(join(into, 'claude.exe'))).toBe(true);
    expect(existsSync(join(into, 'fake-claude.mjs'))).toBe(true);
  });

  it('can be run by `execFile`, which is what the version probe and the roster use', () => {
    const said = execFileSync(join(into, 'claude.exe'), ['--version'], {
      encoding: 'utf8',
      env: { ...process.env, GRIPTERM_FAKE_CLAUDE_NODE: process.execPath, CLAUDE_CONFIG_DIR: into },
    });

    expect(said).toContain('not Claude Code');
  });
});

/**
 * The half of this that no amount of testing the double can supply.
 *
 * Every case above compares the double with what this repository believes. This
 * one compares the BELIEF with a date, and goes red when the belief is older
 * than the file says it may be. The form is `gate/allowed-red.json`'s -- an
 * admission with a name, a reason and a day it stops working -- and the point is
 * the same: a permission that cannot expire is not a permission, it is a
 * decision nobody ever has to make again.
 */
describe('the belief the double is built on', () => {
  interface Receipt {
    readonly lastRun: { readonly on: string | null } | null;
    readonly maxAgeDays: number;
    readonly grace: { readonly until: string, readonly ratifiedBy: string | null } | null;
  }

  function receipt(): Receipt {
    return JSON.parse(readFileSync(RECEIPT, 'utf8')) as Receipt;
  }

  function today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  function plusDays(day: string, days: number): string {
    const at = new Date(`${day}T00:00:00Z`);
    at.setUTCDate(at.getUTCDate() + days);
    return at.toISOString().slice(0, 10);
  }

  it('has been held against the real CLI, or is inside a grace that says when it must be', () => {
    const held = receipt();
    const ran = held.lastRun?.on ?? null;
    const good = ran === null ? (held.grace?.until ?? '0000-00-00') : plusDays(ran, held.maxAgeDays);

    expect({ good, today: today(), inTime: today() <= good }).toStrictEqual({
      good,
      today: today(),
      inTime: true,
    });
  });

  it('carries a grace only while nobody has run the real thing yet', () => {
    const held = receipt();
    expect(held.lastRun?.on === null || held.grace === null).toBe(true);
  });
});
