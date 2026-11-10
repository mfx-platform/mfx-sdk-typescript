import { describe, expect, it } from "vitest";

import { MfxClient } from "../../src/index.js";
import type { ExecutionResult, TradingAccount } from "../../src/index.js";
import { BASE, SEED, error, fake, json } from "./net.js";

const ACCOUNT = "0191f0c2-aaaa-7bbb-8ccc-000000000002";
const COMMAND = "0191f0c2-bbbb-7ccc-8ddd-000000000001";
const GRANT = "0191f0c2-cccc-7ddd-8eee-000000000003";
const accepted = json(202, { command_id: COMMAND, state: "ACCEPTED", duplicate: false });
const ROOT = `/v1/accounts/${ACCOUNT}`;

const client = (net: ReturnType<typeof fake>) =>
  new MfxClient(BASE, "mfxk_TEST", SEED, { fetch: net.fetch, sleep: () => Promise.resolve() });
const sent = (net: ReturnType<typeof fake>, i = 0): unknown =>
  JSON.parse(new TextDecoder().decode(net.calls[i]?.init.body as Uint8Array));
const keyOf = (net: ReturnType<typeof fake>, i = 0) =>
  (net.calls[i]?.init.headers as Record<string, string>)["Idempotency-Key"];
const command = (result: Record<string, unknown>, state = "SUCCEEDED") =>
  json(200, {
    command_id: COMMAND,
    terminal_id: ACCOUNT,
    kind: "order_place",
    state,
    final: true,
    created_at: "2026-11-10T09:00:00Z",
    updated_at: "2026-11-10T09:00:01Z",
    result: {
      retryable: false,
      tickets: { order: null, deal: null, position: null },
      attempts: 1,
      ...result,
    },
  });
const ctraderAccount: TradingAccount = {
  id: ACCOUNT,
  venue: "ctrader",
  environment: "demo",
  label: null,
  state: "PENDING",
  broker: { id: null, name: "Pepperstone" },
  login_masked: "****4321",
  runners: [],
  created_at: "2026-11-10T09:00:00Z",
};
const grant = (state: string) => ({
  id: GRANT,
  environment: "demo",
  scope: "trading",
  state,
  return_url: "https://example.com/back",
  tenant_state: "u-7",
  created_at: "2026-11-10T09:00:00Z",
  granted_at: "2026-11-10T09:01:00Z",
  revoked_at: null,
  accounts: [
    {
      ctid_trader_account_id: "4321",
      live: false,
      broker_name: "Pepperstone",
      login_masked: "****4321",
      account_id: null,
    },
  ],
});

describe("each of the nine commands on a trading account goes to the account's route with the terminal route's body", () => {
  const k = { idempotencyKey: "k" };
  const cases: [string, (c: MfxClient) => Promise<ExecutionResult>, string, string, unknown][] = [
    [
      "place",
      (c) =>
        c.tradingAccounts.placeOrder(ACCOUNT, {
          symbol: "EURUSD",
          side: "buy",
          volume: "0.10",
          magic: 7,
          ...k,
        }),
      "POST",
      "orders",
      { symbol: "EURUSD", side: "buy", volume: "0.10", magic: 7 },
    ],
    [
      "cancel",
      (c) => c.tradingAccounts.cancelOrder(ACCOUNT, 11, k),
      "POST",
      "orders/11/cancel",
      undefined,
    ],
    [
      "modify order",
      (c) => c.tradingAccounts.modifyOrder(ACCOUNT, 11, { price: "1.1000", ...k }),
      "POST",
      "orders/11/modify",
      { price: "1.1000" },
    ],
    [
      "modify position",
      (c) => c.tradingAccounts.modifyPosition(ACCOUNT, 12, { sl: "1.0900", ...k }),
      "POST",
      "positions/12/modify",
      { sl: "1.0900" },
    ],
    [
      "close",
      (c) => c.tradingAccounts.closePosition(ACCOUNT, 12, k),
      "POST",
      "positions/12/close",
      {},
    ],
    [
      "close by",
      (c) => c.tradingAccounts.closePositionBy(ACCOUNT, 12, { byTicket: 13, ...k }),
      "POST",
      "positions/12/close-by",
      { by_ticket: 13 },
    ],
    [
      "close partial",
      (c) => c.tradingAccounts.closePositionPartial(ACCOUNT, 12, { volume: "0.05", ...k }),
      "POST",
      "positions/12/close-partial",
      { volume: "0.05" },
    ],
    [
      "set trailing",
      (c) => c.tradingAccounts.setTrailingStop(ACCOUNT, 12, { distance: "0.0020", ...k }),
      "PUT",
      "positions/12/trailing-stop",
      { distance: "0.0020" },
    ],
    [
      "clear trailing",
      (c) => c.tradingAccounts.clearTrailingStop(ACCOUNT, 12, k),
      "DELETE",
      "positions/12/trailing-stop",
      undefined,
    ],
  ];
  for (const [name, call, verb, path, body] of cases) {
    it(`${name} goes to the account route`, async () => {
      const net = fake(accepted);
      const result = await call(client(net));
      expect(net.calls[0]?.init.method).toBe(verb);
      expect(net.calls[0]?.url.pathname).toBe(`${ROOT}/${path}`);
      expect(keyOf(net)).toBe("k");
      if (body !== undefined) expect(sent(net)).toEqual(body);
      expect(result.commandId).toBe(COMMAND);
      expect(result.state).toBe("ACCEPTED");
    });
  }

  it("refuses a malformed account id as an accountId before sending", async () => {
    const net = fake();
    await expect(
      client(net).tradingAccounts.cancelOrder("a-1", 11, { idempotencyKey: "k" }),
    ).rejects.toThrow(/accountId/);
    expect(net.calls).toHaveLength(0);
  });
});

describe("a cTrader result reads its venue, its own code, its deals and its flags, and an MT5 one reads none", () => {
  it("reads each venue's answer", async () => {
    const deals = [
      { deal: 501, order: 401, position: 12, volume_units: "50000", price: "1.10010" },
      { deal: 502, order: 402, position: 13, volume_units: "50000", price: "1.10020" },
      { no: "deal" },
    ];
    const net = fake(
      command({
        ok: true,
        reason: null,
        venue: "ctrader",
        deals,
        volume_units: "100000",
        close_by_emulated: true,
        protection_not_set: true,
      }),
      command(
        {
          ok: false,
          reason: "insufficient_funds",
          venue: "ctrader",
          venue_code: "NOT_ENOUGH_MONEY",
          deals: null,
        },
        "FAILED",
      ),
      command(
        { ok: false, reason: "venue_unavailable", retryable: true, venue: "ctrader" },
        "FAILED",
      ),
      command({ ok: false, reason: "not_on_this_venue", venue: "ctrader" }, "REJECTED"),
      command({
        ok: true,
        reason: null,
        venue: "mt5",
        mt5_retcode: 10009,
        deals: null,
        volume_units: null,
      }),
    );
    const c = client(net);
    const emulated = await c.execution.getCommand(COMMAND);
    const broke = await c.execution.getCommand(COMMAND);
    const away = await c.execution.getCommand(COMMAND);
    const cannot = await c.execution.getCommand(COMMAND);
    const mt5 = await c.execution.getCommand(COMMAND);

    expect(emulated.venue).toBe("ctrader");
    expect(emulated.closeByEmulated).toBe(true);
    expect(emulated.protectionNotSet).toBe(true);
    expect(emulated.deals.map((d) => d.deal)).toEqual([501, 502]);
    expect(emulated.deals[0]).toEqual({
      deal: 501,
      order: 401,
      position: 12,
      volumeUnits: "50000",
      price: "1.10010",
    });
    expect(emulated.volumeUnits).toBe("100000");
    expect(broke.reason).toBe("insufficient_funds");
    expect(broke.venueCode).toBe("NOT_ENOUGH_MONEY");
    expect(broke.deals).toEqual([]);
    expect(away.reason).toBe("venue_unavailable");
    expect(away.retryable).toBe(true);
    expect(cannot.reason).toBe("not_on_this_venue");
    expect(cannot.retryable).toBe(false);
    expect(mt5.venue).toBe("mt5");
    expect(mt5.deals).toEqual([]);
    expect(mt5.volumeUnits).toBeNull();
    expect(mt5.venueCode).toBeNull();
    expect(mt5.closeByEmulated).toBe(false);
  });
});

describe("a trading account's funds, positions, pending orders, deals and symbols are read by the account", () => {
  it("reads each under the account", async () => {
    const symbols = {
      account_id: ACCOUNT,
      as_of: "2026-11-10T09:00:00Z",
      items: [
        {
          name: "EURUSD",
          symbol_id: 1,
          digits: 5,
          pip_position: 4,
          lot_size: "100000",
          volume_step: "0.01",
          volume_min: "0.01",
          volume_max: "100",
          leverage: 500,
          margin_rate: null,
          base_asset: "EUR",
          quote_asset: "USD",
          enabled: true,
        },
      ],
    };
    const list = { as_of: "2026-11-10T09:00:00Z", stale: false, items: [] };
    const net = fake(
      json(200, { terminal_id: ACCOUNT, snapshot: null, profile: null, stale: true }),
      json(200, list),
      json(200, list),
      json(200, { items: [], next_cursor: null, returned: 0 }),
      json(200, { items: [], next_cursor: null, returned: 0 }),
      json(200, symbols),
    );
    const c = client(net);
    const from = new Date("2026-11-03T00:00:00Z");
    const to = new Date("2026-11-10T00:00:00Z");
    const funds = await c.tradingAccounts.funds(ACCOUNT);
    await c.tradingAccounts.positions(ACCOUNT);
    await c.tradingAccounts.pendingOrders(ACCOUNT);
    const page = await c.tradingAccounts.dealsPage(ACCOUNT, { from, to, position: 12 });
    const every = [];
    for await (const deal of c.tradingAccounts.deals(ACCOUNT, { from, to })) every.push(deal);
    const got = await c.tradingAccounts.symbols(ACCOUNT);

    expect(net.calls.map((x) => x.url.pathname)).toEqual([
      `${ROOT}/account`,
      `${ROOT}/positions`,
      `${ROOT}/orders/pending`,
      `${ROOT}/history/deals`,
      `${ROOT}/history/deals`,
      `${ROOT}/symbols`,
    ]);
    expect(new Set(net.calls.map((x) => x.init.method))).toEqual(new Set(["GET"]));
    expect(net.calls[3]?.url.searchParams.get("position")).toBe("12");
    expect(net.calls[3]?.url.searchParams.get("from")).toBe("2026-11-03T00:00:00.000Z");
    expect(funds.stale).toBe(true);
    expect(page.items).toEqual([]);
    expect(every).toEqual([]);
    expect(got.items[0]?.volume_step).toBe("0.01");
  });

  it("refuses a malformed account id for the symbols before sending", async () => {
    const net = fake();
    await expect(client(net).tradingAccounts.symbols("a-1")).rejects.toThrow(/accountId/);
    expect(net.calls).toHaveLength(0);
  });
});

describe("a cTrader grant is started, read, its accounts connected and revoked", () => {
  it("drives the grant flow", async () => {
    const net = fake(
      json(201, {
        grant_id: GRANT,
        consent_url: "https://connect.example.com/c/abc",
        expires_at: "2026-11-10T09:15:00Z",
      }),
      json(200, grant("ACTIVE")),
      json(200, { items: [ctraderAccount] }),
      json(200, grant("REVOKED")),
    );
    const c = client(net);
    const started = await c.tradingAccounts.startCtraderGrant({
      environment: "demo",
      scope: "trading",
      returnUrl: "https://example.com/back",
      tenantState: "u-7",
      idempotencyKey: "g-1",
    });
    const got = await c.tradingAccounts.ctraderGrant(started.grant_id);
    const connected = await c.tradingAccounts.connectCtraderAccounts(GRANT, [4321], {
      idempotencyKey: "g-2",
    });
    const revoked = await c.tradingAccounts.revokeCtraderGrant(GRANT, { idempotencyKey: "g-3" });

    expect(net.calls[0]?.init.method).toBe("POST");
    expect(net.calls[0]?.url.pathname).toBe("/v1/accounts/ctrader/grants");
    expect(keyOf(net, 0)).toBe("g-1");
    expect(sent(net, 0)).toEqual({
      environment: "demo",
      scope: "trading",
      return_url: "https://example.com/back",
      tenant_state: "u-7",
    });
    expect(started.consent_url).toMatch(/^https:\/\//);
    expect(net.calls[1]?.url.pathname).toBe(`/v1/accounts/ctrader/grants/${GRANT}`);
    expect(got.accounts[0]?.ctid_trader_account_id).toBe("4321");
    expect(net.calls[2]?.url.pathname).toBe(`/v1/accounts/ctrader/grants/${GRANT}/accounts`);
    expect(sent(net, 2)).toEqual({ ctid_trader_account_ids: ["4321"] });
    expect(keyOf(net, 2)).toBe("g-2");
    expect(connected.map((a) => a.venue)).toEqual(["ctrader"]);
    expect(net.calls[3]?.init.method).toBe("DELETE");
    expect(keyOf(net, 3)).toBe("g-3");
    expect(revoked.state).toBe("REVOKED");
  });

  it("sends no tenant state when none is given", async () => {
    const net = fake(
      json(201, {
        grant_id: GRANT,
        consent_url: "https://connect.example.com/c/x",
        expires_at: "2026-11-10T09:15:00Z",
      }),
    );
    await client(net).tradingAccounts.startCtraderGrant({
      environment: "live",
      scope: "accounts",
      returnUrl: "https://example.com/b",
      idempotencyKey: "g",
    });
    expect(sent(net)).toEqual({
      environment: "live",
      scope: "accounts",
      return_url: "https://example.com/b",
    });
  });
});

describe("a grant call with a wrong argument is refused before anything is sent", () => {
  it("refuses a return URL that is not https", async () => {
    const net = fake();
    await expect(
      client(net).tradingAccounts.startCtraderGrant({
        environment: "demo",
        scope: "trading",
        returnUrl: "http://example.com",
        idempotencyKey: "g",
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(net.calls).toHaveLength(0);
  });

  it("refuses an empty choice of accounts", async () => {
    const net = fake();
    await expect(
      client(net).tradingAccounts.connectCtraderAccounts(GRANT, [], { idempotencyKey: "g" }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(net.calls).toHaveLength(0);
  });

  it("rejects with the platform's refusal of a plan without cTrader", async () => {
    const net = fake(error(403, "feature_not_entitled"));
    await expect(
      client(net).tradingAccounts.startCtraderGrant({
        environment: "demo",
        scope: "trading",
        returnUrl: "https://example.com/b",
        idempotencyKey: "g",
      }),
    ).rejects.toThrow(/feature_not_entitled/);
  });
});
