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
  // tests/integration is the single exclusion, and it is deliberate -- it
  // imports the 'vscode' module, which exists only inside a running Extension
  // Host. That suite belongs to `pnpm test:integration` (@vscode/test-cli).
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/integration/'],
  collectCoverageFrom: ['packages/core/src/**/*.ts', '!packages/core/src/index.ts'],
  coverageThreshold: {
    global: {
      branches: 65,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
};
