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
    timeout: 60000,
  },
});
