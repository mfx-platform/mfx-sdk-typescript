// `client.billing`: the billing reads, and the 402 a missing payment answers a write with.
//
// A billing profile whose payment is missing goes from a notice to a reminder, when a request that
// adds something billed is refused, to a suspension, when every write on its accounts is. Both
// refusals are 402 `billing_payment_required`, with the stage, the dates and the portal page that
// clears it in `details`. Reads keep answering throughout, the billing reads among them.

import { describe, expect, it } from "vitest";

import {
  Billing,
  BillingPaymentRequiredError,
  KEY_HEADER,
  MfxApiError,
  MfxClient,
  NONCE_HEADER,
  NotFoundError,
  PaymentRequiredError,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  errorFor,
} from "../../src/index.js";
import { BASE, SEED, fake, json } from "./net.js";

const PROFILE = "0b7e5c1a-3d2f-4e6a-8b9c-1d2e3f4a5b6c";
const TENANT = "6f1c2a0e-1b8d-4f7a-9a51-7d0c1a2b3c4d";
const INVOICE = "7d1c2a0e-1b8d-4f7a-9a51-7d0c1a2b3c4d";
const TERMINAL = "0191f0c2-aaaa-7bbb-8ccc-000000000001";
const BROKER = "0191f0c2-cccc-7ddd-8eee-000000000001";
const SERVER = "0191f0c2-dddd-7eee-8fff-000000000001";
const POLICY = "4c2d3e4f-5a6b-7c8d-9e0f-102030405060";
const WORDS =
  "A payment is missing on billing profile Default: top up to keep your accounts running.";

/** The contract's own example of `BillingPaymentRequiredDetails`. */
const SPEC_EXAMPLE = {
  tenant_id: TENANT,
  billing_profile_id: PROFILE,
  stage: "reminder",
  cause: "balance_used_up",
  since: "2026-11-20T00:05:00Z",
  suspends_at: "2026-11-23T00:05:00Z",
  pay_by: "2026-11-23T00:04:59Z",
  action: {
    kind: "top_up",
    portal_path: "/billing/top-up",
    amount_usd: "10.00",
    invoice_id: null,
  },
};
const details = (over: object = {}) => ({ ...SPEC_EXAMPLE, ...over });
const paymentRequired = (d: unknown, code = "billing_payment_required") =>
  json(402, { error: { code, message: WORDS, details: d } });

const client = (net: ReturnType<typeof fake>) =>
  new MfxClient(BASE, "mfxk_TEST", SEED, { fetch: net.fetch, sleep: () => Promise.resolve() });
const ok = (body: unknown = {}) => json(200, body);
const sent = (net: ReturnType<typeof fake>, i = -1) => {
  const call = net.calls.at(i);
  if (call === undefined) throw new Error("no call");
  const headers = new Headers(call.init.headers);
  return {
    method: call.init.method,
    path: call.url.pathname,
    query: [...call.url.searchParams.entries()],
    signed:
      headers.get(KEY_HEADER) === "mfxk_TEST" &&
      [TIMESTAMP_HEADER, NONCE_HEADER, SIGNATURE_HEADER].every((h) => !!headers.get(h)),
  };
};
const caught = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e,
  );

describe("a missing payment is a typed 402 with its stage, dates and the portal page that clears it", () => {
  it("reads the reminder and the suspension from details, sent once each", async () => {
    const net = fake(
      paymentRequired(details()),
      paymentRequired(
        details({
          stage: "suspended",
          cause: "invoice_overdue",
          since: "2026-11-23T00:05:00+00:00",
          action: {
            kind: "pay_invoice",
            portal_path: `/billing/invoices/${INVOICE}`,
            amount_usd: "184.200001",
            invoice_id: INVOICE,
          },
        }),
      ),
    );
    const c = client(net);
    const reminder = await caught(
      c.terminals.create({ brokerId: BROKER, serverId: SERVER, idempotencyKey: "t-1" }),
    );
    expect(reminder).toBeInstanceOf(BillingPaymentRequiredError);
    expect(reminder).toBeInstanceOf(PaymentRequiredError);
    expect(reminder).toBeInstanceOf(MfxApiError);
    const r = reminder as BillingPaymentRequiredError;
    expect([r.name, r.code, r.status, r.message]).toEqual([
      "BillingPaymentRequiredError",
      "billing_payment_required",
      402,
      WORDS,
    ]);
    expect([r.tenantId, r.billingProfileId, r.stage, r.billingCause]).toEqual([
      TENANT,
      PROFILE,
      "reminder",
      "balance_used_up",
    ]);
    expect(r.since?.toISOString()).toBe("2026-11-20T00:05:00.000Z");
    expect(r.suspendsAt?.toISOString()).toBe("2026-11-23T00:05:00.000Z");
    expect(r.payBy?.toISOString()).toBe("2026-11-23T00:04:59.000Z");
    expect(r.action).toEqual({
      kind: "top_up",
      portalPath: "/billing/top-up",
      amountUsd: "10.00",
      invoiceId: null,
    });
    expect(net.calls).toHaveLength(1);

    const s = (await caught(
      c.risk.archivePolicy(POLICY, { idempotencyKey: "a-1" }),
    )) as BillingPaymentRequiredError;
    expect(s).toBeInstanceOf(BillingPaymentRequiredError);
    expect([s.stage, s.billingCause]).toEqual(["suspended", "invoice_overdue"]);
    expect(s.since?.toISOString()).toBe("2026-11-23T00:05:00.000Z");
    expect(s.action).toEqual({
      kind: "pay_invoice",
      portalPath: `/billing/invoices/${INVOICE}`,
      amountUsd: "184.200001",
      invoiceId: INVOICE,
    });
    expect(net.calls).toHaveLength(2);
  });

  it("reads what it cannot read as null, and a 402 it does not know by its status", () => {
    const of = (d: unknown) =>
      errorFor("billing_payment_required", WORDS, 402, d as Record<string, unknown>);
    const seen = [
      of(details({ action: { kind: "top_up", portal_path: "/billing/top-up" }, since: "soon" })),
      of(details({ action: { kind: "top_up", portal_path: "/x", amount_usd: "lots" } })),
      of(details({ action: { kind: "top_up", portal_path: "/x", amount_usd: "NaN" } })),
      of(details({ action: { kind: "top_up", portal_path: "/x", amount_usd: 10.5 } })),
      of(details({ action: { kind: "top_up" } })),
      of(details({ action: "top up" })),
      of(details({ action: ["top_up"] })),
      of({}),
    ] as BillingPaymentRequiredError[];
    expect(seen[0]?.since).toBeNull();
    expect(seen[0]?.action).toMatchObject({ kind: "top_up", amountUsd: null, invoiceId: null });
    for (const n of [1, 2, 3]) expect(seen[n]?.action?.amountUsd).toBeNull();
    for (const n of [4, 5, 6]) expect(seen[n]?.action).toBeNull();
    const bare = seen[7];
    expect([bare?.tenantId, bare?.billingProfileId, bare?.stage, bare?.billingCause]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect([bare?.since, bare?.suspendsAt, bare?.payBy, bare?.action]).toEqual([
      null,
      null,
      null,
      null,
    ]);

    const byStatus = errorFor("payment_failed", "the card was declined", 402);
    expect(byStatus.constructor).toBe(PaymentRequiredError);
    expect([byStatus.name, byStatus.code, byStatus.status]).toEqual([
      "PaymentRequiredError",
      "payment_failed",
      402,
    ]);
    expect(errorFor("billing_payment_required", "m", 403)).toBeInstanceOf(
      BillingPaymentRequiredError,
    );
  });
});

describe("an order refused for billing comes back refused, and reads keep working", () => {
  it("returns the refusal and reads on", async () => {
    const net = fake(
      paymentRequired(details({ stage: "suspended" })),
      ok({ id: TERMINAL, state: "ACTIVE" }),
      ok({ standing: { stage: "suspended", cause: "invoice_overdue" }, profiles: [] }),
    );
    const c = client(net);
    const result = await c.execution.placeOrder(TERMINAL, {
      symbol: "EURUSD.sd",
      side: "buy",
      volume: "0.10",
      idempotencyKey: "order-1",
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "refused",
      retryable: false,
      idempotencyKey: "order-1",
      final: true,
    });
    expect(result.detail).toContain(WORDS);
    expect(net.calls).toHaveLength(1);

    const terminal = await c.terminals.get(TERMINAL);
    expect(terminal.state).toBe("ACTIVE");
    const summary = await c.billing.summary();
    expect(summary.standing.stage).toBe("suspended");
    expect(net.calls).toHaveLength(3);
  });
});

describe("each billing read is its own signed route, the price list included", () => {
  it("reads each route, signed", async () => {
    const net = fake(
      ok({ version: "2026-11", plans: [] }),
      ok({ standing: { stage: "ok" }, profiles: [{ id: PROFILE, balance_usd: "9.500000" }] }),
      ok({ id: PROFILE, daily_usd: "1.716667" }),
      ok({ billing_profile_id: PROFILE, month: "2026-10" }),
      ok({ billing_profile_id: PROFILE }),
      ok({ version: "2026-11", scope: "tenant" }),
      ok({ invoice: { id: INVOICE, total_usd: "184.20" } }),
      json(404, { error: { code: "not_found", message: "no such profile" } }),
    );
    const c = client(net);
    expect(c.billing).toBeInstanceOf(Billing);

    const listed = await c.billing.priceList();
    expect(sent(net)).toMatchObject({ method: "GET", path: "/v1/price-list", query: [] });
    expect(listed.version).toBe("2026-11");

    const summary = await c.billing.summary();
    expect(sent(net).path).toBe("/v1/billing");
    expect(summary.profiles[0]?.balance_usd).toBe("9.500000");

    const profile = await c.billing.profile(PROFILE);
    expect(sent(net).path).toBe(`/v1/billing/profiles/${PROFILE}`);
    expect(profile.daily_usd).toBe("1.716667");

    await c.billing.forecast(PROFILE, { month: "2026-10" });
    expect(sent(net)).toMatchObject({
      path: `/v1/billing/profiles/${PROFILE}/forecast`,
      query: [["month", "2026-10"]],
    });
    const forecast = await c.billing.forecast(PROFILE);
    expect(sent(net).query).toEqual([]);
    expect(forecast.billing_profile_id).toBe(PROFILE);

    await c.billing.prices();
    expect(sent(net).path).toBe("/v1/billing/prices");

    const invoice = await c.billing.invoice(INVOICE);
    expect(sent(net).path).toBe(`/v1/billing/invoices/${INVOICE}`);
    expect(invoice.invoice.total_usd).toBe("184.20");

    expect(net.calls).toHaveLength(7);
    for (let i = 0; i < 7; i++) expect(sent(net, i)).toMatchObject({ method: "GET", signed: true });

    await expect(c.billing.profile("default")).rejects.toThrow(RangeError);
    await expect(c.billing.invoice("INV-1")).rejects.toThrow(RangeError);
    await expect(c.billing.forecast("x")).rejects.toThrow(RangeError);
    expect(net.calls).toHaveLength(7);

    await expect(c.billing.profile(PROFILE)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("invoices page by cursor, and the walk follows it to the last page", () => {
  it("reads one page with its filters, and walks every page", async () => {
    const pageOf = (cursor: string | null, numbers: string[]) =>
      ok({
        items: numbers.map((number) => ({ number, total_usd: "184.20" })),
        next_cursor: cursor,
        returned: numbers.length,
      });
    const net = fake(
      pageOf("c2", ["INV-2026-1104"]),
      pageOf("c2", ["INV-1"]),
      pageOf("c3", ["INV-2"]),
      pageOf(null, ["INV-3"]),
    );
    const c = client(net);
    const page = await c.billing.invoicesPage({
      billingProfileId: PROFILE.toUpperCase(),
      state: ["due", "overdue"],
      cursor: "c1",
      limit: 200,
    });
    expect(sent(net)).toMatchObject({
      method: "GET",
      path: "/v1/billing/invoices",
      signed: true,
      query: [
        ["billing_profile_id", PROFILE],
        ["state", "due,overdue"],
        ["cursor", "c1"],
        ["limit", "200"],
      ],
    });
    expect(page.next_cursor).toBe("c2");
    expect(page.items[0]?.total_usd).toBe("184.20");

    const walked: string[] = [];
    for await (const invoice of c.billing.invoices({ state: "overdue", limit: 1 })) {
      walked.push(invoice.number);
    }
    expect(walked).toEqual(["INV-1", "INV-2", "INV-3"]);
    const queries = [1, 2, 3].map((i) => new Map(sent(net, i).query));
    expect(queries.map((q) => q.get("cursor"))).toEqual([undefined, "c2", "c3"]);
    for (const q of queries) {
      expect([q.get("state"), q.get("limit")]).toEqual(["overdue", "1"]);
    }

    const count = net.calls.length;
    await expect(c.billing.invoicesPage({ state: "paid" as never })).rejects.toThrow(/paid/);
    await expect(c.billing.invoicesPage({ state: [] })).rejects.toThrow(RangeError);
    await expect(c.billing.invoicesPage({ billingProfileId: "default" })).rejects.toThrow(
      RangeError,
    );
    await expect(c.billing.invoicesPage({ limit: 201 })).rejects.toThrow(RangeError);
    expect(net.calls).toHaveLength(count);
  });
});
