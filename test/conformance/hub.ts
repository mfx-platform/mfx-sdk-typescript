// Starts the shared suite's fake MFX Hub once for the conformance run and hands its address to
// the tests. The hub is the suite's own Python program, vendored in ./suite; it listens on a free
// localhost port and prints `listening http://127.0.0.1:<port>/v1` when it is ready.
//
// The Python interpreter is MFX_SUITE_PYTHON when set (CI points it at an environment installed
// from hub-requirements.txt), otherwise `python3`, or `python` on Windows.

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    hubUrl: string;
  }
}

const SUITE = fileURLToPath(new URL("./suite", import.meta.url));
const STARTUP_MS = 20_000;

function listening(hub: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`the fake hub did not start within ${STARTUP_MS} ms`));
    }, STARTUP_MS);
    hub.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`the fake hub could not be started: ${error.message}`));
    });
    hub.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the fake hub stopped before listening (exit ${String(code)})`));
    });
    if (hub.stdout === null) throw new Error("the fake hub has no stdout");
    createInterface({ input: hub.stdout }).once("line", (line) => {
      clearTimeout(timer);
      if (line.startsWith("listening ")) resolve(line.slice("listening ".length).trim());
      else reject(new Error(`the fake hub said ${JSON.stringify(line)}, not where it listens`));
    });
  });
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const python =
    process.env.MFX_SUITE_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  const hub = spawn(python, ["-m", "mfx_fake_hub", "--cases", `${SUITE}/cases`], {
    env: { ...process.env, PYTHONPATH: SUITE, PYTHONDONTWRITEBYTECODE: "1" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    project.provide("hubUrl", await listening(hub));
  } catch (error) {
    hub.kill();
    throw error;
  }
  return async () => {
    if (hub.exitCode !== null) return;
    const stopped = new Promise((resolve) => hub.once("exit", resolve));
    hub.kill();
    await stopped;
  };
}
