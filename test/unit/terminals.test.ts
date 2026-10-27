import { describe, expect, it } from "vitest";

import { MfxClient, NotFoundError, Page, RateLimitError, isUsable } from "../../src/index.js";
import { pageOf } from "../../src/pages.js";
import { BASE, SEED, error, fake, json } from "./net.js";

const ID = "0191F0C2-AAAA-7BBB-8CCC-000000000001";
const BROKER = "2c2d3e4f-5a6b-7c8d-9e0f-102030405060";
const SERVER = "3c2d3e4f-5a6b-7c8d-9e0f-102030405060";
const FARM = "1c2d3e4f-5a6b-7c8d-9e0f-102030405060";
const terminal = (id: string, state = "ACTIVE") => ({ id, state, instruments: [] });

const client = (net: ReturnType<typeof fake>) =>
  new MfxClient(BASE, "mfxk_TEST", SEED, { fetch: net.fetch, sleep: () => Promise.resolve() });
const sent = (net: ReturnType<typeof fake>, i = 0): unknown =>
  JSON.parse(new TextDecoder().decode(net.calls[i]?.init.body as Uint8Array));
const header = (net: ReturnType<typeof fake>, name: string, i = 0): string | undefined =>
  (net.calls[i]?.init.headers as Record<string, string> | undefined)?.[name];

describe("a terminal is read by its id, and a wrong id is refused before sending", () => {
  it("reads one terminal by its id, written lower-case as the API writes ids", async () => {
    const net = fake(json(200, terminal(ID.toLowerCase())));
    const got = await client(net).terminals.get(ID);
    expect(got.state).toBe("ACTIVE");
    expect(net.calls[0]?.url.pathname).toBe(`/v1/terminals/${ID.toLowerCase()}`);
    expect(net.calls[0]?.init.method).toBe("GET");
  });

  it("throws the typed error the platform's answer names", async () => {
    const net = fake(error(404, "not_found"));
    await expect(client(net).terminals.get(ID)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses an id that is not a uuid before sending anything", async () => {
    const net = fake();
    await expect(client(net).terminals.get("t-1")).rejects.toBeInstanceOf(RangeError);
    await expect(client(net).terminals.get(7 as unknown as string)).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(net.calls).toHaveLength(0);
  });
});

describe("one page of terminals is one request, with its cursor and no total", () => {
  it("reads one page with its cursor and size, and gives the next cursor", async () => {
    const net = fake(json(200, { items: [terminal(ID)], next_cursor: "c-3", returned: 1 }));
    const page = await client(net).terminals.page({ cursor: "c-2", limit: 2 });
    expect(page).toBeInstanceOf(Page);
    expect(page.length).toBe(1);
    expect([...page].map((t) => t.id)).toEqual([ID]);
    expect(page.nextCursor).toBe("c-3");
    expect(page.returned).toBe(1);
    expect(net.calls[0]?.url.search).toBe("?cursor=c-2&limit=2");
  });

  it("asks for the first page with no query when given nothing", async () => {
    const net = fake(json(200, { items: [], next_cursor: null }));
    const page = await client(net).terminals.page();
    expect(page.nextCursor).toBeNull();
    expect(page.returned).toBeNull();
    expect(net.calls[0]?.url.search).toBe("");
  });

  it("refuses a page size the API would refuse, and a cursor that is not a string", async () => {
    const net = fake();
    const terminals = client(net).terminals;
    await expect(terminals.page({ limit: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(terminals.page({ limit: 201 })).rejects.toBeInstanceOf(RangeError);
    await expect(terminals.page({ limit: 1.5 })).rejects.toBeInstanceOf(TypeError);
    await expect(terminals.page({ limit: "2" as unknown as number })).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(terminals.page({ cursor: 3 as unknown as string })).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(net.calls).toHaveLength(0);
  });
});

describe("listing terminals follows the cursor until it ends", () => {
  it("follows the cursor until it is null, one request a page", async () => {
    const net = fake(
      json(200, { items: [terminal("a")], next_cursor: "c-2" }),
      json(200, { items: [terminal("b"), terminal("c")], next_cursor: null }),
    );
    const ids: string[] = [];
    for await (const t of client(net).terminals.list({ limit: 2 })) ids.push(t.id);
    expect(ids).toEqual(["a", "b", "c"]);
    expect(net.calls.map((c) => c.url.search)).toEqual(["?limit=2", "?cursor=c-2&limit=2"]);
  });

  it("stops at a page whose cursor is empty, rather than reading the first page again", async () => {
    const net = fake(json(200, { items: [terminal("a")], next_cursor: "" }));
    const ids: string[] = [];
    for await (const t of client(net).terminals.list()) ids.push(t.id);
    expect(ids).toEqual(["a"]);
    expect(net.calls).toHaveLength(1);
  });
});

describe("creating a terminal needs an idempotency key and is never resent", () => {
  it("sends the request with its idempotency key, the defaults spelled out", async () => {
    const net = fake(json(202, terminal(ID, "REQUESTED")));
    const got = await client(net).terminals.create({
      brokerId: BROKER,
      serverId: SERVER,
      idempotencyKey: "create-1",
    });
    expect(got.state).toBe("REQUESTED");
    expect(net.calls[0]?.init.method).toBe("POST");
    expect(header(net, "Idempotency-Key")).toBe("create-1");
    expect(sent(net)).toEqual({
      broker_id: BROKER,
      server_id: SERVER,
      streaming: false,
      execution: false,
      redundancy: "none",
    });
  });

  it("sends every option given, in the API's names", async () => {
    const net = fake(json(202, terminal(ID, "REQUESTED")));
    await client(net).terminals.create({
      brokerId: BROKER,
      serverId: SERVER,
      farmId: FARM,
      idempotencyKey: "create-2",
      streaming: true,
      execution: true,
      instruments: ["EURUSD.sd"],
      labels: { desk: "fx" },
      redundancy: "active_passive",
    });
    expect(sent(net)).toEqual({
      broker_id: BROKER,
      server_id: SERVER,
      farm_id: FARM,
      streaming: true,
      execution: true,
      instruments: ["EURUSD.sd"],
      labels: { desk: "fx" },
      redundancy: "active_passive",
    });
  });

  it("is sent once, never again, whatever the answer", async () => {
    const net = fake(error(429, "rate_limited", { "Retry-After": "0" }));
    await expect(
      client(net).terminals.create({ brokerId: BROKER, serverId: SERVER, idempotencyKey: "k" }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(net.calls).toHaveLength(1);
  });

  it("refuses a missing, empty or overlong idempotency key before sending anything", async () => {
    const net = fake();
    const terminals = client(net).terminals;
    const ask = (idempotencyKey: unknown) =>
      terminals.create({ brokerId: BROKER, serverId: SERVER, idempotencyKey } as never);
    await expect(ask(undefined)).rejects.toBeInstanceOf(TypeError);
    await expect(ask(" ")).rejects.toBeInstanceOf(RangeError);
    await expect(ask("k".repeat(129))).rejects.toBeInstanceOf(RangeError);
    expect(net.calls).toHaveLength(0);
  });
});

describe("only an ACTIVE terminal is usable", () => {
  it("is true only in ACTIVE", () => {
    expect(isUsable({ state: "ACTIVE" })).toBe(true);
    for (const state of ["REQUESTED", "OFFLINE", "DRAINED", "FAILED"] as const) {
      expect(isUsable({ state })).toBe(false);
    }
  });
});

describe("an answer that is not a page reads as an empty last page", () => {
  it("reads a body that is not a page as an empty last page", () => {
    const page = pageOf(null);
    expect(page.length).toBe(0);
    expect(page.nextCursor).toBeNull();
  });
});
