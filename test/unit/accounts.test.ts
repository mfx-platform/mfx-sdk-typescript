import { describe, expect, it } from "vitest";

import { MfxClient } from "../../src/index.js";
import { BASE, SEED, error, fake, json } from "./net.js";

const TERMINAL = "0191f0c2-aaaa-7bbb-8ccc-000000000001";
const client = (net: ReturnType<typeof fake>) =>
  new MfxClient(BASE, "mfxk_TEST", SEED, { fetch: net.fetch, sleep: () => Promise.resolve() });

const position = { ticket: 81, symbol: "EURUSD", side: "buy", volume: "0.01", open_price: "1.1" };
const pending = { ticket: 71, symbol: "EURUSD", side: "buy", order_type: "limit", price: "1.05" };
const deal = (id: number) => ({ deal: id, symbol: "EURUSD", volume: "0.01", price: "1.1" });

describe("the account, its positions and its pending orders are read from the terminal's latest snapshot", () => {
  it("reads each from its own route", async () => {
    const net = fake(
      json(200, { balance: "1000.00", equity: "1001.20", as_of: "2026-10-31T21:00:00Z" }),
      json(200, { items: [position], as_of: "2026-10-31T21:00:00Z" }),
      json(200, { items: [pending], as_of: "2026-10-31T21:00:00Z" }),
    );
    const c = client(net);
    expect(await c.accounts.account(TERMINAL)).toMatchObject({ equity: "1001.20" });
    expect((await c.accounts.positions(TERMINAL)).items).toEqual([position]);
    expect((await c.accounts.pendingOrders(TERMINAL)).items).toEqual([pending]);
    expect(net.calls.map((x) => [x.init.method, x.url.pathname])).toEqual([
      ["GET", `/v1/terminals/${TERMINAL}/account`],
      ["GET", `/v1/terminals/${TERMINAL}/positions`],
      ["GET", `/v1/terminals/${TERMINAL}/orders/pending`],
    ]);
  });

  it("a terminal that is not this tenant's is not found", async () => {
    const net = fake(error(404, "not_found"));
    await expect(client(net).accounts.positions(TERMINAL)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("deals are read inside a window, a page at a time or every page following the cursor", () => {
  const from = new Date("2026-10-30T00:00:00Z");
  const to = new Date("2026-10-31T00:00:00Z");

  it("sends the window and pages through it", async () => {
    const net = fake(
      json(200, { items: [deal(3), deal(2)], next_cursor: "c2", returned: 2 }),
      json(200, { items: [deal(1)], next_cursor: null, returned: 1 }),
    );
    const got: number[] = [];
    for await (const d of client(net).accounts.deals(TERMINAL, { from, to, limit: 2 })) {
      got.push(d.deal);
    }
    expect(got).toEqual([3, 2, 1]);
    const q0 = net.calls[0]?.url.searchParams;
    expect(q0?.get("from")).toBe("2026-10-30T00:00:00.000Z");
    expect(q0?.get("to")).toBe("2026-10-31T00:00:00.000Z");
    expect(q0?.get("limit")).toBe("2");
    expect(q0?.has("cursor")).toBe(false);
    expect(net.calls[1]?.url.searchParams.get("cursor")).toBe("c2");
  });

  it("reads one page", async () => {
    const net = fake(json(200, { items: [deal(1)], next_cursor: null }));
    const page = await client(net).accounts.dealsPage(TERMINAL, { from, to, cursor: "c9" });
    expect([...page].map((d) => d.deal)).toEqual([1]);
    expect(page.nextCursor).toBeNull();
    expect(net.calls[0]?.url.searchParams.get("cursor")).toBe("c9");
  });

  it("reads one position's deals", async () => {
    const net = fake(json(200, { items: [], next_cursor: null }));
    await client(net).accounts.dealsPage(TERMINAL, { from, to, position: 81 });
    expect(net.calls[0]?.url.searchParams.get("position")).toBe("81");
  });

  it("refuses a cursor or a position that is not one", async () => {
    const net = fake();
    const c = client(net);
    await expect(
      c.accounts.dealsPage(TERMINAL, { from, to, cursor: 7 as unknown as string }),
    ).rejects.toThrow(TypeError);
    await expect(c.accounts.dealsPage(TERMINAL, { from, to, position: 0 })).rejects.toThrow(
      TypeError,
    );
    expect(net.calls).toHaveLength(0);
  });

  it("refuses a window that is missing or backwards", async () => {
    const net = fake();
    const c = client(net);
    await expect(c.accounts.dealsPage(TERMINAL, { from: to, to: from })).rejects.toThrow(
      RangeError,
    );
    await expect(
      c.accounts.dealsPage(TERMINAL, { from } as unknown as { from: Date; to: Date }),
    ).rejects.toThrow(TypeError);
    expect(net.calls).toHaveLength(0);
  });
});
