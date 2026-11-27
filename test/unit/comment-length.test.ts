// An order's or a close's comment is at most 31 characters, counted as the contract's maxLength
// counts them: in code points. An emoji is one character, even though
// JavaScript's .length counts it as two UTF-16 units.

import { describe, expect, it } from "vitest";

import { MfxClient, type PlaceOrder } from "../../src/index.js";
import { BASE, SEED, fake, json } from "./net.js";

const TERMINAL = "0191f0c2-aaaa-7bbb-8ccc-000000000001";
const COMMAND = "0191f0c2-bbbb-7ccc-8ddd-000000000001";
const ORDER: PlaceOrder = { symbol: "EURUSD", side: "buy", volume: "0.01", idempotencyKey: "k-1" };
const accepted = json(202, { command_id: COMMAND, state: "ACCEPTED", duplicate: false });

/** 31 code points, 62 UTF-16 units. */
const EMOJI_31 = "\u{1F680}".repeat(31);
/** 32 code points. */
const EMOJI_32 = "\u{1F680}".repeat(32);
const MESSAGE = (n: number) =>
  `comment is at most 31 characters; the terminal would cut a longer one (${n} given)`;

const client = (net: ReturnType<typeof fake>) =>
  new MfxClient(BASE, "mfxk_TEST", SEED, { fetch: net.fetch, sleep: () => Promise.resolve() });
const sent = (net: ReturnType<typeof fake>): unknown =>
  JSON.parse(new TextDecoder().decode(net.calls[0]?.init.body as Uint8Array));

describe("an order comment of 31 emoji is sent: the limit counts code points, not UTF-16 units", () => {
  it("sends a 31-code-point comment", async () => {
    const net = fake(accepted);
    const result = await client(net).execution.placeOrder(TERMINAL, {
      ...ORDER,
      comment: EMOJI_31,
    });
    expect(result).toMatchObject({ state: "ACCEPTED", commandId: COMMAND });
    expect(net.calls).toHaveLength(1);
    expect((sent(net) as { comment: string }).comment).toBe(EMOJI_31);
  });
});

describe("an order comment of 32 code points is refused before anything is sent, naming how many were given", () => {
  it("refuses a 32-code-point comment", async () => {
    const net = fake();
    const refusal = client(net).execution.placeOrder(TERMINAL, { ...ORDER, comment: EMOJI_32 });
    await expect(refusal).rejects.toBeInstanceOf(RangeError);
    await expect(refusal).rejects.toThrow(MESSAGE(32));
    expect(net.calls).toHaveLength(0);
  });
});

describe("a close comment of 31 emoji is sent: the limit counts code points, not UTF-16 units", () => {
  it("sends a 31-code-point close comment", async () => {
    const net = fake(accepted);
    await client(net).execution.closePosition(TERMINAL, 81, {
      idempotencyKey: "k",
      comment: EMOJI_31,
    });
    expect(net.calls).toHaveLength(1);
    expect((sent(net) as { comment: string }).comment).toBe(EMOJI_31);
  });
});

describe("a close comment of 32 code points is refused before anything is sent, naming how many were given", () => {
  it("refuses a 32-code-point close comment", async () => {
    const net = fake();
    const refusal = client(net).execution.closePosition(TERMINAL, 81, {
      idempotencyKey: "k",
      comment: EMOJI_32,
    });
    await expect(refusal).rejects.toBeInstanceOf(RangeError);
    await expect(refusal).rejects.toThrow(MESSAGE(32));
    expect(net.calls).toHaveLength(0);
  });
});
