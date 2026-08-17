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
  collectCoverageFrom: ['packages/core/src/**/*.ts', '!packages/core/src/index.ts'],
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
  },
};
