import { describe, expect, it } from "vitest";

import { MfxClient } from "../../src/index.js";
import { BASE, SEED, fake, json } from "./net.js";

const BROKER = "2c2d3e4f-5a6b-7c8d-9e0f-102030405060";
const SERVER = "3c2d3e4f-5a6b-7c8d-9e0f-102030405060";
const QUOTE = { symbol: "EURUSD", bid: "1.12129", ask: "1.12181", age_s: 1.5, state: "open" };
const client = (net: ReturnType<typeof fake>) =>
  new MfxClient(BASE, "mfxk_TEST", SEED, { fetch: net.fetch });

describe("a quote is read with its age and every digit of its prices", () => {
  it("reads the quote with its age, keeping every digit of its prices", async () => {
    const net = fake(json(200, QUOTE));
    const quote = await client(net).catalog.quote(BROKER, "EURUSD");
    expect(quote).toMatchObject({ bid: "1.12129", ask: "1.12181", age_s: 1.5 });
    expect(net.calls[0]?.url.pathname).toBe(`/v1/brokers/${BROKER}/symbols/EURUSD/quote`);
    expect(net.calls[0]?.url.search).toBe("");
  });

  it("names the server and account type when asked, and escapes the broker's symbol name", async () => {
    const net = fake(json(200, QUOTE));
    await client(net).catalog.quote(BROKER, "US30/cash", {
      serverId: SERVER,
      accountType: "raw",
    });
    expect(net.calls[0]?.url.pathname).toBe(`/v1/brokers/${BROKER}/symbols/US30%2Fcash/quote`);
    expect(net.calls[0]?.url.search).toBe(`?server_id=${SERVER}&account_type=raw`);
  });

  it("refuses a broker, symbol, server or account type it cannot send", async () => {
    const net = fake();
    const catalog = client(net).catalog;
    await expect(catalog.quote("b-1", "EURUSD")).rejects.toBeInstanceOf(RangeError);
    await expect(catalog.quote(BROKER, "")).rejects.toBeInstanceOf(TypeError);
    await expect(catalog.quote(BROKER, "EURUSD", { serverId: "s" })).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(
      catalog.quote(BROKER, "EURUSD", { accountType: 1 as unknown as string }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(net.calls).toHaveLength(0);
  });
});
