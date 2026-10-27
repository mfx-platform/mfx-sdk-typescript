// Vendor a release of the shared SDK test suite into test/conformance/suite.
//
//     node tools/update-suite.mjs <path to a checkout of the suite at a release tag>
//
// The suite is copied, not fetched at test time, for the same reason the API description is: the
// tests must run from this repository alone, and a new case reaches this SDK only when the pin in
// test/conformance/suite-version.txt moves, in a reviewed pull request.
//
// The suite's fake hub is Python. Its exact dependencies, with their hashes, are written to
// test/conformance/hub-requirements.txt from the suite's own lock file, so CI installs the same
// packages the suite was released with. That step needs uv (https://docs.astral.sh/uv/).

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HERE = join(ROOT, "test", "conformance");
const TARGET = join(HERE, "suite");
// What an SDK needs from the suite: the cases, what they refer to, and the fake hub.
const TAKEN = ["cases", "fixtures.json", "vocabulary.json", "src/mfx_fake_hub", "LICENSE"];

const [suite] = process.argv.slice(2);
if (suite === undefined) {
  console.error("usage: node tools/update-suite.mjs <suite checkout>");
  process.exit(2);
}

const pyproject = readFileSync(join(suite, "pyproject.toml"), "utf8");
const version = /^version\s*=\s*"([^"]+)"/m.exec(pyproject)?.[1];
if (version === undefined) {
  console.error("the suite's pyproject.toml names no version");
  process.exit(1);
}
const commit = execFileSync("git", ["-C", suite, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

if (existsSync(TARGET)) rmSync(TARGET, { recursive: true });
mkdirSync(TARGET, { recursive: true });
for (const part of TAKEN) {
  const name = part.split("/").at(-1) ?? part;
  cpSync(join(suite, part), join(TARGET, name), {
    recursive: true,
    filter: (source) => !source.includes("__pycache__") && !source.endsWith(".pyc"),
  });
}

const requirements = execFileSync(
  "uv",
  [
    "export",
    "--frozen",
    "--no-dev",
    "--no-emit-project",
    "--no-header",
    "--format",
    "requirements-txt",
  ],
  { cwd: suite, encoding: "utf8" },
);
writeFileSync(
  join(HERE, "hub-requirements.txt"),
  `# The fake hub's dependencies, exported from mfx-sdk-conformance ${version}'s lock file by\n` +
    `# tools/update-suite.mjs. Installed with --require-hashes. Do not edit by hand.\n` +
    requirements.replace(/\r\n/g, "\n"),
);

const pin = `mfx-sdk-conformance ${version} (${commit})`;
writeFileSync(join(HERE, "suite-version.txt"), pin + "\n");
console.log(pin);
