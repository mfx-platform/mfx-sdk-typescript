import { describe, expect, it } from "vitest";

import {
  MarketData,
  MfxClient,
  NotFoundError,
  RateLimitError,
  StateError,
  UpstreamError,
} from "../../src/index.js";
import type { AccountMdSubscription } from "../../src/index.js";
import { BASE, SEED, error, fake, json } from "./net.js";

const ACCOUNT = "0191F0C2-AAAA-7BBB-8CCC-000000000004";
const SUB = "0191F0C2-AAAA-7BBB-8CCC-0000000000A1";
const subscription = (symbol = "EURUSD", id = SUB.toLowerCase()): AccountMdSubscription => ({
  id,
  account_id: ACCOUNT.toLowerCase(),
  symbol,
  state: "pending",
  created_at: "2026-11-12T09:00:00Z",
});
const venueError = json(409, {
  error: {
    code: "state_error",
    message: "an MT5 account",
    details: { reason: "not_on_this_venue" },
  },
});

const client = (net: ReturnType<typeof fake>) =>
  new MfxClient(BASE, "mfxk_TEST", SEED, { fetch: net.fetch, sleep: () => Promise.resolve() });

describe("a ctrader account's spots are subscribed by account and an mt5 account is refused", () => {
  it("posts the symbol to the account's subscriptions", async () => {
    const net = fake(json(201, subscription()));
    const made = await client(net).md.subscribeAccount(ACCOUNT, "EURUSD", {
      idempotencyKey: "k1",
    });
    expect(made.state).toBe("pending");
    expect(made.account_id).toBe(ACCOUNT.toLowerCase());
    const call = net.calls[0];
    expect(call?.init.method).toBe("POST");
    expect(call?.url.pathname).toBe(`/v1/accounts/${ACCOUNT.toLowerCase()}/md/subscriptions`);
    expect(JSON.parse(new TextDecoder().decode(call?.init.body as Uint8Array))).toEqual({
      symbol: "EURUSD",
    });
    expect(new Headers(call?.init.headers).get("Idempotency-Key")).toBe("k1");
  });

  it("throws StateError for an MT5 account and never retries the write", async () => {
    const net = fake(venueError);
    const failure: unknown = await client(net)
      .md.subscribeAccount(ACCOUNT, "EURUSD", { idempotencyKey: "k2" })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(StateError);
    expect((failure as StateError).details).toMatchObject({ reason: "not_on_this_venue" });
    expect(net.calls).toHaveLength(1);
  });

  it("throws NotFoundError for an account that is not the tenant's", async () => {
    const net = fake(error(404, "not_found"));
    await expect(
      client(net).md.subscribeAccount(ACCOUNT, "EURUSD", { idempotencyKey: "k3" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses a bad id, symbol or key before sending anything", async () => {
    const net = fake();
    const md = client(net).md;
    await expect(md.subscribeAccount("a-1", "EURUSD", { idempotencyKey: "k" })).rejects.toThrow(
      RangeError,
    );
    await expect(md.subscribeAccount(ACCOUNT, "", { idempotencyKey: "k" })).rejects.toThrow(
      TypeError,
    );
    await expect(md.subscribeAccount(ACCOUNT, "EURUSD", { idempotencyKey: "" })).rejects.toThrow(
      RangeError,
    );
    expect(net.calls).toHaveLength(0);
    expect(md).toBeInstanceOf(MarketData);
  });
});

describe("an account's subscriptions are listed across pages and stopped by the id-keyed delete", () => {
  it("reads one page with its cursor and limit", async () => {
    const net = fake(
      json(200, { items: [subscription()], next_cursor: "c-2", returned: 1 }),
      json(200, { items: [], next_cursor: null, returned: 0 }),
    );
    const md = client(net).md;
    const page = await md.accountSubscriptionsPage(ACCOUNT, { cursor: "c-1", limit: 5 });
    expect(page.nextCursor).toBe("c-2");
    expect(page.items[0]?.symbol).toBe("EURUSD");
    const first = net.calls[0]?.url;
    expect(first?.pathname).toBe(`/v1/accounts/${ACCOUNT.toLowerCase()}/md/subscriptions`);
    expect(first?.searchParams.get("cursor")).toBe("c-1");
    expect(first?.searchParams.get("limit")).toBe("5");
    await md.accountSubscriptionsPage(ACCOUNT);
    expect(net.calls[1]?.url.search).toBe("");
  });

  it("follows the cursor to the last page", async () => {
    const net = fake(
      json(200, { items: [subscription("EURUSD")], next_cursor: "c-2", returned: 1 }),
      json(200, { items: [subscription("XAUUSD")], next_cursor: null, returned: 1 }),
    );
    const symbols: string[] = [];
    for await (const s of client(net).md.accountSubscriptions(ACCOUNT, { limit: 1 })) {
      symbols.push(s.symbol);
    }
    expect(symbols).toEqual(["EURUSD", "XAUUSD"]);
    expect(net.calls[1]?.url.searchParams.get("cursor")).toBe("c-2");
  });

  it("refuses a cursor that is not a string", async () => {
    const net = fake();
    await expect(
      client(net).md.accountSubscriptionsPage(ACCOUNT, { cursor: 7 as unknown as string }),
    ).rejects.toThrow(TypeError);
    expect(net.calls).toHaveLength(0);
  });

  it("stops a subscription with the id-keyed delete", async () => {
    const net = fake(() => new Response(null, { status: 204 }));
    await client(net).md.unsubscribe(SUB, { idempotencyKey: "k4" });
    const call = net.calls[0];
    expect(call?.init.method).toBe("DELETE");
    expect(call?.url.pathname).toBe(`/v1/md/subscriptions/${SUB.toLowerCase()}`);
    expect(new Headers(call?.init.headers).get("Idempotency-Key")).toBe("k4");
  });
});

describe("a ctrader account's bars are read by account and each documented refusal is typed", () => {
  const from = new Date("2026-11-12T09:00:00Z");
  const to = new Date("2026-11-12T11:00:00Z");
  const bar = {
    ts: "2026-11-12T09:00:00Z",
    o: "1.158",
    h: "1.1592",
    l: "1.1575",
    c: "1.159",
    v: 812,
  };

  it("reads a window and sends the limit only when given", async () => {
    const net = fake(json(200, { items: [bar] }), json(200, { items: [] }));
    const md = client(net).md;
    const bars = await md.accountCandles(ACCOUNT, {
      symbol: "EURUSD",
      timeframe: "H1",
      from,
      to,
    });
    expect(bars.items[0]).toEqual(bar);
    const sent = net.calls[0]?.url;
    expect(sent?.pathname).toBe(`/v1/accounts/${ACCOUNT.toLowerCase()}/md/candles`);
    expect(sent?.searchParams.get("symbol")).toBe("EURUSD");
    expect(sent?.searchParams.get("tf")).toBe("H1");
    expect(sent?.searchParams.get("from")).toBe("2026-11-12T09:00:00.000Z");
    expect(sent?.searchParams.get("to")).toBe("2026-11-12T11:00:00.000Z");
    expect(sent?.searchParams.has("limit")).toBe(false);

    const empty = await md.accountCandles(ACCOUNT, {
      symbol: "EURUSD",
      timeframe: "M5",
      from,
      to,
      limit: 300,
    });
    expect(empty.items).toEqual([]);
    expect(net.calls[1]?.url.searchParams.get("limit")).toBe("300");
  });

  it("refuses a bad timeframe, window, symbol or limit before sending", async () => {
    const net = fake();
    const md = client(net).md;
    const ask = (o: Record<string, unknown>) =>
      md.accountCandles(ACCOUNT, {
        symbol: "EURUSD",
        timeframe: "H1",
        from,
        to,
        ...o,
      });
    await expect(ask({ timeframe: "M2" })).rejects.toThrow(RangeError);
    await expect(ask({ from: to, to: from })).rejects.toThrow(RangeError);
    await expect(ask({ from: "2026-11-12" })).rejects.toThrow(TypeError);
    await expect(ask({ to: new Date("nope") })).rejects.toThrow(TypeError);
    await expect(ask({ symbol: "" })).rejects.toThrow(TypeError);
    await expect(ask({ limit: 1001 })).rejects.toThrow(RangeError);
    await expect(ask({ limit: 0 })).rejects.toThrow(RangeError);
    await expect(ask({ limit: 1.5 })).rejects.toThrow(RangeError);
    expect(net.calls).toHaveLength(0);
  });

  it("types an MT5 account, an unconnected runner and a read-limit refusal", async () => {
    const asked = { symbol: "EURUSD", timeframe: "H1", from, to } as const;
    await expect(client(fake(venueError)).md.accountCandles(ACCOUNT, asked)).rejects.toBeInstanceOf(
      StateError,
    );
    await expect(
      client(fake(error(503, "upstream_error"))).md.accountCandles(ACCOUNT, asked),
    ).rejects.toBeInstanceOf(UpstreamError);

    const limited = error(429, "terminal_reads_limit", { "Retry-After": "7" });
    const net = fake(limited, json(200, { items: [bar] }));
    const bars = await client(net).md.accountCandles(ACCOUNT, asked);
    expect(bars.items).toHaveLength(1);
    expect(net.calls).toHaveLength(2);

    const out = fake(limited, limited, limited, limited);
    await expect(client(out).md.accountCandles(ACCOUNT, asked)).rejects.toBeInstanceOf(
      RateLimitError,
    );
    expect(out.calls).toHaveLength(4);
  });
});
