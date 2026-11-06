import { describe, expect, it } from "vitest";

import { MfxClient, StreamClosed, VERSION, type StreamConnection } from "../../src/index.js";
import { BASE, SEED, error, fake, json } from "./net.js";

const NAMED = `mfx-sdk-typescript/${VERSION}`;

/** A connection that closes at once: enough to see what the upgrade carried. */
const shut: StreamConnection = {
  send: () => Promise.resolve(),
  recv: () => Promise.reject(new StreamClosed(1000, "")),
  close: () => Promise.resolve(),
};

describe("every request names the SDK and its version, so the platform can tell which SDK made a call", () => {
  it("names itself on a read and on the read's retry", async () => {
    const net = fake(error(429, "rate_limited", { "Retry-After": "0" }), json(200, { id: "t" }));
    const client = new MfxClient(BASE, "k", SEED, {
      fetch: net.fetch,
      sleep: () => Promise.resolve(),
    });
    await client.read({ method: "GET", path: "/terminals/t" });
    const agents = net.calls.map((c) => (c.init.headers as Record<string, string>)["User-Agent"]);
    expect(agents).toEqual([NAMED, NAMED]);
  });

  it("names itself on a write", async () => {
    const net = fake(json(202, { id: "c" }));
    const client = new MfxClient(BASE, "k", SEED, { fetch: net.fetch });
    await client.send({ method: "POST", path: "/x", body: {}, idempotencyKey: "i-1" });
    expect((net.calls[0]?.init.headers as Record<string, string>)["User-Agent"]).toBe(NAMED);
  });

  it("names itself on the stream's upgrade, beside the signature", async () => {
    const opened: Readonly<Record<string, string>>[] = [];
    const client = new MfxClient(BASE, "k", SEED, {});
    const stream = await client.stream({
      connect: (_url, headers) => {
        opened.push(headers);
        return Promise.resolve(shut);
      },
      maxReconnects: 0,
    });
    await stream.close();
    expect(opened[0]?.["User-Agent"]).toBe(NAMED);
    expect(opened[0]?.["X-MFX-Signature"]).toBeTruthy();
  });

  it("takes the version from the package, never typed twice", () => {
    expect(NAMED).toMatch(/^mfx-sdk-typescript\/\d+\.\d+\.\d+$/);
  });
});
