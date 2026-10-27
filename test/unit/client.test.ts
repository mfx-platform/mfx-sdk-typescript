import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  AuthError,
  DependencyUnavailableError,
  EdgeError,
  MaintenanceError,
  MfxApiError,
  MfxClient,
  MfxTimeout,
  MfxTransportError,
  NotFoundError,
  RateLimitError,
  ValidationError,
  errorFor,
  VERSION,
  retryAfterSeconds,
} from "../../src/index.js";

import { BASE, SEED, error, fake, json } from "./net.js";

describe("the client retries a rate-limited read, never a write, and types every failure", () => {
  it("signs a read over its path and query, and keeps the budget the platform reports", async () => {
    const net = fake(
      json(
        200,
        { id: "t-1" },
        { "X-MFX-Budget-Remaining": "41", "X-MFX-Budget-Source": "counted" },
      ),
    );
    const client = new MfxClient(BASE, "mfxk_TEST", SEED, { fetch: net.fetch });
    expect(client.budget).toBeNull();
    const body = await client.read({
      method: "GET",
      path: "/terminals/t-1",
      query: { limit: 2, cursor: null },
    });
    expect(body).toEqual({ id: "t-1" });
    const sent = net.calls[0];
    expect(`${sent?.url.pathname ?? ""}${sent?.url.search ?? ""}`).toBe(
      "/v1/terminals/t-1?limit=2",
    );
    const headers = sent?.init.headers as Record<string, string>;
    expect(headers["X-MFX-Key"]).toBe("mfxk_TEST");
    expect(headers["X-MFX-Signature"]).toHaveLength(88);
    expect(client.budget).toEqual({ remaining: 41, source: "counted" });
    expect(client.keyId).toBe("mfxk_TEST");
    expect(client.baseUrl).toBe("https://api.dev.mfxhub.com/v1");
    expect(String(client)).toBe("MfxClient(https://api.dev.mfxhub.com/v1, mfxk_TEST)");
    expect(client.signer.keyId).toBe("mfxk_TEST");
  });

  it("retries a rate-limited read after the platform's delay, and never retries a write", async () => {
    const waits: number[] = [];
    const sleep = (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    };
    const net = fake(
      error(429, "rate_limited", { "Retry-After": "2" }),
      error(429, "rate_limited"),
      json(200, { ok: 1 }),
    );
    const client = new MfxClient(BASE, "k", SEED, { fetch: net.fetch, sleep, random: () => 1 });
    expect(await client.read({ method: "GET", path: "/usage" })).toEqual({ ok: 1 });
    expect(waits).toEqual([2000, 2000]);
    expect(
      new Set(net.calls.map((c) => (c.init.headers as Record<string, string>)["X-MFX-Nonce"])).size,
    ).toBe(3);

    const once = fake(error(429, "rate_limited", { "Retry-After": "1" }));
    const writer = new MfxClient(BASE, "k", SEED, { fetch: once.fetch, sleep });
    await expect(
      writer.write({
        method: "POST",
        path: "/terminals",
        body: { a: 1 },
        idempotencyKey: "key-1",
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(once.calls).toHaveLength(1);
    const sent = once.calls[0]?.init;
    expect((sent?.headers as Record<string, string>)["Idempotency-Key"]).toBe("key-1");
    expect((sent?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");

    const limited = fake(error(429, "rate_limited"), error(429, "rate_limited"));
    const giveUp = new MfxClient(BASE, "k", SEED, {
      fetch: limited.fetch,
      sleep,
      readRetries: 1,
    });
    await expect(giveUp.read({ method: "GET", path: "/usage" })).rejects.toMatchObject({
      name: "RateLimitError",
      status: 429,
    });
  });

  it("raises the typed error for a failure, by code and then by status", async () => {
    const net = fake(
      error(404, "not_found"),
      json(418, { error: { code: "teapot" } }),
      json(502, "<html>"),
      () => new Response("", { status: 500 }),
    );
    const client = new MfxClient(BASE, "k", SEED, { fetch: net.fetch });
    const missing = await client.read({ method: "GET", path: "/x" }).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(NotFoundError);
    expect(missing).toMatchObject({ code: "not_found", status: 404, details: { field: "x" } });
    const unknown = await client.read({ method: "GET", path: "/x" }).catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(MfxApiError);
    expect(unknown).toMatchObject({ code: "teapot", message: "GET /x failed" });
    await expect(client.read({ method: "GET", path: "/x" })).rejects.toBeInstanceOf(EdgeError);
    await expect(client.read({ method: "GET", path: "/x" })).rejects.toMatchObject({
      name: "InternalError",
    });
  });

  it("tells a connection that never opened from one that may have delivered the request", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
    const reset = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    const net = fake(
      () => Promise.reject(refused),
      () => Promise.reject(reset),
      () => Promise.reject(new DOMException("slow", "TimeoutError")),
      () => Promise.reject(new Error("other")),
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error rejection is the case
      () => Promise.reject("not an error"),
    );
    const client = new MfxClient(BASE, "k", SEED, { fetch: net.fetch, timeoutMs: 5 });
    const never = await client.send({ method: "POST", path: "/o" }).catch((e: unknown) => e);
    expect(never).toBeInstanceOf(MfxTransportError);
    expect(never).toMatchObject({ mayHaveReached: false });
    expect(
      await client.send({ method: "POST", path: "/o" }).catch((e: unknown) => e),
    ).toMatchObject({ mayHaveReached: true });
    expect(
      await client.send({ method: "POST", path: "/o" }).catch((e: unknown) => e),
    ).toBeInstanceOf(MfxTimeout);
    expect(
      await client.send({ method: "POST", path: "/o" }).catch((e: unknown) => e),
    ).toMatchObject({ mayHaveReached: true });
    expect(
      String(await client.send({ method: "POST", path: "/o" }).catch((e: unknown) => e)),
    ).toContain("not an error");
  });

  it("reads a body that is not JSON as text, and an empty one as null", async () => {
    const net = fake(
      () => new Response("plain", { status: 200 }),
      () => new Response(null, { status: 204 }),
    );
    const client = new MfxClient(BASE, "k", SEED, { fetch: net.fetch });
    expect(await client.read({ method: "GET", path: "/a" })).toBe("plain");
    expect(await client.read({ method: "GET", path: "/b" })).toBeNull();
    await client.pause(0);
    await new MfxClient(BASE, "k", SEED).pause(1);
  });
});

describe("every error code the API names is its own error class", () => {
  it("maps codes to kinds, keeps the code, and reads Retry-After", () => {
    expect(errorFor("maintenance", "m", 403)).toBeInstanceOf(MaintenanceError);
    expect(errorFor("dependency_unavailable", "d", 503)).toBeInstanceOf(DependencyUnavailableError);
    expect(errorFor("brand_new", "n", 401)).toBeInstanceOf(AuthError);
    expect(errorFor("brand_new", "n", 422)).toBeInstanceOf(ValidationError);
    expect(errorFor("brand_new", "n", 599)).toMatchObject({
      name: "MfxApiError",
      code: "brand_new",
    });
    expect(retryAfterSeconds(null)).toBeNull();
    expect(retryAfterSeconds(" ")).toBeNull();
    expect(retryAfterSeconds("7")).toBe(7);
    expect(retryAfterSeconds("-3")).toBe(0);
    expect(retryAfterSeconds("never")).toBeNull();
    expect(retryAfterSeconds(new Date(Date.now() + 60_000).toUTCString())).toBeGreaterThan(50);
  });
});

describe("the client copes with an answer it cannot read and an aborted request", () => {
  it("covers every error kind, a budget without its source and an aborted request", async () => {
    const codes = [
      "validation_error",
      "auth_error",
      "forbidden",
      "tenant_disabled",
      "tenant_suspended",
      "maintenance",
      "not_found",
      "conflict",
      "state_error",
      "placement_error",
      "broker_not_supported",
      "rate_limited",
      "upstream_error",
      "dependency_unavailable",
      "internal_error",
    ];
    const names = codes.map((code) => errorFor(code, "m", 400).name);
    expect(new Set(names).size).toBe(codes.length);
    expect(new MfxApiError("m", 400, "c").retryAfterS).toBeNull();

    const net = fake(
      json(200, {}, { "X-MFX-Budget-Remaining": "5" }),
      () => Promise.reject(new DOMException("stopped", "AbortError")),
      () => Promise.reject(new DOMException("odd", "NetworkError")),
    );
    const client = new MfxClient(BASE, "k", SEED, { fetch: net.fetch });
    await client.read({ method: "GET", path: "/a" });
    expect(client.budget).toEqual({ remaining: 5, source: "" });
    expect(
      await client.send({ method: "GET", path: "/a" }).catch((e: unknown) => e),
    ).toBeInstanceOf(MfxTimeout);
    const odd = await client.send({ method: "GET", path: "/a" }).catch((e: unknown) => e);
    expect(odd).toBeInstanceOf(MfxTransportError);
    expect(odd).not.toBeInstanceOf(MfxTimeout);
  });

  it("reports the version it was published as", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(VERSION).toBe(manifest.version);
  });
});
