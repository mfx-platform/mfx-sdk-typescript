import { describe, expect, it } from "vitest";

import { MfxClient, type PlaceOrder } from "../../src/index.js";
import { concluded, fromCommand } from "../../src/results.js";
import { BASE, SEED, error, fake, json, type Handler } from "./net.js";

const TERMINAL = "0191f0c2-aaaa-7bbb-8ccc-000000000001";
const COMMAND = "0191f0c2-bbbb-7ccc-8ddd-000000000001";
const ORDER: PlaceOrder = { symbol: "EURUSD", side: "buy", volume: "0.01", idempotencyKey: "k-1" };
const accepted = json(202, { command_id: COMMAND, state: "ACCEPTED", duplicate: false });

const client = (net: ReturnType<typeof fake>) =>
  new MfxClient(BASE, "mfxk_TEST", SEED, { fetch: net.fetch, sleep: () => Promise.resolve() });
const sent = (net: ReturnType<typeof fake>, i = 0): unknown =>
  JSON.parse(new TextDecoder().decode(net.calls[i]?.init.body as Uint8Array));
const throwing =
  (fault: unknown): Handler =>
  () => {
    throw fault;
  };
const refusedBy = (code: string): Error => new TypeError("fetch failed", { cause: { code } });

describe("an accepted order carries its command, and a duplicate is the original", () => {
  it("posts the order to the terminal, with the key as Idempotency-Key, once", async () => {
    const net = fake(accepted);
    const result = await client(net).execution.placeOrder(TERMINAL, ORDER);
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]?.init.method).toBe("POST");
    expect(net.calls[0]?.url.pathname).toBe(`/v1/terminals/${TERMINAL}/orders`);
    expect((net.calls[0]?.init.headers as Record<string, string>)["Idempotency-Key"]).toBe("k-1");
    expect(sent(net)).toEqual({ symbol: "EURUSD", side: "buy", volume: "0.01" });
    expect(result).toMatchObject({
      ok: false,
      state: "ACCEPTED",
      commandId: COMMAND,
      duplicate: false,
      final: false,
      retryable: false,
      idempotencyKey: "k-1",
      reason: null,
      detail: null,
    });
    expect(result.clientRttMs).toBeGreaterThanOrEqual(0);
  });

  it("sends every option in the API's names, decimals as plain strings", async () => {
    const net = fake(accepted);
    await client(net).execution.placeOrder(TERMINAL, {
      ...ORDER,
      side: "sell",
      orderType: "stop_limit",
      price: "1.1E0",
      stopLimitPrice: "1.0995",
      sl: "1.09",
      tp: "1.12",
      deviationPoints: 10,
      expiresAt: new Date("2026-10-28T12:00:00Z"),
      expiresInMs: 5000,
      magic: 7,
      comment: "grid",
    });
    expect(sent(net)).toEqual({
      symbol: "EURUSD",
      side: "sell",
      volume: "0.01",
      order_type: "stop_limit",
      price: "1.1",
      stop_limit_price: "1.0995",
      sl: "1.09",
      tp: "1.12",
      deviation_points: 10,
      expires_at: "2026-10-28T12:00:00.000Z",
      expires_in_ms: 5000,
      magic: 7,
      comment: "grid",
    });
  });

  it("passes an expiry given as a string through as written", async () => {
    const net = fake(accepted);
    await client(net).execution.placeOrder(TERMINAL, {
      ...ORDER,
      expiresAt: "2026-10-28T12:00Z",
    });
    expect(sent(net)).toMatchObject({ expires_at: "2026-10-28T12:00Z" });
  });

  it("reads a duplicate as the original command, not a second one", async () => {
    const net = fake(json(202, { command_id: COMMAND, state: "EXECUTING", duplicate: true }));
    const result = await client(net).execution.placeOrder(TERMINAL, ORDER);
    expect(result).toMatchObject({ duplicate: true, commandId: COMMAND, final: false });
    expect(net.calls).toHaveLength(1);
  });
});

const command = (state: string, result: Record<string, unknown> | null) =>
  json(200, {
    command_id: COMMAND,
    terminal_id: TERMINAL,
    kind: "order_place",
    state,
    final: ["SUCCEEDED", "FAILED", "EXPIRED", "REJECTED"].includes(state),
    created_at: "2026-10-28T09:00:00Z",
    updated_at: "2026-10-28T09:00:00.184Z",
    result,
  });
const FILLED = {
  ok: true,
  reason: null,
  retryable: false,
  mt5_retcode: 10009,
  comment_raw: "filled",
  tickets: { order: 8811, deal: 9922, position: 8811 },
  exec_price: "1.09431",
  exec_volume: "0.01",
  attempts: 1,
};
const repeat = (state: string) => json(202, { command_id: COMMAND, state, duplicate: true });

describe("a final duplicate returns the original result, read once", () => {
  it("returns a fill in full: ok, price, tickets and comment", async () => {
    const net = fake(repeat("SUCCEEDED"), command("SUCCEEDED", FILLED));
    const result = await client(net).execution.placeOrder(TERMINAL, ORDER);
    expect(net.calls.map((c) => [c.init.method, c.url.pathname])).toEqual([
      ["POST", `/v1/terminals/${TERMINAL}/orders`],
      ["GET", `/v1/commands/${COMMAND}`],
    ]);
    expect(result).toMatchObject({
      ok: true,
      state: "SUCCEEDED",
      final: true,
      duplicate: true,
      retryable: false,
      commandId: COMMAND,
      idempotencyKey: "k-1",
      execPrice: "1.09431",
      commentRaw: "filled",
      tickets: { order: 8811, deal: 9922, position: 8811 },
      detail: null,
    });
  });

  it("returns a rejection with its reason", async () => {
    const rejected = { ...FILLED, ok: false, reason: "market_closed", exec_price: null };
    const net = fake(repeat("REJECTED"), command("REJECTED", rejected));
    const result = await client(net).execution.placeOrder(TERMINAL, ORDER);
    expect(result).toMatchObject({ ok: false, reason: "market_closed", duplicate: true });
    expect(result.execPrice).toBeNull();
  });

  it("makes no extra request for a repeat in flight, a first answer, or a read", async () => {
    const net = fake(
      repeat("EXECUTING"),
      json(202, { command_id: COMMAND, state: "SUCCEEDED", duplicate: false }),
      command("SUCCEEDED", FILLED),
    );
    const sdk = client(net).execution;
    const inFlight = await sdk.placeOrder(TERMINAL, ORDER);
    const first = await sdk.placeOrder(TERMINAL, { ...ORDER, idempotencyKey: "k-2" });
    const read = await sdk.getCommand(COMMAND);
    expect(net.calls).toHaveLength(3);
    expect(inFlight).toMatchObject({ ok: false, state: "EXECUTING", duplicate: true });
    expect(first).toMatchObject({ ok: true, state: "SUCCEEDED", duplicate: false });
    expect(read).toMatchObject({ ok: true, execPrice: "1.09431", duplicate: false });
  });
});

describe("a final duplicate whose read fails is still what the platform said", () => {
  const faults: [string, Handler][] = [
    ["503", error(503, "dependency_unavailable")],
    ["404", error(404, "not_found")],
    ["a dropped connection", throwing(refusedBy("ECONNRESET"))],
    ["an answer that is not a command", json(200, { nothing: true })],
  ];
  it.each(faults)("after %s", async (_, fault) => {
    const net = fake(repeat("SUCCEEDED"), fault);
    const result = await client(net).execution.placeOrder(TERMINAL, ORDER);
    expect(result).toMatchObject({
      ok: true,
      state: "SUCCEEDED",
      final: true,
      duplicate: true,
      retryable: false,
      commandId: COMMAND,
      idempotencyKey: "k-1",
      execPrice: null,
      tickets: { order: null, deal: null, position: null },
    });
    expect(result.detail).toContain(`execution.getCommand('${COMMAND}') reads it`);
    expect(net.calls).toHaveLength(2);
  });
});

describe("getCommand reads one command and never rejects", () => {
  it("reads the command, carrying the key it is given", async () => {
    const net = fake(command("SUCCEEDED", FILLED));
    const result = await client(net).execution.getCommand(COMMAND, "k-9");
    expect(net.calls[0]?.init.method).toBe("GET");
    expect(net.calls[0]?.url.pathname).toBe(`/v1/commands/${COMMAND}`);
    expect(
      (net.calls[0]?.init.headers as Record<string, string>)["Idempotency-Key"],
    ).toBeUndefined();
    expect(result).toMatchObject({ ok: true, idempotencyKey: "k-9", execPrice: "1.09431" });
  });

  it("resolves with an in-flight command as it is, and a refusal as a result", async () => {
    const net = fake(command("EXECUTING", null), error(404, "not_found"));
    const sdk = client(net).execution;
    expect(await sdk.getCommand(COMMAND)).toMatchObject({
      ok: false,
      final: false,
      idempotencyKey: "",
    });
    expect(await sdk.getCommand(COMMAND)).toMatchObject({ ok: false, reason: "refused" });
  });

  it("throws for an id that is not a UUID, before sending", async () => {
    const net = fake();
    await expect(client(net).execution.getCommand("nope")).rejects.toThrow(/commandId/);
    expect(net.calls).toHaveLength(0);
  });
});

describe("placing an order never rejects, and an order that may have arrived is never marked safe to resend", () => {
  it("a refusal is a result that is not ok and not retryable", async () => {
    const net = fake(error(409, "state_error"));
    const result = await client(net).execution.placeOrder(TERMINAL, ORDER);
    expect(result).toMatchObject({ ok: false, reason: "refused", retryable: false, final: true });
    expect(result.detail).toContain("refused: state_error");
  });

  it("a rate limit is a result, retryable, and the order is not sent twice", async () => {
    const net = fake(error(429, "rate_limited", { "Retry-After": "3" }));
    const result = await client(net).execution.placeOrder(TERMINAL, ORDER);
    expect(net.calls).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, reason: "rate_limited", retryable: true });
  });

  it("a maintenance window is a result, retryable when it ends", async () => {
    const net = fake(
      json(403, {
        error: {
          code: "maintenance",
          message: "paused",
          details: { ends_at: "2026-10-28T02:00:00Z" },
        },
      }),
    );
    const result = await client(net).execution.placeOrder(TERMINAL, ORDER);
    expect(result).toMatchObject({ ok: false, reason: "maintenance", retryable: true });
    expect(result.retryAt?.toISOString()).toBe("2026-10-28T02:00:00.000Z");
  });

  it("a maintenance window without a readable end has no retry time", async () => {
    for (const details of [{}, { ends_at: "soon" }]) {
      const net = fake(json(403, { error: { code: "maintenance", message: "paused", details } }));
      const result = await client(net).execution.placeOrder(TERMINAL, ORDER);
      expect(result.retryAt).toBeNull();
    }
  });

  it("a connection that dropped after the order was sent reads UNKNOWN, not retryable", async () => {
    const net = fake(throwing(refusedBy("UND_ERR_SOCKET")));
    const result = await client(net).execution.placeOrder(TERMINAL, ORDER);
    expect(result).toMatchObject({
      ok: false,
      state: "UNKNOWN",
      reason: "transport_error",
      retryable: false,
    });
  });

  it("a connection that never opened placed nothing, so it is retryable", async () => {
    const net = fake(throwing(refusedBy("ECONNREFUSED")));
    const result = await client(net).execution.placeOrder(TERMINAL, ORDER);
    expect(result).toMatchObject({ state: null, reason: "transport_error", retryable: true });
  });

  it("no answer in time is never retryable: the order may have been placed", async () => {
    const net = fake(throwing(new DOMException("timed out", "TimeoutError")));
    const result = await client(net).execution.placeOrder(TERMINAL, ORDER);
    expect(result).toMatchObject({ ok: false, reason: "timeout", retryable: false, final: true });
  });
});

describe("a wrong order argument is refused before anything is sent", () => {
  const refusals: [string, Partial<Record<keyof PlaceOrder, unknown>>, ErrorConstructor][] = [
    ["a number as the volume", { volume: 0.07 * 3 }, TypeError],
    ["a number as a price", { price: 1.1 }, TypeError],
    ["a negative volume", { volume: "-1" }, RangeError],
    ["no idempotency key", { idempotencyKey: undefined }, TypeError],
    ["a side that is neither", { side: "long" }, TypeError],
    ["no symbol", { symbol: "" }, TypeError],
    ["a comment MT5 would cut", { comment: "x".repeat(32) }, RangeError],
    ["a fractional deviation", { deviationPoints: 1.5 }, TypeError],
    ["a hold outside 1 to 60 s", { expiresInMs: 500 }, RangeError],
    ["a negative magic number", { magic: -1 }, RangeError],
  ];
  it.each(refusals)("%s", async (_, change, kind) => {
    const net = fake();
    await expect(
      client(net).execution.placeOrder(TERMINAL, { ...ORDER, ...change } as PlaceOrder),
    ).rejects.toBeInstanceOf(kind);
    expect(net.calls).toHaveLength(0);
  });

  it("a terminal id that is not a uuid", async () => {
    const net = fake();
    await expect(client(net).execution.placeOrder("t-1", ORDER)).rejects.toBeInstanceOf(RangeError);
    expect(net.calls).toHaveLength(0);
  });
});

describe("a command's answer is read whole, and UNKNOWN is never retryable", () => {
  const command = {
    command_id: COMMAND,
    state: "SUCCEEDED",
    final: true,
    result: {
      ok: true,
      reason: "success",
      retryable: false,
      mt5_retcode: 10009,
      retcode_text: "done",
      comment_raw: "filled",
      terminal_state: "ACTIVE",
      tickets: { order: 1, deal: 2, position: 3 },
      exec_price: "1.12181",
      exec_volume: "0.01",
      broker_latency_ms: 40,
      agent_latency_ms: 3,
      attempts: 1,
      rerouted_from: TERMINAL,
    },
  };

  it("reads a whole command, keeping prices as the strings the API sent", () => {
    expect(fromCommand(command, "k", 12)).toEqual({
      ok: true,
      idempotencyKey: "k",
      clientRttMs: 12,
      commandId: COMMAND,
      state: "SUCCEEDED",
      final: true,
      retryable: false,
      duplicate: false,
      reason: "success",
      reasonText: "success",
      mt5Retcode: 10009,
      retcodeText: "done",
      commentRaw: "filled",
      terminalState: "ACTIVE",
      tickets: { order: 1, deal: 2, position: 3 },
      execPrice: "1.12181",
      execVolume: "0.01",
      brokerLatencyMs: 40,
      agentLatencyMs: 3,
      attempts: 1,
      reroutedFrom: TERMINAL,
      detail: null,
      retryAt: null,
    });
  });

  it("is never retryable while UNKNOWN, whatever the platform's flag says", () => {
    const unread = {
      command_id: COMMAND,
      state: "UNKNOWN",
      result: { ok: false, retryable: true },
    };
    expect(fromCommand(unread, "k", 1)).toMatchObject({ retryable: false, final: false });
  });

  it("treats a maintenance reason as retryable, and keeps a reason it does not know verbatim", () => {
    const paused = { state: "REJECTED", result: { ok: false, reason: "maintenance" } };
    expect(fromCommand(paused, "k", 1)).toMatchObject({ retryable: true, final: true });
    const novel = { state: "FAILED", result: { ok: false, reason: "broker_on_fire" } };
    expect(fromCommand(novel, "k", 1)).toMatchObject({
      reason: null,
      reasonText: "broker_on_fire",
    });
  });

  it("reads an answer that is not a command as nothing known", () => {
    for (const body of [null, [], "text", { state: "SIDEWAYS", result: [] }]) {
      expect(fromCommand(body, "k", 1)).toMatchObject({
        ok: false,
        state: null,
        final: false,
        commandId: null,
        attempts: 0,
        tickets: { order: null, deal: null, position: null },
      });
    }
  });
});

describe("a result the SDK concludes keeps its retry time", () => {
  it("keeps a retry time it is given", () => {
    const at = new Date("2026-10-28T02:00:00Z");
    expect(concluded("maintenance", "k", 1, "paused", { retryAt: at }).retryAt).toBe(at);
  });
});
