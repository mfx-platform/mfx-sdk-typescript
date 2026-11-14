import { describe, expect, it } from "vitest";

import {
  ForbiddenError,
  MfxClient,
  RiskOverrideRequiredError,
  RiskRefusedError,
  ValidationError,
  errorFor,
} from "../../src/index.js";
import { wire } from "../../src/risk.js";
import { BASE, SEED, fake, json } from "./net.js";

const ID = "4c2d3e4f-5a6b-7c8d-9e0f-102030405060";
const ACCOUNT = "5c2d3e4f-5a6b-7c8d-9e0f-102030405060";
const client = (net: ReturnType<typeof fake>) =>
  new MfxClient(BASE, "mfxk_TEST", SEED, { fetch: net.fetch, sleep: () => Promise.resolve() });
const ok = (body: unknown = {}) => json(200, body);
const page = (items: unknown[], next: string | null, extra: object = {}) =>
  json(200, { items, next_cursor: next, returned: items.length, ...extra });
const sent = (net: ReturnType<typeof fake>, i = -1) => {
  const call = net.calls.at(i);
  if (call === undefined) throw new Error("no call");
  return {
    method: call.init.method,
    path: call.url.pathname,
    query: [...call.url.searchParams.entries()],
    key: new Headers(call.init.headers).get("Idempotency-Key"),
    body:
      call.init.body === undefined
        ? undefined
        : (JSON.parse(Buffer.from(call.init.body as Uint8Array).toString()) as unknown),
  };
};
const rules = {
  daily_loss: {
    limit: { pct: "5" },
    basis: "start_balance",
    warn_at: { pct: "4" },
    act_at: { pct: "5" },
    check_entries: true,
    actions: { kinds: ["notify", "block_entries"] },
  },
} as never;
const order = { symbol: "EURUSD", side: "buy", type: "market", volume: "0.40" } as const;

describe("a policy is created, versioned, put in force and read, each write with its key", () => {
  it("sends each write to its route", async () => {
    const net = fake(
      ok({ id: ID }),
      ok({ version: 2 }),
      ok({ results: [] }),
      ok(),
      ok(),
      page([{ id: ID }], "c2"),
      page([{ id: ACCOUNT }], null),
      page([{ version: 1 }], null),
      ok(),
      ok({ results: [] }),
    );
    const c = client(net);
    await c.risk.createPolicy("Funded", rules, {
      reset: { zone: "broker" },
      idempotencyKey: "p-1",
    });
    expect(sent(net)).toMatchObject({ method: "POST", path: "/v1/risk/policies", key: "p-1" });
    expect(sent(net).body).toEqual({ name: "Funded", rules, reset: { zone: "broker" } });
    await c.risk.addPolicyVersion(ID, rules, {
      reset: { zone: "UTC" },
      reason: "desk asked",
      idempotencyKey: "v-2",
    });
    expect(sent(net)).toMatchObject({ path: `/v1/risk/policies/${ID}/versions` });
    expect((sent(net).body as { reason: string }).reason).toBe("desk asked");
    await c.risk.activate(ID, [ACCOUNT], { version: 2, idempotencyKey: "a-1" });
    expect(sent(net).body).toEqual({ account_ids: [ACCOUNT], version: 2 });
    await c.risk.policy(ID);
    await c.risk.policyVersion(ID, 1);
    expect(sent(net).path).toBe(`/v1/risk/policies/${ID}/versions/1`);
    const listed = [];
    for await (const p of c.risk.policies({ state: "active", sort: "oldest" })) listed.push(p);
    expect(listed).toHaveLength(2);
    expect(sent(net, -2).query).toEqual([
      ["state", "active"],
      ["sort", "oldest"],
    ]);
    expect(sent(net).query).toContainEqual(["cursor", "c2"]);
    const versions = [];
    for await (const v of c.risk.policyVersions(ID)) versions.push(v);
    expect(versions).toHaveLength(1);
    await c.risk.addPolicyVersion(ID, rules, { reset: { zone: "UTC" }, idempotencyKey: "v-3" });
    expect(sent(net).body).not.toHaveProperty("reason");
    await c.risk.activate(ID, [ACCOUNT], { version: 1, reason: "why", idempotencyKey: "a-2" });
    expect(sent(net).body).toMatchObject({ reason: "why" });
    await expect(c.risk.activate(ID, [], { version: 0, idempotencyKey: "a-3" })).rejects.toThrow(
      RangeError,
    );
  });
});

describe("accounts are listed with several values per filter and read, and overrides carry a reason", () => {
  it("reads and overrides", async () => {
    const net = fake(
      page([], "n1", { stats: { warnings: 2 } }),
      page([{ account_id: ACCOUNT }], "n2"),
      page([{ account_id: ID }], null),
      ok(),
      ok(),
      ok({ count: 1 }),
      ok(),
      ok(),
      ok(),
    );
    const c = client(net);
    const shown = await c.risk.accountsPage({
      coverage: ["healthy", "degraded"],
      restriction: "entries_blocked",
      sort: "plans",
    });
    expect(shown.stats).toEqual({ warnings: 2 });
    expect(sent(net).query).toEqual([
      ["coverage", "healthy"],
      ["coverage", "degraded"],
      ["restriction", "entries_blocked"],
      ["sort", "plans"],
    ]);
    const all = [];
    for await (const a of c.risk.accounts({ coverage: [] })) all.push(a);
    expect(all).toHaveLength(2);
    expect(sent(net, -2).query).toEqual([]);
    await c.risk.account(ACCOUNT);
    await c.risk.equity(ACCOUNT, new Date("2026-11-01T00:00:00Z"));
    expect(sent(net).query).toEqual([["from", "2026-11-01T00:00:00.000Z"]]);
    expect((await c.risk.closeScope(ACCOUNT, "mfx_positions")).count).toBe(1);
    expect(sent(net).query).toEqual([["scope", "mfx_positions"]]);
    await c.risk.coverage();
    await c.risk.clear(ACCOUNT, "drawdown", { reason: "checked", idempotencyKey: "c-1" });
    expect(sent(net).body).toEqual({ rule: "drawdown", reason: "checked" });
    await c.risk.deactivate(ACCOUNT, { reason: "closing", idempotencyKey: "d-1" });
    expect(sent(net)).toMatchObject({ path: `/v1/risk/accounts/${ACCOUNT}/deactivate` });
    await expect(
      c.risk.clear(ACCOUNT, "drawdown", { reason: " ", idempotencyKey: "c-2" }),
    ).rejects.toThrow(TypeError);
    await expect(c.risk.accountsPage({ coverage: [""] as never })).rejects.toThrow(TypeError);
    expect(net.calls).toHaveLength(9);
  });
});

describe("the planner sends decimals as text, refuses a fractional number, and a refusal names its rule", () => {
  it("checks and refuses", async () => {
    const net = fake(ok({ verdict: "allow" }), ok({ verdict: "allow" }));
    const c = client(net);
    await c.risk.preview({
      account_id: ACCOUNT,
      symbol: "EURUSD",
      side: "buy",
      entry_type: "market",
      sl: "1.081",
      budget: { kind: "pct_of_equity", value: "0.5" },
    } as never);
    expect(sent(net).path).toBe("/v1/risk/planner/preview");
    await c.risk.check(ACCOUNT, { ...order, price: "1.084", sl: "1.081", tp: null });
    expect(sent(net).body).toEqual({
      account_id: ACCOUNT,
      order: { ...order, price: "1.084", sl: "1.081", tp: null },
    });
    await expect(c.risk.check(ACCOUNT, { ...order, volume: 0.4 } as never)).rejects.toThrow(
      TypeError,
    );
    expect(() => wire("b", { steps: [{ trigger: { value: 1.5 } }] })).toThrow(/steps\[0\]/);
    expect(wire("b", { n: 2, s: "x", z: null })).toEqual({ n: 2, s: "x", z: null });
    expect(net.calls).toHaveLength(2);

    const refused = errorFor("risk_refused", "refused", 422, {
      reason: "daily_loss_reached",
      rule: "daily_loss",
      policy_id: ID,
      version: 3,
      used: "240",
      limit: "300",
      would_be: "310",
    });
    expect(refused).toBeInstanceOf(RiskRefusedError);
    expect(refused).toBeInstanceOf(ValidationError);
    expect((refused as RiskRefusedError).refusal).toEqual({
      reason: "daily_loss_reached",
      rule: "daily_loss",
      policyId: ID,
      version: 3,
      challengeId: null,
      challengeVersion: null,
      used: "240",
      limit: "300",
      wouldBe: "310",
    });
    const byChallenge = errorFor("risk_refused", "x", 422, {
      policy_id: "",
      challenge_id: ID,
      challenge_version: "2",
      version: true,
      used: 5,
      limit: {},
    }) as RiskRefusedError;
    expect(byChallenge.refusal).toMatchObject({
      reason: "risk_refused",
      policyId: null,
      version: null,
      challengeVersion: 2,
      used: "5",
      limit: null,
    });
    expect(
      (errorFor("risk_refused", "x", 422, { version: "x" }) as RiskRefusedError).refusal.version,
    ).toBeNull();
    const override = errorFor("risk_override_required", "relaxes", 403);
    expect(override).toBeInstanceOf(RiskOverrideRequiredError);
    expect(override).toBeInstanceOf(ForbiddenError);
  });
});

describe("an exit plan is created, amended, paused, resumed, ended and listed with its stats", () => {
  it("manages a plan", async () => {
    const net = fake(
      ok({ id: ID }),
      ok({ id: ID }),
      ok(),
      ok(),
      ok(),
      ok(),
      ok({ items: [], next_cursor: null, stats: { plans: 0 } }),
      page([{ id: ID }], "p2"),
      page([{ id: ACCOUNT }], null),
      ok({ id: ID }),
      ok({ id: ID }),
    );
    const c = client(net);
    const steps = [
      {
        trigger: { kind: "r", value: "1" },
        action: { kind: "close_part", pct: "50" },
        held_by: "mfx",
      },
    ] as never;
    await c.risk.createPlan({ account_id: ACCOUNT, order, steps } as never, {
      idempotencyKey: "plan-1",
    });
    expect(sent(net)).toMatchObject({ path: "/v1/risk/plans", key: "plan-1" });
    expect((sent(net).body as { order: object }).order).toEqual(order);
    await c.risk.plan(ID);
    await c.risk.amendPlan(ID, steps, { reason: "wider", idempotencyKey: "am-1" });
    expect(sent(net).body).toMatchObject({ reason: "wider" });
    await c.risk.pausePlan(ID, { reason: "news", idempotencyKey: "pa-1" });
    await c.risk.resumePlan(ID, { idempotencyKey: "re-1" });
    await c.risk.endPlan(ID, { idempotencyKey: "en-1" });
    expect(sent(net)).toMatchObject({ method: "DELETE", path: `/v1/risk/plans/${ID}` });
    const shown = await c.risk.plansPage({
      accountId: [ACCOUNT, ID],
      state: ["armed", "managing"],
      sort: "oldest",
    });
    expect(shown.stats).toEqual({ plans: 0 });
    expect(sent(net).query).toEqual([
      ["account_id", ACCOUNT],
      ["account_id", ID],
      ["state", "armed"],
      ["state", "managing"],
      ["sort", "oldest"],
    ]);
    const all = [];
    for await (const p of c.risk.plans({ accountId: ACCOUNT })) all.push(p);
    expect(all).toHaveLength(2);
    await c.risk.amendPlan(ID, steps, { idempotencyKey: "am-2" });
    expect(sent(net).body).not.toHaveProperty("reason");
    await c.risk.createPlan({ account_id: ACCOUNT, ticket: "9001", steps } as never, {
      idempotencyKey: "plan-2",
    });
    expect(sent(net).body).not.toHaveProperty("order");
  });
});

describe("a challenge is created, versioned and enrolled, and its accounts and activity read by filter and sort", () => {
  it("reads a programme", async () => {
    const net = fake(
      ok({ id: ID }),
      ok({ id: ID }),
      ok({ results: [] }),
      ok(),
      page([{ id: ID }], null),
      ok({ items: [], next_cursor: null, stats: { accounts: 0 } }),
      page([{ account_id: ACCOUNT }], "k2"),
      page([{ account_id: ID }], null),
      ok({ periods: [] }),
      ok({ items: [], next_cursor: null, stats: { rows: 0 } }),
      page([{ id: ID }], "a2"),
      page([{ id: ACCOUNT }], null),
    );
    const c = client(net);
    const r = { min_trading_days: 2, profit_target: { pct: "8" } } as never;
    await c.risk.createChallenge("Phase 1", r, { idempotencyKey: "ch-1" });
    expect(sent(net).body).toEqual({ name: "Phase 1", rules: r });
    await c.risk.addChallengeVersion(ID, r, { idempotencyKey: "cv-1" });
    expect(sent(net).path).toBe(`/v1/risk/challenges/${ID}/versions`);
    await c.risk.enrol(ID, [ACCOUNT], { idempotencyKey: "en-1" });
    expect(sent(net).body).toEqual({ account_ids: [ACCOUNT] });
    await c.risk.challenge(ID);
    const challenges = [];
    for await (const x of c.risk.challenges()) challenges.push(x);
    expect(challenges).toHaveLength(1);
    await c.risk.challengeAccountsPage(ID, {
      state: ["in_progress", "passed"],
      rule: "daily_loss",
      belowMinDays: true,
      sort: "profit",
    });
    expect(sent(net).query).toEqual([
      ["state", "in_progress"],
      ["state", "passed"],
      ["rule", "daily_loss"],
      ["below_min_days", "true"],
      ["sort", "profit"],
    ]);
    const accounts = [];
    for await (const a of c.risk.challengeAccounts(ID, { sort: "profit" })) accounts.push(a);
    expect(accounts).toHaveLength(2);
    expect(sent(net).query).toEqual([
      ["cursor", "k2"],
      ["sort", "profit"],
    ]);
    await c.risk.challengeAccount(ID, ACCOUNT);
    expect(sent(net).path).toBe(`/v1/risk/challenges/${ID}/accounts/${ACCOUNT}`);
    await c.risk.activityPage({
      kind: "breach",
      accountId: ACCOUNT,
      outcome: ["unresolved", "failed"],
      from: new Date("2026-11-14T00:00:00Z"),
      to: new Date("2026-11-15T00:00:00Z"),
      sort: "newest",
    });
    expect(sent(net).query).toEqual([
      ["kind", "breach"],
      ["account_id", ACCOUNT],
      ["outcome", "unresolved"],
      ["outcome", "failed"],
      ["from", "2026-11-14T00:00:00.000Z"],
      ["to", "2026-11-15T00:00:00.000Z"],
      ["sort", "newest"],
    ]);
    const rows = [];
    for await (const x of c.risk.activity({ kind: ["breach"] })) rows.push(x);
    expect(rows).toHaveLength(2);
  });
});
