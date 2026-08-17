/**
 * The cheapest question of M3.2, asked before anything else is built: does the
 * native part of node-pty load, and does a pty actually run?
 *
 * `require('node-pty')` is NOT the test. It returns an object whose `spawn` is
 * a function long before any .node file is touched, so a probe that stops at
 * `typeof spawn === 'function'` reports success on a package with no binary at
 * all -- measured here 2026-08-17, first version of this file. The test is a
 * process that runs and echoes.
 *
 * Run: node spikes/pty-screen/probe-load.js
 * Inside an editor: the same questions are asked again by the extension, where
 * the ABI is the editor's, not this Node's. That run is the gate; this one only
 * tells us the package on disk is sane.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MARKER = 'gripterm-probe-ok';
const TIMEOUT_MS = 10000;

const report = {
  runtime: {
    node: process.versions.node,
    modulesAbi: process.versions.modules,
    electron: process.versions.electron ?? null,
    platform: process.platform,
    arch: process.arch,
  },
  packageDir: null,
  // Where the loader looks, in its own order: lib/utils.js tries build/Release,
  // build/Debug, then prebuilds/<platform>-<arch>.
  candidates: {},
  spawned: false,
  pid: null,
  echoed: false,
  exitCode: null,
  signal: null,
  firstDataMs: null,
  error: null,
};

function listDir(directory) {
  return fs.existsSync(directory) ? fs.readdirSync(directory).sort() : 'MISSING';
}

async function main() {
  try {
    report.packageDir = path.dirname(require.resolve('node-pty/package.json'));
  } catch (error) {
    report.error = `resolve failed: ${String(error && error.message)}`;
    return;
  }

  report.candidates['build/Release'] = listDir(path.join(report.packageDir, 'build', 'Release'));
  const prebuilt = `prebuilds/${process.platform}-${process.arch}`;
  report.candidates[prebuilt] = listDir(path.join(report.packageDir, 'prebuilds', `${process.platform}-${process.arch}`));

  let pty;
  try {
    pty = require('node-pty');
  } catch (error) {
    report.error = `require failed: ${String(error && error.message)}`;
    return;
  }

  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
  const args = process.platform === 'win32' ? ['/c', `echo ${MARKER}`] : ['-c', `echo ${MARKER}`];

  await new Promise((resolve) => {
    let child;
    const startedAt = Date.now();
    const done = (why) => {
      if (report.error === null && why !== null) {
        report.error = why;
      }
      resolve();
    };
    const timer = setTimeout(() => { done(`no exit within ${TIMEOUT_MS} ms`); }, TIMEOUT_MS);

    try {
      child = pty.spawn(shell, args, { name: 'xterm-256color', cols: 80, rows: 30, cwd: process.cwd() });
    } catch (error) {
      clearTimeout(timer);
      done(`spawn threw: ${String(error && error.message)}`);
      return;
    }

    report.spawned = true;
    report.pid = child.pid;

    child.onData((data) => {
      if (report.firstDataMs === null) {
        report.firstDataMs = Date.now() - startedAt;
      }
      if (data.includes(MARKER)) {
        report.echoed = true;
      }
    });

    child.onExit(({ exitCode, signal }) => {
      clearTimeout(timer);
      report.exitCode = exitCode;
      report.signal = signal ?? null;
      // The last chunk can arrive in the same tick as the exit.
      setTimeout(() => { done(null); }, 200);
    });
  });
}

main().then(() => {
  console.log(JSON.stringify(report, null, 2));
  // Measured 2026-08-17: after a pty has run and exited, this process does NOT
  // end by itself -- node-pty keeps handles alive (the conout socket worker on
  // Windows). Setting `exitCode` and returning left the probe hanging past two
  // minutes. Exiting explicitly is the probe's business; for the product the
  // same fact belongs to O4, where `deactivate` cannot rely on the host dying
  // quietly on its own.
  process.exit(report.spawned && report.echoed ? 0 : 1);
});
