/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  setupFiles: ["dotenv/config"],
  // 5000ms default was observed to flake on the very first test in a run when Postgres's
  // connection pool is cold (first real TCP + auth round trip) — bumped once, not per-test,
  // after seeing a genuine (not app-bug) timeout in CI-like conditions.
  testTimeout: 10000,
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
