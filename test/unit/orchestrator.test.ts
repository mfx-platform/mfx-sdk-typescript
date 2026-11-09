import { describe, afterEach, beforeEach, expect, it, vi } from "vitest";

import { MfxClient, isUsable } from "../../src/index.js";
import { BASE, SEED, fake, json } from "./net.js";

const TERMINAL = "0191f0c2-aaaa-7bbb-8ccc-000000000001";
const FARM = "0191f0c2-aaaa-7bbb-8ccc-0000000000f1";
const ACTION = "0191f0c2-aaaa-7bbb-8ccc-0000000000b1";
const NOW = Date.parse("2026-11-10T02:00:00Z");

function client(net: ReturnType<typeof fake>, slept: number[] = []) {
  return new MfxClient(BASE, "mfxk_TEST", SEED, {
    fetch: net.fetch,
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
  });
}

const terminal = (state: string, queue: unknown = null) => ({
  id: TERMINAL,
  state,
  queue,
  created_at: "2026-11-10T01:59:00Z",
});
const queued = (startsInS: number, position = 3) =>
  terminal("QUEUED", {
    queued_at: "2026-11-10T01:59:30Z",
    position,
    expected_start_at: new Date(NOW + startsInS * 1000).toISOString(),
    reason: "cell_settling",
  });

function bodyOf(net: ReturnType<typeof fake>, n: number): unknown {
  return JSON.parse(new TextDecoder().decode(net.calls[n]?.init.body as Uint8Array));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a queued terminal is read as waiting for its turn, and waitUntilActive reads it again at its expected start", () => {
  it("reads QUEUED with its queue and paces on the expected start", async () => {
    const net = fake(
      json(200, queued(40)),
      json(200, queued(40)),
      json(200, queued(300, 1)),
      json(200, terminal("PROVISIONING")),
      json(200, terminal("LOGGING_IN")),
      json(200, terminal("ACTIVE")),
    );
    const slept: number[] = [];
    const c = client(net, slept);

    const first = await c.terminals.get(TERMINAL);
    expect(first.state).toBe("QUEUED");
    expect(isUsable(first)).toBe(false);
    expect(first.queue).toMatchObject({ position: 3, reason: "cell_settling" });

    const done = await c.terminals.waitUntilActive(TERMINAL);
    expect(done.state).toBe("ACTIVE");
    expect(slept).toEqual([40_000, 60_000, 8_000, 15_000]);
  });

  it("an expected start already past is read again after 2 s", async () => {
    const net = fake(json(200, queued(-30)), json(200, terminal("ACTIVE")));
    const slept: number[] = [];
    await client(net, slept).terminals.waitUntilActive(TERMINAL);
    expect(slept).toEqual([2_000]);
  });

  it("an expected start that cannot be read falls back to 2 s doubling", async () => {
    const unreadable = terminal("QUEUED", { position: null, expected_start_at: "soon" });
    const net = fake(json(200, unreadable), json(200, terminal("ACTIVE")));
    const slept: number[] = [];
    await client(net, slept).terminals.waitUntilActive(TERMINAL);
    expect(slept).toEqual([2_000]);
  });

  it("returns the last read when the time runs out, and a settled state at once", async () => {
    const net = fake(json(200, queued(600)), json(200, queued(600)));
    const slept: number[] = [];
    const last = await client(net, slept).terminals.waitUntilActive(TERMINAL, {
      timeoutMs: 5_000,
    });
    expect(last.state).toBe("QUEUED");
    expect(slept).toEqual([5_000]);

    const failed = fake(json(200, terminal("FAILED")));
    expect((await client(failed).terminals.waitUntilActive(TERMINAL)).state).toBe("FAILED");
    await expect(
      client(fake()).terminals.waitUntilActive(TERMINAL, { timeoutMs: -1 }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

const action = {
  id: ACTION,
  kind: "restart",
  state: "RUNNING",
  requested_by: "key:k1",
  reason: "nightly",
  requested_n: 3,
  accepted_n: 2,
  refused_n: 1,
  refused: [{ terminal_id: TERMINAL, code: "positions_open" }],
  counts: { queued: 2, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
  expected_finish_at: "2026-11-10T02:10:00Z",
  late: false,
  created_at: "2026-11-10T02:00:00Z",
  finished_at: null,
};

describe("a bulk restart or retire is one request answered with the action, and is followed and cancelled by its id", () => {
  it("sends the asks to their routes", async () => {
    const net = fake(
      json(202, action),
      json(202, { ...action, kind: "retire" }),
      json(200, action),
      json(200, { ...action, state: "CANCELLED" }),
    );
    const c = client(net);
    const restart = await c.terminals.bulkRestart({
      reason: "nightly",
      farmId: FARM,
      idempotencyKey: "bulk-1",
    });
    expect(restart.refused).toEqual([{ terminal_id: TERMINAL, code: "positions_open" }]);
    await c.terminals.bulkRetire({
      reason: "done",
      terminalIds: [TERMINAL],
      confirmOpenPositions: true,
      idempotencyKey: "bulk-2",
    });
    expect((await c.terminals.getBulkAction(ACTION)).expected_finish_at).toBe(
      "2026-11-10T02:10:00Z",
    );
    expect((await c.terminals.cancelBulkAction(ACTION, { idempotencyKey: "cancel-1" })).state).toBe(
      "CANCELLED",
    );

    expect(net.calls.map((x) => [x.init.method, x.url.pathname])).toEqual([
      ["POST", "/v1/terminals:restart"],
      ["POST", "/v1/terminals:retire"],
      ["GET", `/v1/bulk-actions/${ACTION}`],
      ["POST", `/v1/bulk-actions/${ACTION}/cancel`],
    ]);
    expect(bodyOf(net, 0)).toEqual({
      reason: "nightly",
      confirm_open_positions: false,
      farm_id: FARM,
    });
    expect(bodyOf(net, 1)).toEqual({
      reason: "done",
      confirm_open_positions: true,
      terminal_ids: [TERMINAL],
    });
    const headers = new Headers(net.calls[0]?.init.headers);
    expect(headers.get("idempotency-key")).toBe("bulk-1");
  });

  it("narrows by broker as by farm", async () => {
    const net = fake(json(202, action));
    await client(net).terminals.bulkRestart({
      reason: "broker patch",
      brokerId: FARM,
      idempotencyKey: "bulk-3",
    });
    expect(bodyOf(net, 0)).toEqual({
      reason: "broker patch",
      confirm_open_positions: false,
      broker_id: FARM,
    });
  });

  it("refuses an ask that names nothing, says nothing or has no key, before sending", async () => {
    const net = fake();
    const c = client(net);
    await expect(
      c.terminals.bulkRestart({ reason: "x", idempotencyKey: "k" }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      c.terminals.bulkRestart({ reason: " ", farmId: FARM, idempotencyKey: "k" }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      c.terminals.bulkRetire({ reason: "x", farmId: FARM, idempotencyKey: "" }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      c.terminals.bulkRetire({
        reason: "x",
        terminalIds: Array.from({ length: 1001 }, () => TERMINAL),
        idempotencyKey: "k",
      }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(c.terminals.getBulkAction("not-a-uuid")).rejects.toBeInstanceOf(RangeError);
    expect(net.calls).toEqual([]);
  });
});
