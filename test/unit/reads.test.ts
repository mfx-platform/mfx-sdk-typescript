import { describe, expect, it } from "vitest";

import {
  Channel,
  MfxClient,
  StateError,
  StreamMessage,
  UpstreamError,
  type BrokerCatalogue,
  type CatalogSymbol,
  type MaintenanceWindowChanged,
  type SymbolPage,
  type SymbolSpecChange,
  type SymbolSpecChanged,
  type Terminal,
  type TerminalConditionChanged,
} from "../../src/index.js";
import { BASE, SEED, error, fake, json } from "./net.js";

const ID = "0191f0c2-aaaa-7bbb-8ccc-000000000001";
const BROKER = "2c2d3e4f-5a6b-7c8d-9e0f-102030405060";
const SERVER = "3c2d3e4f-5a6b-7c8d-9e0f-102030405060";

const client = (net: ReturnType<typeof fake>) =>
  new MfxClient(BASE, "mfxk_TEST", SEED, { fetch: net.fetch, sleep: () => Promise.resolve() });
const JOURNAL = {
  terminal_id: ID,
  from: "live",
  read_at: "2026-11-04T10:00:00Z",
  stopped: null,
  lines: [{ ts: "2026-11-04T09:59:58Z", source: "Network", message: "authorized on Demo" }],
};

describe("a terminal's journal is read newest first, live or as its last words", () => {
  it("reads the journal with no query when no count is given", async () => {
    const net = fake(json(200, JOURNAL));
    const got = await client(net).terminals.journal(ID);
    expect(got.from).toBe("live");
    expect(got.lines[0]).toEqual({
      ts: "2026-11-04T09:59:58Z",
      source: "Network",
      message: "authorized on Demo",
    });
    expect(net.calls[0]?.url.pathname).toBe(`/v1/terminals/${ID}/journal`);
    expect(net.calls[0]?.url.search).toBe("");
  });

  it("asks for the number of lines given and returns last_words as the platform sends them", async () => {
    const net = fake(json(200, { ...JOURNAL, from: "last_words", stopped: "failed" }));
    const got = await client(net).terminals.journal(ID, { lines: 200 });
    expect(got).toMatchObject({ from: "last_words", stopped: "failed" });
    expect(net.calls[0]?.url.search).toBe("?lines=200");
  });
});

describe("a journal read refuses a bad argument before sending and raises the platform's typed errors", () => {
  it("refuses an id that is not a uuid and a count outside 1 to 200", async () => {
    const net = fake();
    const terminals = client(net).terminals;
    await expect(terminals.journal("t-1")).rejects.toBeInstanceOf(RangeError);
    await expect(terminals.journal(ID, { lines: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(terminals.journal(ID, { lines: 201 })).rejects.toBeInstanceOf(RangeError);
    await expect(terminals.journal(ID, { lines: 1.5 })).rejects.toBeInstanceOf(TypeError);
    await expect(terminals.journal(ID, { lines: "9" as unknown as number })).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(net.calls).toHaveLength(0);
  });

  it("throws a StateError when no last lines are held, and an UpstreamError on a 503", async () => {
    const net = fake(error(409, "state_error"), error(503, "upstream_error"));
    const terminals = client(net).terminals;
    await expect(terminals.journal(ID)).rejects.toBeInstanceOf(StateError);
    await expect(terminals.journal(ID)).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe("the terminal list is narrowed by label and state on the platform", () => {
  it("sends every label as its own parameter and the states comma-separated", async () => {
    const net = fake(json(200, { items: [], next_cursor: null }));
    await client(net).terminals.page({
      labels: { env: "prod", team: "fx" },
      state: ["ACTIVE", "OFFLINE"],
      limit: 50,
    });
    const url = net.calls[0]?.url;
    expect(url?.searchParams.getAll("label")).toEqual(["env:prod", "team:fx"]);
    expect(url?.searchParams.get("state")).toBe("ACTIVE,OFFLINE");
    expect(url?.searchParams.get("limit")).toBe("50");
  });

  it("takes one state as a string and sends no filter when none is given", async () => {
    const net = fake(
      json(200, { items: [], next_cursor: null }),
      json(200, { items: [], next_cursor: null }),
    );
    await client(net).terminals.page({ state: "FAILED" });
    await client(net).terminals.page();
    expect(net.calls[0]?.url.search).toBe("?state=FAILED");
    expect(net.calls[1]?.url.search).toBe("");
  });
});

describe("a terminal list filter the platform would refuse is refused before sending, and list keeps the filter on every page", () => {
  it("refuses a label key with a colon, too many labels, a long label and an empty state list", async () => {
    const net = fake();
    const terminals = client(net).terminals;
    const many = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, "v"]));
    await expect(terminals.page({ labels: { "a:b": "c" } })).rejects.toBeInstanceOf(RangeError);
    await expect(terminals.page({ labels: { "": "c" } })).rejects.toBeInstanceOf(RangeError);
    await expect(terminals.page({ labels: many })).rejects.toBeInstanceOf(RangeError);
    await expect(terminals.page({ labels: { k: "v".repeat(200) } })).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(terminals.page({ labels: { k: 1 as unknown as string } })).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(terminals.page({ state: [] })).rejects.toBeInstanceOf(RangeError);
    expect(net.calls).toHaveLength(0);
  });

  it("carries the filter and the limit onto every page of list", async () => {
    const net = fake(
      json(200, { items: [{ id: "a", state: "ACTIVE" }], next_cursor: "c2" }),
      json(200, { items: [{ id: "b", state: "ACTIVE" }], next_cursor: null }),
    );
    const seen: Terminal[] = [];
    for await (const t of client(net).terminals.list({
      labels: { env: "prod" },
      state: "ACTIVE",
      limit: 1,
    })) {
      seen.push(t);
    }
    expect(seen.map((t) => t.id)).toEqual(["a", "b"]);
    expect(net.calls[1]?.url.searchParams.get("cursor")).toBe("c2");
    for (const call of net.calls) {
      expect(call.url.searchParams.getAll("label")).toEqual(["env:prod"]);
      expect(call.url.searchParams.get("state")).toBe("ACTIVE");
      expect(call.url.searchParams.get("limit")).toBe("1");
    }
  });

  it("lists with no options", async () => {
    const net = fake(json(200, { items: [], next_cursor: null }));
    const none: Terminal[] = [];
    for await (const t of client(net).terminals.list()) none.push(t);
    expect(net.calls[0]?.url.search).toBe("");
  });
});

describe("a broker's catalogues are read with their hashes", () => {
  const row: BrokerCatalogue = {
    server_id: SERVER,
    account_type: "sd",
    source: "last_known",
    catalogue_hash: "ab12",
    symbols: 812,
    refreshed_at: "2026-11-04T09:00:00Z",
  };

  it("returns the rows from the items of the answer", async () => {
    const net = fake(json(200, { items: [row] }), json(200, { items: [] }));
    const got = await client(net).catalog.catalogues(BROKER);
    expect(got).toEqual([row]);
    expect(net.calls[0]?.url.pathname).toBe(`/v1/brokers/${BROKER}/catalogues`);
    expect(await client(net).catalog.catalogues(BROKER)).toEqual([]);
  });

  it("refuses a broker id that is not a uuid before sending", async () => {
    const net = fake();
    await expect(client(net).catalog.catalogues("b")).rejects.toBeInstanceOf(RangeError);
    expect(net.calls).toHaveLength(0);
  });
});

describe("a terminal carries the broker's words, the refusal kind and the server kind as the API sends them", () => {
  it("keeps the fields untouched, null included", async () => {
    const net = fake(
      json(200, {
        id: ID,
        state: "ACTIVE",
        server_kind: "demo",
        conditions: {
          BrokerConnected: {
            status: "failed",
            reason: "login_refused",
            broker_words: "Invalid account",
            refusal_kind: "invalid_account",
          },
          TicksFresh: { status: "ok", broker_words: null, refusal_kind: null },
        },
      }),
    );
    const got = await client(net).terminals.get(ID);
    expect(got.server_kind).toBe("demo");
    expect(got.conditions?.["BrokerConnected"]).toMatchObject({
      broker_words: "Invalid account",
      refusal_kind: "invalid_account",
    });
    expect(got.conditions?.["TicksFresh"]?.refusal_kind).toBeNull();
  });
});

describe("a catalogue symbol is typed with its identity fields and a page says whether it is live or last known", () => {
  it("types the identity fields and the page source", () => {
    const symbol: Partial<CatalogSymbol> = {
      path: "Forex\\Majors\\EURUSD",
      isin: null,
      exchange: "FX",
      category: "Forex",
      currency_base: "EUR",
      basis: "",
      calc_mode: "forex",
    };
    const source: SymbolPage["source"] = "last_known";
    expect(symbol.currency_base).toBe("EUR");
    expect(source).toBe("last_known");
  });
});

describe("the stream delivers the new event types and their payloads are typed", () => {
  it("delivers each event with its type and data", async () => {
    const window: MaintenanceWindowChanged = {
      schema_version: "1",
      window_id: ID,
      label: "MW-0031",
      state: "in_progress",
      change: "eta_moved",
    } as MaintenanceWindowChanged;
    const condition = {
      schema_version: "1",
      terminal_id: ID,
      condition: "BrokerConnected",
      status: "failed",
      broker_words: "Invalid account",
      refusal_kind: "invalid_account",
    } as TerminalConditionChanged;
    const spec = {
      schema_version: "1",
      symbol: "EURUSD",
      change: "came_back",
    } as SymbolSpecChanged;
    const frames = [
      { op: "ack", ch: "events" },
      ...[
        ["maintenance.window_changed", window],
        ["terminal.condition_changed", condition],
        ["symbol.spec_changed", spec],
      ].map(([type, data], i) => ({ op: "msg", ch: "events", seq: i + 1, type, data })),
    ];
    const stream = await client(fake()).stream({
      connect: () => {
        const queue = frames.map((f) => JSON.stringify(f));
        return Promise.resolve({
          send: () => Promise.resolve(),
          recv: () => {
            const next = queue.shift();
            return next === undefined ? Promise.reject(new Error("done")) : Promise.resolve(next);
          },
          close: () => Promise.resolve(),
        });
      },
      maxReconnects: 0,
    });
    await stream.subscribe(Channel.events);
    const got: StreamMessage[] = [];
    try {
      for await (const e of stream) {
        if (e instanceof StreamMessage) got.push(e);
      }
    } catch {
      // the scripted connection ends by failing
    }
    expect(got.map((m) => m.type)).toEqual([
      "maintenance.window_changed",
      "terminal.condition_changed",
      "symbol.spec_changed",
    ]);
    expect(got[1]?.data).toMatchObject({ broker_words: "Invalid account" });
    const changes: SymbolSpecChange[] = [
      "spec",
      "trading",
      "sessions",
      "removed",
      "added",
      "came_back",
      "description",
      "identity",
    ];
    expect(changes).toHaveLength(8);
  });
});
