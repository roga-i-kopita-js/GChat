module.exports = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/test/setup-env.cjs'],
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.spec.ts'],
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json', useESM: true }],
  },
  clearMocks: true,
};
