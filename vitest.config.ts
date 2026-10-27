import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Where the project tracks its tests, a reporter records which case each test proves. It is not
// part of the published repository, which runs without it.
const tracked = (level: string): [string, { output: string; level: string }][] =>
  existsSync("tools/tc-reporter.ts")
    ? [["./tools/tc-reporter.ts", { output: `reports/tc-${level}.json`, level }]]
    : [];

// The module tests. The shared suite has its own run (vitest.conformance.config.ts), because it
// needs the suite's fake hub, a Python program.
export default defineConfig({
  test: {
    reporters: ["default", "junit", ...tracked("unit")],
    outputFile: { junit: "reports/junit-unit.xml" },
    include: ["test/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/generated/**"],
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
});
