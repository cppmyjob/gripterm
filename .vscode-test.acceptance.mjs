import { defineConfig } from '@vscode/test-cli';

/**
 * The first sitting of П2, and nothing else.
 *
 * Kept apart from `.vscode-test.mjs` because this host does what no test may do
 * by accident: it writes a real record, and -- when the run was asked for a real
 * agent -- it starts a real `claude` and spends a real turn.
 * `tests/acceptance/run.mjs` is what sets the two variables below, and this file
 * refuses without them rather than silently opening the wrong folder or writing
 * into the person's own store.
 *
 * WHICH AGENT ANSWERS is decided by that runner and not here, and it is decided
 * in the ENVIRONMENT this host inherits: `GRIPTERM_ACCEPTANCE_AGENT` defaults to
 * `fake`, and the runner then puts `tests/acceptance/fake-claude/` in front of
 * PATH and moves `CLAUDE_CONFIG_DIR` into the run's own directory. So a host
 * started through the runner talks to the double, and one started by hand talks
 * to whatever `claude` is on the PATH it was given -- which is another reason
 * this config refuses to run without the runner.
 */

const project = process.env.GRIPTERM_ACCEPTANCE_PROJECT;
const userData = process.env.GRIPTERM_ACCEPTANCE_UD;
if (project === undefined || userData === undefined) {
  throw new Error('run the acceptance suite through tests/acceptance/run.mjs');
}

export default defineConfig({
  label: 'acceptance',
  files: 'out/tests/acceptance/**/*.test.js',
  extensionDevelopmentPath: 'packages/extension',
  version: 'stable',
  workspaceFolder: project,
  // The settings that isolate the store live in this user data directory, which
  // is why it is passed rather than left to the default profile.
  launchArgs: ['--user-data-dir', userData, '--disable-workspace-trust'],
  mocha: {
    // A real turn of a real conversation, on somebody's network.
    timeout: 300000,
  },
});
