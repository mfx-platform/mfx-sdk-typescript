// Fail when anything internal would be published: in the package npm would ship, or in the whole
// public repository tree.
//
//     node tools/check-public.mjs --tree <directory>   # every text file under a directory
//     node tools/check-public.mjs --pack               # the files `npm pack` would publish
//
// Customers install this package and read its source and documents. Nothing in them may cite the
// team's internal designs, decisions, work items or test cases, or name an internal repository or
// a private customer. Two kinds of check:
//
// - Patterns for identifiers whose shape is the giveaway: work-item, decision and architecture
//   record ids, test-case ids, internal design paths and section references.
// - Names of private customers, internal repositories and other products, read from
//   tools/internal-names.txt. A list of words a public repository must never contain cannot be
//   published in it, so that file stays in the private repository and the export leaves it out:
//   the public repository runs the pattern check alone, and every release is checked with both
//   before it is exported.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Written so that these lines do not match themselves when this file is scanned.
const INTERNAL = /design[/]|\bDEC-\d+|AB#\d+|\bADR-\d+|TC-S[1]-|§ ?\d|\bLane \d|-intern[a]l\b/i;
// A tracker area path is upper case: MFX, a backslash, a capital. A lower-case file path that
// starts the same way is not one.
const AREA = /MFX[\\]{1,2}[A-Z]/;

const TEXT = [
  ".ts",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".py",
  ".toml",
  ".map",
];
const TEXT_NAMES = [
  "LICENSE",
  "CODEOWNERS",
  ".gitignore",
  ".gitattributes",
  ".prettierrc",
  ".editorconfig",
  ".prettierignore",
];
// Directories a tree scan never enters: git's own files, dependencies, caches and build output.
const SKIP = new Set([".git", "node_modules", "coverage", "reports", ".hub", "__pycache__"]);
const TOKEN = /[a-z0-9][a-z0-9-]*/g;

/** The private names, lower case; none when the file is absent (the public repository). */
export function loadNames(path = join(REPO, "tools", "internal-names.txt")) {
  if (!existsSync(path)) return new Set();
  return new Set(
    readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((line) => line.split("#", 1)[0].trim().toLowerCase())
      .filter((line) => line !== ""),
  );
}

const isText = (name) => TEXT.some((s) => name.endsWith(s)) || TEXT_NAMES.includes(name);

/** What in `line` is internal, or null. A name is reported by the token that carried it. */
export function match(line, names) {
  const found = INTERNAL.exec(line) ?? AREA.exec(line);
  if (found !== null) return found[0];
  for (const token of line.toLowerCase().match(TOKEN) ?? []) {
    for (const word of [token, ...token.split("-")]) {
      if (names.has(word)) return token;
    }
  }
  return null;
}

/** Every internal line of `sources` ([where, text] pairs), as `where:line: match`. */
export function scan(sources, names) {
  const out = [];
  for (const [where, text] of sources) {
    text.split(/\r?\n/).forEach((line, index) => {
      const hit = match(line, names);
      if (hit !== null) out.push(`${where}:${index + 1}: ${hit}`);
    });
  }
  return out;
}

function* walk(root, dir = root) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!SKIP.has(name)) yield* walk(root, path);
    } else if (isText(name)) {
      yield [relative(root, path).replaceAll("\\", "/"), readFileSync(path, "utf8")];
    }
  }
}

/** Every line under `root` that would publish something internal. */
export function treeFindings(root, names = loadNames()) {
  return scan(walk(root), names);
}

/** Every line of the files `npm pack` would publish from `root`. */
export function packFindings(root = REPO, names = loadNames()) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const [report] = JSON.parse(
    execFileSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: root,
      encoding: "utf8",
      shell: process.platform === "win32",
    }),
  );
  const files = report.files.map((f) => f.path).filter((path) => isText(path.split("/").at(-1)));
  return scan(
    files.map((path) => [path, readFileSync(join(root, path), "utf8")]),
    names,
  );
}

/* c8 ignore start - the command line, exercised by CI */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, dir] = process.argv.slice(2);
  let found;
  if (mode === "--tree") {
    const root = resolve(dir ?? REPO);
    if (!existsSync(root)) {
      console.error(`no directory at ${root}`);
      process.exit(2);
    }
    found = treeFindings(root);
  } else if (mode === "--pack") {
    found = packFindings();
  } else {
    console.error("usage: check-public.mjs --tree <directory> | --pack");
    process.exit(2);
  }
  for (const line of found) console.log(line);
  if (found.length > 0) {
    console.error(`${found.length} internal reference(s) would be published`);
    process.exit(1);
  }
  console.log("nothing internal");
}
/* c8 ignore stop */
