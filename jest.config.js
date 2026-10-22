/** @type {import('jest').Config} */
const tsJest = ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json', diagnostics: { warnOnly: false } }];
const moduleNameMapper = {
  '^@nse/shared$': '<rootDir>/packages/shared/src/index.ts',
  '^@nse/core$': '<rootDir>/packages/core/src/index.ts',
};
const common = { rootDir: __dirname, testEnvironment: 'node', transform: { '^.+\\.ts$': tsJest }, moduleNameMapper };

module.exports = {
  // Integration suites share one test database, so files run serially.
  maxWorkers: 1,
  projects: [
    { ...common, displayName: 'core-unit', testMatch: ['<rootDir>/packages/core/test/unit/**/*.test.ts'] },
    {
      ...common,
      displayName: 'core-integration',
      testMatch: ['<rootDir>/packages/core/test/integration/**/*.test.ts'],
      globalSetup: '<rootDir>/packages/core/test/globalSetup.ts',
      setupFiles: ['<rootDir>/packages/core/test/setupEnv.ts'],
    },
    {
      ...common,
      displayName: 'api',
      testMatch: ['<rootDir>/apps/api/test/**/*.test.ts'],
      globalSetup: '<rootDir>/packages/core/test/globalSetup.ts',
      setupFiles: ['<rootDir>/packages/core/test/setupEnv.ts'],
    },
    {
      ...common,
      displayName: 'worker',
      testMatch: ['<rootDir>/apps/worker/test/**/*.test.ts'],
      globalSetup: '<rootDir>/packages/core/test/globalSetup.ts',
      setupFiles: ['<rootDir>/packages/core/test/setupEnv.ts'],
    },
  ],
};
