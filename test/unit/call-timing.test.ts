import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, afterEach, beforeEach, expect, it } from "vitest";

import { CALL_LOG_ENV, MfxClient, MfxTransportError, type CallTiming } from "../../src/index.js";
import { BASE, SEED, error, fake, json } from "./net.js";

/** A clock that moves 12.5 ms between the start of a call and its end. */
const stepping = (): (() => number) => {
  let t = 1000;
  return () => (t += 6.25);
};

describe("each HTTP attempt is timed, to a listener and to the file MFX_CALL_LOG names, so the platform's checks can count and time a sample's calls", () => {
  let dir = "";
  let log = "";
  const saved = process.env[CALL_LOG_ENV];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mfx-calls-"));
    log = join(dir, "calls.jsonl");
    Reflect.deleteProperty(process.env, CALL_LOG_ENV);
  });
  afterEach(() => {
    if (saved === undefined) Reflect.deleteProperty(process.env, CALL_LOG_ENV);
    else process.env[CALL_LOG_ENV] = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  it("tells the listener each attempt, a retried read being two", async () => {
    const told: CallTiming[] = [];
    const net = fake(error(429, "rate_limited", { "Retry-After": "0" }), json(200, { id: "t" }));
    const client = new MfxClient(BASE, "k", SEED, {
      fetch: net.fetch,
      sleep: () => Promise.resolve(),
      now: stepping(),
      onCall: (timing) => told.push(timing),
    });
    await client.read({ method: "GET", path: "/terminals/t" });
    expect(told).toEqual([
      { what: "GET /terminals/t", status: 429, ms: 6.25 },
      { what: "GET /terminals/t", status: 200, ms: 6.25 },
    ]);
  });

  it("says no answer came as a null status", async () => {
    const told: CallTiming[] = [];
    const net = fake(() => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    });
    const client = new MfxClient(BASE, "k", SEED, {
      fetch: net.fetch,
      now: stepping(),
      onCall: (timing) => told.push(timing),
    });
    await expect(client.read({ method: "GET", path: "/terminals/t" })).rejects.toBeInstanceOf(
      MfxTransportError,
    );
    expect(told.map((t) => t.status)).toEqual([null]);
  });

  it("appends one line a call to the file, with the status and the time and nothing else", async () => {
    process.env[CALL_LOG_ENV] = log;
    const net = fake(json(200, { id: "t" }), json(404, { error: { code: "not_found" } }));
    const client = new MfxClient(BASE, "mfxk_secret_id", SEED, {
      fetch: net.fetch,
      now: stepping(),
    });
    await client.read({ method: "GET", path: "/terminals/abc-123" });
    await client.send({ method: "GET", path: "/terminals/abc-123" });
    const text = readFileSync(log, "utf8");
    expect(
      text
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as unknown),
    ).toEqual([
      { status: 200, ms: 6.25 },
      { status: 404, ms: 6.25 },
    ]);
    expect(text).not.toMatch(/abc-123|mfxk_secret_id|terminals/);
  });

  it("times a call on the runtime's own clock when none is given", async () => {
    process.env[CALL_LOG_ENV] = log;
    const net = fake(json(200, {}));
    await new MfxClient(BASE, "k", SEED, { fetch: net.fetch }).read({
      method: "GET",
      path: "/x",
    });
    const line = JSON.parse(readFileSync(log, "utf8").trim()) as { status: number; ms: number };
    expect(line.status).toBe(200);
    expect(line.ms).toBeGreaterThanOrEqual(0);
  });

  it("never fails a call because the listener threw or the file cannot be written", async () => {
    process.env[CALL_LOG_ENV] = join(dir, "no-such-folder", "calls.jsonl");
    const net = fake(json(200, { id: "t" }));
    const client = new MfxClient(BASE, "k", SEED, {
      fetch: net.fetch,
      onCall: () => {
        throw new Error("a listener's bug");
      },
    });
    await expect(client.read({ method: "GET", path: "/terminals/t" })).resolves.toEqual({
      id: "t",
    });
  });

  it("writes nothing when no file is named", async () => {
    const net = fake(json(200, {}));
    await new MfxClient(BASE, "k", SEED, { fetch: net.fetch }).read({
      method: "GET",
      path: "/x",
    });
    expect(() => readFileSync(log)).toThrow();
  });
});
