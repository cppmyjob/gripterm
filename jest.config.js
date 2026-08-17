/**
 * Unit tests for the domain and infrastructure of @gripterm/core.
 *
 * packages/extension is deliberately outside the coverage thresholds: it is
 * adapters, whose unit coverage would measure stubs rather than behaviour. It
 * is covered by the integration run (@vscode/test-cli) instead.
 *
 * @type {import('ts-jest').JestConfigWithTsJest}
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  coverageDirectory: '.test-output/coverage',
  // The `.js` suffix on relative specifiers is gone (2026-08-10), and with it
  // the mapper that existed solely to undo it. Nothing here requires the
  // suffix: `module: Node16` decides a file's format from the nearest
  // package.json `type`, none of the three packages sets it, so every file is
  // CommonJS -- where the extension is optional, as in any `require`.
  moduleNameMapper: {
    '^@gripterm/core$': '<rootDir>/packages/core/src/index.ts',
    '^@gripterm/webview$': '<rootDir>/packages/webview/src/protocol.ts',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.eslint.json' }],
  },
  // Every suite under tests/, by subtraction rather than by enumeration: a list
  // of directories silently stops running the day someone adds a twelfth one.
  // Two exclusions, and both are deliberate. `tests/integration` imports the
  // 'vscode' module, which exists only inside a running Extension Host; it
  // belongs to `pnpm test:integration` (@vscode/test-cli). `tests/acceptance`
  // does the same AND starts a real `claude` that spends a real turn, so it
  // belongs to `pnpm test:acceptance` and to nothing that runs by itself.
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  testPathIgnorePatterns: [
    '/node_modules/',
    '<rootDir>/tests/integration/',
    '<rootDir>/tests/acceptance/',
  ],
  // The core, plus the two pure rules the page is built on. The page ITSELF is
  // not here and cannot be: it needs a document, and it is checked in a real
  // editor by `tests/integration/workbench-view.test.ts`. These two are total
  // functions of their arguments -- one parses a message, one places a border --
  // and both run on a side of the channel this suite can reach.
  collectCoverageFrom: [
    'packages/core/src/**/*.ts',
    '!packages/core/src/index.ts',
    'packages/webview/src/protocol.ts',
    'packages/webview/src/split-rule.ts',
  ],
  coverageThreshold: {
    global: {
      branches: 65,
      functions: 80,
      lines: 80,
      statements: 80,
    },
    // The pure rules of M3.3, at the number the plan promises for them. A
    // promise that lives only in a document is a promise nobody checks, and
    // these two are small enough that the global average would hide a whole
    // branch of either. Both are total functions of their arguments -- no
    // clock, no store, no editor -- so there is nothing here that 100% would
    // be dishonest about.
    //
    // `domain/ports/terminal-screen.ts` is deliberately NOT here: it is types
    // and doc comments, so it has no executable line for a threshold to be
    // about, and Istanbul reports nothing for it at all.
    'packages/core/src/domain/services/terminal-exit-verdict.ts': {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
    'packages/core/src/domain/services/screen-buffer.ts': {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
    // The two pure rules of M3.4 stage A, held at the same number and for the
    // same reason. `terminal-environment.ts` earns it twice over: every branch of
    // it stands for a measured difference between the extension host's
    // environment and a terminal's, and a branch nobody exercises here is a
    // variable reaching an agent -- or not reaching it -- with nothing to say so.
    'packages/core/src/domain/services/terminal-environment.ts': {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
    'packages/core/src/domain/services/engine-selection.ts': {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
    // The two rules of M3.5, and they are here for a reason the others are not:
    // between them they decide whether a process is ENDED, which is the only act
    // in this build that no undo of ours reaches (§I.3). A branch of either that
    // nothing exercises is a refusal nobody has checked, and every one of those
    // refusals is standing in front of somebody's running work.
    'packages/core/src/domain/services/orphan-processes.ts': {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
    'packages/core/src/domain/services/window-shutdown.ts': {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
    // The two rules of M3.6, held at the same number for a reason of their own:
    // both stand between a webview and the rest of the build. The parser is the
    // only thing that reads a message from a document with its own lifetime, and
    // the split rule is the only thing that refuses to lay out a box that has no
    // geometry -- the `NaN` that xterm.js#3029 produces from a hidden panel. A
    // branch of either that nothing exercises is a refusal nobody has checked.
    'packages/webview/src/protocol.ts': {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
    // The two rules of M3.7, and the first of them earns the number the way
    // M3.5's pair did: `OutputFlow` decides when an agent is told to stop
    // talking, and a pause with no resume after it leaves that agent blocked
    // against a full buffer with nothing on any screen to say so. Every branch
    // of it that nothing exercises is a release nobody has checked.
    'packages/core/src/domain/services/output-flow.ts': {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
    'packages/core/src/domain/services/output-coalescer.ts': {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
    'packages/webview/src/split-rule.ts': {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
  },
};
