'use strict';
/*
 * The Gripterm hook forwarder.
 *
 * Claude Code runs this as a COMMAND hook, in the exec form, with the
 * terminal's environment. It reads the hook payload on stdin and posts it,
 * verbatim, to the receiver of the activation that wrote the settings file.
 *
 * It exists because one event cannot travel over HTTP: build 2.1.225 filters
 * `SessionStart` unconditionally, so an http registration for it costs no error
 * and no event either (§4.7).
 *
 * Shipped as a FILE and deliberately not bundled. It is executed by an
 * interpreter we name by absolute path -- a bare `node` on the terminal's PATH
 * is not guaranteed (C5-2) -- and by a process that is not ours.
 *
 *   node gripterm-forwarder.js <url>
 *
 * One argument, and no mode switch. `SessionSettingsBuilder` already writes
 * exactly this shape (`args: [script, url]`), and the statusline forwarder of
 * M1.8b is not written yet -- a mode argument with one mode would be a promise
 * with nobody to keep it.
 *
 * Four rules, and every one of them is about not harming the conversation that
 * is waiting for this process to exit:
 *
 *   1. NOTHING is ever written to stdout. The stdout of a `SessionStart` hook
 *      that exits 0 is appended to the conversation as `additionalContext`, so
 *      any stray output is a silent injection into somebody's session.
 *   2. The exit code is ALWAYS 0. A non-zero exit from a hook is a signal to
 *      the CLI, and this program has nothing to signal: our failure to observe
 *      is our problem and never the agent's.
 *   3. Everything is bounded. A hook holds the turn until it exits, and the
 *      CLI's own default timeout is ten minutes.
 *   4. The token is read from the environment and never printed, not even in
 *      the diagnostic on stderr. A16, measured 2026-08-11: a command hook DOES
 *      inherit the terminal's environment, which is why the secret never has to
 *      appear in `settings.json` as an argument.
 */

const http = require('node:http');
const https = require('node:https');

/** Long enough for a loopback POST several thousand times over; short enough to be invisible. */
const REQUEST_TIMEOUT_MS = 2000;

/** The CLI writes the payload immediately. This is the guard against it never writing at all. */
const STDIN_TIMEOUT_MS = 2000;

/**
 * Generous, and bounded. A `PostToolUse` carrying a large file read is an
 * ordinary event; a payload past this is not one we could do anything with.
 */
const MAX_BODY_BYTES = 8388608;

const TOKEN_ENV_VAR = 'GRIPTERM_TOKEN';

function main() {
  const url = process.argv[2];
  if (typeof url !== 'string' || url.length === 0) {
    // Nothing to send it to. Said once on stderr, which the CLI shows only in
    // debug mode, and then out of the way.
    fail('gripterm-forwarder: no receiver url was given');
    return;
  }

  readStdin(function (body) {
    if (body.length === 0) {
      fail('gripterm-forwarder: the hook sent no payload');
      return;
    }
    post(url, body);
  });
}

/**
 * Reads the whole payload, or gives up.
 *
 * `end` is the normal path. The timer exists because this process is holding
 * somebody's turn open: a producer that opens our stdin and then never writes
 * would otherwise keep the conversation waiting for the CLI's own timeout.
 */
function readStdin(done) {
  let body = '';
  let finished = false;

  const finish = function () {
    if (finished) {
      return;
    }
    finished = true;
    clearTimeout(timer);
    done(body);
  };

  const timer = setTimeout(finish, STDIN_TIMEOUT_MS);
  timer.unref();

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', function (chunk) {
    if (body.length + chunk.length > MAX_BODY_BYTES) {
      body = '';
      finish();
      return;
    }
    body += chunk;
  });
  process.stdin.on('end', finish);
  process.stdin.on('error', finish);
}

/**
 * Fire and forget, with a hard ceiling.
 *
 * The response is read and discarded: until M3 there is nothing the receiver
 * could tell this process that it would be safe to act on, because the only
 * channel back to the CLI is stdout, and stdout is the conversation.
 */
function post(url, body) {
  let target;
  try {
    target = new URL(url);
  } catch {
    fail('gripterm-forwarder: the receiver url is not a url');
    return;
  }

  const transport = target.protocol === 'https:' ? https : http;
  const payload = Buffer.from(body, 'utf8');
  const request = transport.request(
    target,
    {
      method: 'POST',
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'content-type': 'application/json',
        'content-length': payload.length,
        // Absent is a legitimate state, not a reason to stop: the receiver
        // answers 401 and the conversation is unaffected either way.
        authorization: 'Bearer ' + (process.env[TOKEN_ENV_VAR] || ''),
      },
    },
    function (response) {
      response.resume();
      response.on('end', done);
      response.on('error', done);
    }
  );

  request.on('timeout', function () {
    request.destroy();
  });
  // Every failure is the same failure here: the window is gone, the port moved,
  // the socket was refused. None of them is the agent's business.
  request.on('error', function () {
    done();
  });
  request.end(payload);
}

function done() {
  process.exitCode = 0;
  process.exit(0);
}

function fail(message) {
  // stderr, never stdout: see rule 1. And exit 0 all the same: see rule 2.
  process.stderr.write(message + '\n');
  done();
}

main();
