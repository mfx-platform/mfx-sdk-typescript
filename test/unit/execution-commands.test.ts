import { describe, expect, it } from "vitest";

import { MfxClient } from "../../src/index.js";
import { BASE, SEED, error, fake, json } from "./net.js";

const TERMINAL = "0191f0c2-aaaa-7bbb-8ccc-000000000001";
const COMMAND = "0191f0c2-bbbb-7ccc-8ddd-000000000001";
const accepted = json(202, { command_id: COMMAND, state: "ACCEPTED", duplicate: false });

const client = (net: ReturnType<typeof fake>, slept: number[] = []) =>
  new MfxClient(BASE, "mfxk_TEST", SEED, {
    fetch: net.fetch,
    sleep: (ms: number) => {
      slept.push(ms);
      return Promise.resolve();
    },
  });
const sent = (net: ReturnType<typeof fake>, i = 0): unknown => {
  const body = net.calls[i]?.init.body;
  return body === undefined ? undefined : JSON.parse(new TextDecoder().decode(body as Uint8Array));
};
const key = (net: ReturnType<typeof fake>, i = 0): string | undefined =>
  (net.calls[i]?.init.headers as Record<string, string>)["Idempotency-Key"];

describe("every order and position command goes to its own route, once, with its key and only what changes", () => {
  const cases: [string, string, string, (c: MfxClient) => Promise<unknown>, unknown][] = [
      ["modifyOrder", "POST", "orders/71/modify",
        (c) => c.execution.modifyOrder(TERMINAL, 71, { idempotencyKey: "k", price: "1.05" }),
        { price: "1.05" }],
      ["modifyOrder with an expiry", "POST", "orders/71/modify",
        (c) => c.execution.modifyOrder(TERMINAL, 71, { idempotencyKey: "k", expiresAt: new Date("2026-11-02T00:00:00Z") }),
        { expires_at: "2026-11-02T00:00:00.000Z" }],
      ["modifyOrder removing the expiry", "POST", "orders/71/modify",
        (c) => c.execution.modifyOrder(TERMINAL, 71, { idempotencyKey: "k", expiresAt: null }),
        { expires_at: null }],
      ["cancelOrder", "POST", "orders/71/cancel",
        (c) => c.execution.cancelOrder(TERMINAL, 71, { idempotencyKey: "k" }), undefined],
      ["modifyPosition", "POST", "positions/81/modify",
        (c) => c.execution.modifyPosition(TERMINAL, 81, { idempotencyKey: "k", sl: "1.09", tp: "1.14" }),
        { sl: "1.09", tp: "1.14" }],
      ["closePosition", "POST", "positions/81/close",
        (c) => c.execution.closePosition(TERMINAL, 81, { idempotencyKey: "k", deviationPoints: 5, comment: "done" }),
        { deviation_points: 5, comment: "done" }],
      ["closePositionPartial", "POST", "positions/81/close-partial",
        (c) => c.execution.closePositionPartial(TERMINAL, 81, { idempotencyKey: "k", volume: "0.01" }),
        { volume: "0.01" }],
      ["closePositionBy", "POST", "positions/81/close-by",
        (c) => c.execution.closePositionBy(TERMINAL, 81, { idempotencyKey: "k", byTicket: 82 }),
        { by_ticket: 82 }],
      ["setTrailingStop", "PUT", "positions/81/trailing-stop",
        (c) => c.execution.setTrailingStop(TERMINAL, 81, { idempotencyKey: "k", distance: "0.0020" }),
        { distance: "0.0020" }],
      ["clearTrailingStop", "DELETE", "positions/81/trailing-stop",
        (c) => c.execution.clearTrailingStop(TERMINAL, 81, { idempotencyKey: "k" }), undefined],
    ]; // prettier-ignore
  for (const [name, method, route, call, body] of cases) {
    it(`${name}: ${method} /terminals/{id}/${route}`, async () => {
      const net = fake(accepted);
      const result = await call(client(net));
      expect(net.calls).toHaveLength(1);
      expect(net.calls[0]?.init.method).toBe(method);
      expect(net.calls[0]?.url.pathname).toBe(`/v1/terminals/${TERMINAL}/${route}`);
      expect(key(net)).toBe("k");
      expect(sent(net)).toEqual(body);
      expect(result).toMatchObject({
        state: "ACCEPTED",
        commandId: COMMAND,
        idempotencyKey: "k",
      });
    });
  }

  it("a refusal resolves to a result, never a rejection", async () => {
    const net = fake(error(422, "invalid_request"));
    const result = await client(net).execution.cancelOrder(TERMINAL, 71, { idempotencyKey: "k" });
    expect(result).toMatchObject({ ok: false, commandId: null, idempotencyKey: "k" });
  });
});

describe("a wrong argument to an order or position command throws before anything is sent", () => {
  const bad: [string, (c: MfxClient) => Promise<unknown>][] = [
      ["ticket 0", (c) => c.execution.cancelOrder(TERMINAL, 0, { idempotencyKey: "k" })],
      ["ticket 1.5", (c) => c.execution.closePosition(TERMINAL, 1.5, { idempotencyKey: "k" })],
      ["ticket string", (c) => c.execution.closePosition(TERMINAL, "81" as unknown as number, { idempotencyKey: "k" })],
      ["no key", (c) => c.execution.cancelOrder(TERMINAL, 71, {} as { idempotencyKey: string })],
      ["number price", (c) => c.execution.modifyOrder(TERMINAL, 71, { idempotencyKey: "k", price: 1.05 as unknown as string })],
      ["nothing to modify", (c) => c.execution.modifyOrder(TERMINAL, 71, { idempotencyKey: "k" })],
      ["nothing to modify on a position", (c) => c.execution.modifyPosition(TERMINAL, 81, { idempotencyKey: "k" })],
      ["long comment", (c) => c.execution.closePosition(TERMINAL, 81, { idempotencyKey: "k", comment: "x".repeat(32) })],
      ["comment not text", (c) => c.execution.closePosition(TERMINAL, 81, { idempotencyKey: "k", comment: 7 as unknown as string })],
      ["partial without volume", (c) => c.execution.closePositionPartial(TERMINAL, 81, { idempotencyKey: "k" } as { idempotencyKey: string; volume: string })],
      ["close by itself", (c) => c.execution.closePositionBy(TERMINAL, 81, { idempotencyKey: "k", byTicket: 81 })],
      ["trailing distance number", (c) => c.execution.setTrailingStop(TERMINAL, 81, { idempotencyKey: "k", distance: 2 as unknown as string })],
    ]; // prettier-ignore
  for (const [name, call] of bad) {
    it(name, async () => {
      const net = fake();
      await expect(call(client(net))).rejects.toThrow(/./);
      expect(net.calls).toHaveLength(0);
    });
  }
});

describe("waitFor reads the command until it is final, backing off, and returns what it has when time runs out", () => {
  const command = (state: string) =>
    json(200, { command_id: COMMAND, state, duplicate: false, idempotency_key: "k" });

  it("returns the final result after backing off", async () => {
    const net = fake(command("EXECUTING"), command("EXECUTING"), command("SUCCEEDED"));
    const slept: number[] = [];
    const result = await client(net, slept).execution.waitFor(COMMAND, { idempotencyKey: "k" });
    expect(result).toMatchObject({ state: "SUCCEEDED", final: true, idempotencyKey: "k" });
    expect(slept).toEqual([200, 400]);
    expect(net.calls.every((c) => c.init.method === "GET")).toBe(true);
    expect(net.calls[0]?.url.pathname).toBe(`/v1/commands/${COMMAND}`);
  });

  it("stops at the time given and returns the last answer, not final", async () => {
    const answers = Array.from({ length: 20 }, () => command("EXECUTING"));
    const net = fake(...answers);
    const slept: number[] = [];
    const result = await client(net, slept).execution.waitFor(COMMAND, { timeoutMs: 5000 });
    expect(result).toMatchObject({ state: "EXECUTING", final: false });
    expect(slept).toEqual([200, 400, 800, 1600, 2000]);
    expect(slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(5000);
    expect(net.calls.every((c) => c.init.method === "GET")).toBe(true);
  });

  it("a timeout outside 1 ms to 10 minutes is refused before anything is read", async () => {
    const net = fake();
    await expect(client(net).execution.waitFor(COMMAND, { timeoutMs: 0 })).rejects.toThrow(
      RangeError,
    );
    expect(net.calls).toHaveLength(0);
  });
});
