import { describe, expect, it } from "vitest";

import { MfxClient, NotFoundError, Page, TradingAccounts } from "../../src/index.js";
import type { TradingAccount } from "../../src/index.js";
import { BASE, SEED, error, fake, json } from "./net.js";

const ID = "0191F0C2-AAAA-7BBB-8CCC-000000000002";
const account = (id: string, state: TradingAccount["state"] = "CONNECTED"): TradingAccount => ({
  id,
  venue: "mt5",
  environment: "demo",
  label: null,
  state,
  broker: { id: null, name: "MetaQuotes" },
  login_masked: "****6933",
  runners: [{ terminal_id: id, role: null }],
  created_at: "2026-11-09T16:00:00Z",
});

const client = (net: ReturnType<typeof fake>) =>
  new MfxClient(BASE, "mfxk_TEST", SEED, { fetch: net.fetch, sleep: () => Promise.resolve() });
const query = (net: ReturnType<typeof fake>, i = 0) => net.calls[i]?.url.searchParams;

describe("a trading account is read by its id, and a wrong id is refused before sending", () => {
  it("reads one account by its id", async () => {
    const net = fake(json(200, account(ID.toLowerCase())));
    const got = await client(net).tradingAccounts.get(ID);
    expect(got.state).toBe("CONNECTED");
    expect(net.calls[0]?.url.pathname).toBe(`/v1/accounts/${ID.toLowerCase()}`);
    expect(net.calls[0]?.init.method).toBe("GET");
  });

  it("throws NotFoundError for an account that is not the tenant's", async () => {
    const net = fake(error(404, "not_found"));
    await expect(client(net).tradingAccounts.get(ID)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses an id that is not a uuid before sending anything", async () => {
    const net = fake();
    await expect(client(net).tradingAccounts.get("a-1")).rejects.toBeInstanceOf(RangeError);
    expect(net.calls).toHaveLength(0);
  });
});

describe("a page of trading accounts sends its filters as the platform reads them", () => {
  it("sends every filter and returns the page", async () => {
    const net = fake(json(200, { items: [account(ID)], next_cursor: "c2", returned: 1 }));
    const page = await client(net).tradingAccounts.page({
      cursor: "c1",
      limit: 20,
      venue: ["mt5", "ctrader"],
      environment: "live",
      state: ["CONNECTED", "DEGRADED"],
    });
    expect(page).toBeInstanceOf(Page);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe("c2");
    const q = query(net);
    expect(net.calls[0]?.url.pathname).toBe("/v1/accounts");
    expect(q?.get("venue")).toBe("mt5,ctrader");
    expect(q?.get("state")).toBe("CONNECTED,DEGRADED");
    expect(q?.get("environment")).toBe("live");
    expect(q?.get("cursor")).toBe("c1");
    expect(q?.get("limit")).toBe("20");
  });

  it("sends one venue and one state as themselves, and nothing when not asked", async () => {
    const net = fake(
      json(200, { items: [], next_cursor: null }),
      json(200, { items: [], next_cursor: null }),
    );
    await client(net).tradingAccounts.page({ venue: "mt5", state: "PAUSED" });
    expect(query(net)?.get("venue")).toBe("mt5");
    expect(query(net)?.get("state")).toBe("PAUSED");
    await client(net).tradingAccounts.page();
    expect([...(query(net, 1)?.keys() ?? [])]).toEqual([]);
  });
});

describe("a filter or cursor the platform would refuse is refused before sending", () => {
  it("refuses each bad option", async () => {
    const net = fake();
    const accounts = client(net).tradingAccounts;
    await expect(accounts.page({ venue: [] })).rejects.toBeInstanceOf(RangeError);
    await expect(
      accounts.page({ state: [""] as unknown as TradingAccount["state"][] }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(accounts.page({ cursor: 3 as unknown as string })).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(accounts.page({ environment: 1 as unknown as "live" })).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(accounts.page({ limit: 201 })).rejects.toBeInstanceOf(RangeError);
    expect(net.calls).toHaveLength(0);
  });
});

describe("every trading account is listed by following the cursor, filters kept on every page", () => {
  it("follows the cursor with the filters kept", async () => {
    const net = fake(
      json(200, { items: [account("0191f0c2-aaaa-7bbb-8ccc-000000000003")], next_cursor: "n" }),
      json(200, { items: [account("0191f0c2-aaaa-7bbb-8ccc-000000000004")], next_cursor: null }),
    );
    const seen: string[] = [];
    for await (const one of client(net).tradingAccounts.list({
      venue: "mt5",
      environment: "demo",
      state: "CONNECTED",
      limit: 1,
    })) {
      seen.push(one.id);
    }
    expect(seen).toHaveLength(2);
    expect(query(net, 1)?.get("cursor")).toBe("n");
    for (const i of [0, 1]) {
      expect(query(net, i)?.get("venue")).toBe("mt5");
      expect(query(net, i)?.get("environment")).toBe("demo");
      expect(query(net, i)?.get("state")).toBe("CONNECTED");
      expect(query(net, i)?.get("limit")).toBe("1");
    }
  });

  it("lists everything with no options", async () => {
    const net = fake(json(200, { items: [account(ID)], next_cursor: null }));
    const all: TradingAccount[] = [];
    for await (const one of client(net).tradingAccounts.list()) all.push(one);
    expect(all).toHaveLength(1);
  });
});

describe("the client offers trading accounts beside the balance view of a terminal's account", () => {
  it("has both namespaces", () => {
    const built = client(fake());
    expect(built.tradingAccounts).toBeInstanceOf(TradingAccounts);
    expect(built.accounts).not.toBe(built.tradingAccounts);
  });
});
