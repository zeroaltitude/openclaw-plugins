/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        useESM: true,
        tsconfig: "tsconfig.json",
        diagnostics: {
          ignoreCodes: [151002, 2578],
        },
      },
    ],
  },
  transformIgnorePatterns: [
    "node_modules/(?!(@xenova/transformers)/)",
  ],
  testMatch: ["**/__tests__/**/*.test.ts"],
  testTimeout: 120000,
};
