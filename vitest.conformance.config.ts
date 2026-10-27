import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Where the project tracks its tests, a reporter records which case each test proves. It is not
// part of the published repository, which runs without it.
const tracked = (level: string): [string, { output: string; level: string }][] =>
  existsSync("tools/tc-reporter.ts")
    ? [["./tools/tc-reporter.ts", { output: `reports/tc-${level}.json`, level }]]
    : [];

// The shared SDK test suite, played through this SDK by test/conformance. The suite's
// fake hub is started once by test/conformance/hub.ts; the cases run in order against it, one at
// a time, because the hub plays one case at a time.
export default defineConfig({
  test: {
    reporters: ["default", "junit", ...tracked("conformance")],
    outputFile: { junit: "reports/junit-conformance.xml" },
    include: ["test/conformance/**/*.test.ts"],
    globalSetup: ["test/conformance/hub.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
