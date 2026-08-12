/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  setupFiles: ["dotenv/config"],
  coverageThreshold: {
    global: {
      // Sprint 1 baseline (TQ-009). Raise this as real coverage grows — do not lower it.
      statements: 50,
      branches: 35,
      functions: 45,
      lines: 50,
    },
  },
};
