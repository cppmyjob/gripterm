import { defineConfig } from '@vscode/test-cli';

/**
 * The first sitting of П2, and nothing else.
 *
 * Kept apart from `.vscode-test.mjs` because this host does what no test may do
 * by accident: it starts a real `claude`, spends a real turn, and writes a real
 * record. `tests/acceptance/run.mjs` is what sets the two variables below, and
 * this file refuses without them rather than silently opening the wrong folder
 * or writing into the person's own store.
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
