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
  moduleNameMapper: {
    '^@gripterm/core$': '<rootDir>/packages/core/src/index.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.eslint.json' }],
  },
  // tests/integration is deliberately out: it imports the 'vscode' module,
  // which only exists inside a running Extension Host. That suite belongs to
  // `pnpm test:integration` (@vscode/test-cli), not to Jest.
  testMatch: [
    '<rootDir>/tests/domain/**/*.test.ts',
    '<rootDir>/tests/infrastructure/**/*.test.ts',
  ],
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
