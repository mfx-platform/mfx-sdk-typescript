// The Service Agreement: each plan has its own, and a plan change waits for the new plan's to be
// accepted. While one is due, every answer carries `MFX-Service-Agreement: due`; once it holds,
// adding a terminal, attaching an expert advisor, generating or replacing a key and asking for
// higher limits are refused 409 `service_agreement_not_accepted`. The Terms of Service and the
// MetaTrader 5 licence hold additions the same way with 409 `terms_not_accepted`. Nothing running
// is ever refused, and `client.tenant.serviceAgreement()` says what is due.

import { describe, afterEach, expect, it, vi } from "vitest";

import {
  ConflictError,
  KEY_HEADER,
  MfxApiError,
  MfxClient,
  NONCE_HEADER,
  SERVICE_AGREEMENT_HEADER,
  SIGNATURE_HEADER,
  ServiceAgreementNotAcceptedError,
  TIMESTAMP_HEADER,
  Tenant,
  TermsNotAcceptedError,
  errorFor,
} from "../../src/index.js";
import { BASE, SEED, fake, json } from "./net.js";

const CHANGE = "5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const BROKER = "0191f0c2-cccc-7ddd-8eee-000000000001";
const SERVER = "0191f0c2-dddd-7eee-8fff-000000000001";
const ACCEPT = "https://portal.mfxhub.com/organisation/legal";
const WORDS =
  "Your organisation is moving to Enterprise: an owner or admin accepts the Enterprise Service Agreement first.";
const TERMS_WORDS =
  "A Terms of Service version your organisation must accept is past its grace period.";

/** `details` of a 409 `service_agreement_not_accepted`, as section 7 of the legal design writes it. */
const SA_DETAILS = {
  plan_change: {
    id: CHANGE,
    from: "standard",
    to: "enterprise",
    state: "awaiting_acceptance",
    requested_at: "2026-11-17T09:00:00Z",
    until: "2026-12-01T09:00:00Z",
    requested_by_operator: true,
  },
  documents: [
    {
      document: "service_agreement_enterprise",
      number: 1,
      plan: "enterprise",
      grace_ends_at: null,
    },
    { document: "terms", number: 4, plan: null, grace_ends_at: "2026-11-10T00:00:00Z" },
  ],
  accept_url: ACCEPT,
};
const TERMS_DETAILS = {
  documents: [
    { document: "terms", number: 4, grace_ends_at: "2026-11-10T00:00:00Z" },
    { document: "mt5_licence", number: 2, grace_ends_at: "2026-11-12T00:00:00+00:00" },
  ],
};
const refused = (code: string, message: string, details: unknown) =>
  json(409, { error: { code, message, details } });
const DUE = { [SERVICE_AGREEMENT_HEADER]: "due" };

const client = (net: ReturnType<typeof fake>) =>
  new MfxClient(BASE, "mfxk_TEST", SEED, { fetch: net.fetch, sleep: () => Promise.resolve() });
const caught = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e,
  );
const newTerminal = (c: MfxClient, key = "t-1") =>
  c.terminals.create({ brokerId: BROKER, serverId: SERVER, idempotencyKey: key });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an addition held for a Service Agreement is a typed 409 with the plan change, the documents due and where to accept", () => {
  it("reads the plan change, the documents and the accept address from details", async () => {
    const net = fake(refused("service_agreement_not_accepted", WORDS, SA_DETAILS));
    const error = await caught(newTerminal(client(net)));
    expect(error).toBeInstanceOf(ServiceAgreementNotAcceptedError);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).toBeInstanceOf(MfxApiError);
    const e = error as ServiceAgreementNotAcceptedError;
    expect([e.name, e.code, e.status, e.message]).toEqual([
      "ServiceAgreementNotAcceptedError",
      "service_agreement_not_accepted",
      409,
      WORDS,
    ]);
    expect(e.planChange).toEqual({
      id: CHANGE,
      from: "standard",
      to: "enterprise",
      state: "awaiting_acceptance",
      requestedAt: new Date("2026-11-17T09:00:00Z"),
      until: new Date("2026-12-01T09:00:00Z"),
      requestedByOperator: true,
    });
    expect(e.documents).toEqual([
      {
        document: "service_agreement_enterprise",
        number: 1,
        plan: "enterprise",
        graceEndsAt: null,
      },
      { document: "terms", number: 4, plan: null, graceEndsAt: new Date("2026-11-10T00:00:00Z") },
    ]);
    expect(e.acceptUrl).toBe(ACCEPT);
    expect(net.calls).toHaveLength(1);
  });

  it("is the same class from the stream, by its code, whatever the status", () => {
    const e = errorFor("service_agreement_not_accepted", WORDS, 0, SA_DETAILS);
    expect(e).toBeInstanceOf(ServiceAgreementNotAcceptedError);
    expect((e as ServiceAgreementNotAcceptedError).acceptUrl).toBe(ACCEPT);
  });
});

describe("a Service Agreement refusal with no plan change, or details that cannot be read, never fails the SDK", () => {
  it("reads a refusal with no plan change", () => {
    const e = errorFor("service_agreement_not_accepted", WORDS, 409, {
      plan_change: null,
      documents: [
        {
          document: "service_agreement_standard",
          number: 2,
          plan: "standard",
          grace_ends_at: "2026-11-15T00:00:00Z",
        },
      ],
      accept_url: ACCEPT,
    }) as ServiceAgreementNotAcceptedError;
    expect(e.planChange).toBeNull();
    expect(e.documents).toEqual([
      {
        document: "service_agreement_standard",
        number: 2,
        plan: "standard",
        graceEndsAt: new Date("2026-11-15T00:00:00Z"),
      },
    ]);
  });

  it("reads missing and malformed details as null or empty", () => {
    const bare = errorFor(
      "service_agreement_not_accepted",
      WORDS,
      409,
    ) as ServiceAgreementNotAcceptedError;
    expect([bare.planChange, bare.documents, bare.acceptUrl]).toEqual([null, [], null]);

    const odd = errorFor("service_agreement_not_accepted", WORDS, 409, {
      plan_change: "awaiting",
      documents: "terms",
      accept_url: 7,
    }) as ServiceAgreementNotAcceptedError;
    expect([odd.planChange, odd.documents, odd.acceptUrl]).toEqual([null, [], null]);

    const partial = errorFor("service_agreement_not_accepted", WORDS, 409, {
      plan_change: { id: CHANGE, from: "standard", to: 3, state: "active" },
      documents: [
        null,
        "terms",
        { number: 1 },
        { document: "service_agreement_developer", number: "x", plan: 5, grace_ends_at: "soon" },
      ],
    }) as ServiceAgreementNotAcceptedError;
    expect(partial.planChange).toBeNull();
    expect(partial.documents).toEqual([
      { document: "service_agreement_developer", number: null, plan: null, graceEndsAt: null },
    ]);

    const loose = errorFor("service_agreement_not_accepted", WORDS, 409, {
      plan_change: { id: CHANGE, from: "enterprise", to: "standard", state: "lapsed" },
    }) as ServiceAgreementNotAcceptedError;
    expect(loose.planChange).toEqual({
      id: CHANGE,
      from: "enterprise",
      to: "standard",
      state: "lapsed",
      requestedAt: null,
      until: null,
      requestedByOperator: null,
    });
  });
});

describe("an addition held for the Terms of Service or the MetaTrader 5 licence is a typed 409 naming each document", () => {
  it("reads each document due from details", async () => {
    const net = fake(refused("terms_not_accepted", TERMS_WORDS, TERMS_DETAILS));
    const error = await caught(newTerminal(client(net)));
    expect(error).toBeInstanceOf(TermsNotAcceptedError);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error).not.toBeInstanceOf(ServiceAgreementNotAcceptedError);
    const e = error as TermsNotAcceptedError;
    expect([e.name, e.code, e.status, e.message]).toEqual([
      "TermsNotAcceptedError",
      "terms_not_accepted",
      409,
      TERMS_WORDS,
    ]);
    expect(e.documents).toEqual([
      { document: "terms", number: 4, plan: null, graceEndsAt: new Date("2026-11-10T00:00:00Z") },
      {
        document: "mt5_licence",
        number: 2,
        plan: null,
        graceEndsAt: new Date("2026-11-12T00:00:00Z"),
      },
    ]);
    expect(net.calls).toHaveLength(1);
  });

  it("reads missing or malformed documents as an empty list", () => {
    expect((errorFor("terms_not_accepted", "m", 409) as TermsNotAcceptedError).documents).toEqual(
      [],
    );
    expect(
      (errorFor("terms_not_accepted", "m", 409, { documents: {} }) as TermsNotAcceptedError)
        .documents,
    ).toEqual([]);
  });
});

describe("client.tenant.serviceAgreement() reads what the organisation must still accept", () => {
  it("sends one signed read and answers the platform's body", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const body = {
      due: true,
      held: true,
      plan: "standard",
      plan_change: SA_DETAILS.plan_change,
      documents: [
        {
          document: "service_agreement_enterprise",
          number: 1,
          plan: "enterprise",
          grace_ends_at: null,
          held: true,
        },
      ],
      accept_url: ACCEPT,
    };
    const net = fake(json(200, body, DUE));
    const c = client(net);
    expect(c.tenant).toBeInstanceOf(Tenant);
    expect(await c.tenant.serviceAgreement()).toEqual(body);
    const call = net.calls[0];
    if (call === undefined) throw new Error("no call");
    const headers = new Headers(call.init.headers);
    expect([call.init.method, call.url.pathname]).toEqual(["GET", "/v1/tenant/service-agreement"]);
    expect(
      headers.get(KEY_HEADER) === "mfxk_TEST" &&
        [TIMESTAMP_HEADER, NONCE_HEADER, SIGNATURE_HEADER].every((h) => !!headers.get(h)),
    ).toBe(true);
  });
});

describe("the first MFX-Service-Agreement: due a client sees logs one warning, and that client never warns again", () => {
  it("warns once per client, on a success or a refusal alike", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const net = fake(
      json(200, {}),
      json(200, {}, { [SERVICE_AGREEMENT_HEADER]: "none" }),
      json(200, {}, DUE),
      json(200, {}, DUE),
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: "service_agreement_not_accepted",
              message: WORDS,
              details: SA_DETAILS,
            },
          }),
          {
            status: 409,
            headers: { "content-type": "application/json", "mfx-service-agreement": "due" },
          },
        ),
      refused("service_agreement_not_accepted", WORDS, SA_DETAILS),
    );
    const first = client(net);
    await first.read({ method: "GET", path: "/a" });
    await first.read({ method: "GET", path: "/a" });
    expect(warn).not.toHaveBeenCalled();
    await first.read({ method: "GET", path: "/a" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("client.tenant.serviceAgreement()");
    await first.read({ method: "GET", path: "/a" });
    await caught(newTerminal(first));
    expect(warn).toHaveBeenCalledTimes(1);

    const quiet = client(fake(refused("terms_not_accepted", TERMS_WORDS, TERMS_DETAILS)));
    const secondNet = fake(
      () =>
        new Response(
          JSON.stringify({
            error: { code: "terms_not_accepted", message: TERMS_WORDS, details: TERMS_DETAILS },
          }),
          { status: 409, headers: { "content-type": "application/json", ...DUE } },
        ),
    );
    const other = client(secondNet);
    expect(await caught(newTerminal(other))).toBeInstanceOf(TermsNotAcceptedError);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(await caught(newTerminal(quiet))).toBeInstanceOf(TermsNotAcceptedError);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("a warning that cannot be written never fails the call that carried the header", () => {
  it("swallows a failing console", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("no console");
    });
    const c = client(fake(json(200, { ok: 1 }, DUE), json(200, { ok: 2 }, DUE)));
    expect(await c.read({ method: "GET", path: "/a" })).toEqual({ ok: 1 });
    expect(await c.read({ method: "GET", path: "/a" })).toEqual({ ok: 2 });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
