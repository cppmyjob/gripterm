import { defineConfig } from '@vscode/test-cli';

// Downloads a real VS Code and runs the integration suite inside it, so that
// "works in VS Code" is checked rather than assumed. The bundled extension is
// what gets loaded — `pnpm test:integration` builds it first.
export default defineConfig({
  label: 'integration',
  files: 'out/tests/integration/**/*.test.js',
  extensionDevelopmentPath: 'packages/extension',
  version: 'stable',
  mocha: {
    // Two minutes because one test waits out a real restore: the twenty-second
    // wait of `RestoreOrchestrator` is the thing under test there, and a real
    // `claude` has to be started before it even begins.
    timeout: 120000,
  },
});
