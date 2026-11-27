import { describe, expect, it } from "vitest";

import {
  ConflictError,
  Copy,
  CopyPage,
  COPY_EVENT_TYPES,
  MfxClient,
  REFUSAL_REASONS,
  StateError,
  StreamMessage,
  ValidationError,
  copyEventOf,
} from "../../src/index.js";
import type { components, CopyScaling } from "../../src/index.js";
import { BASE, SEED, error, fake, json } from "./net.js";

const ACCOUNT = "4c2d3e4f-5a6b-7c8d-9e0f-102030405060";
const FOLLOWER_ACCOUNT = "4c2d3e4f-5a6b-7c8d-9e0f-102030405061";
const LEADER = "06abfa00-0000-7000-8000-0000000000c1";
const FOLLOWER = "06abfa00-0000-7000-8000-0000000000f1";
const SECOND = "06abfa00-0000-7000-8000-0000000000f2";
const GROUP = "06abfa00-0000-7000-8000-0000000000e1";
const SIGNAL = "06abfa00-0000-7000-8000-0000000000d1";
const AT = "2026-11-13T09:00:00Z";

type Schemas = components["schemas"];

const leader = (state: Schemas["CopyLeaderState"] = "active"): Schemas["CopyLeader"] => ({
  id: LEADER,
  source: "account",
  account_id: ACCOUNT,
  venue: "mt5",
  filters: { side: "both" },
  copies: {
    entries: true,
    pending: true,
    sl: true,
    tp: true,
    modifications: true,
    partial_closes: true,
    close_only: false,
  },
  signal_lifetime_s: 30,
  limits: {},
  who_may_join: { accounts: "any" },
  state,
  followers_live: 0,
  created_at: AT,
  updated_at: AT,
});
const follower = (state: Schemas["CopyFollowerState"] = "copying"): Schemas["CopyFollower"] => ({
  id: FOLLOWER,
  account_id: FOLLOWER_ACCOUNT,
  venue: "ctrader",
  leader_id: LEADER,
  scaling: { mode: "fixed_multiplier", multiplier: "0.5" },
  bounds: {},
  symbol_map: {},
  options: {
    reverse: false,
    copy_sl: true,
    copy_tp: true,
    copy_pending: true,
    skip_pending: false,
    close_only: false,
    delay_ms: 0,
    when_risk_unchecked: "refuse",
  },
  risk_limits: { basis: "equity" },
  close_on_stopout: false,
  group_id: null,
  mandate_version: 1,
  state,
  stopouts: [],
  created_at: AT,
  updated_at: AT,
});
const group = (state: Schemas["CopyGroupState"] = "active"): Schemas["CopyGroup"] => ({
  id: GROUP,
  name: "Desk A",
  template: {},
  gross_exposure_cap: null,
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- the contract still returns it
  placement_policy: null,
  state,
  followers_live: 1,
  created_at: AT,
  updated_at: AT,
});
const accepted = (duplicate = false) => ({
  signal_id: SIGNAL,
  id: "s-1",
  leader_id: LEADER,
  duplicate,
  iat: AT,
  exp: AT,
});
const stats = { leaders: 2, active: 1, paused: 1, retired: 0 };
const logStats = {
  copies: 2,
  filled: 0,
  refused: 2,
  skipped: 0,
  stopout: 0,
  mfx_ms_p50: 11,
  mfx_ms_p99: 40,
  signal_to_order_ms_p50: 14,
  broker_ms_p50: null,
  mfx_ms_p95: 30,
  signal_to_order_ms_p95: 35,
  broker_ms_p95: null,
};
const row = (reason: Schemas["CopyReason"] | null) => ({
  id: "06abfa00-0000-7000-8000-0000000000a9",
  created_at: AT,
  signal_id: SIGNAL,
  leader_id: LEADER,
  follower_id: FOLLOWER,
  account_id: FOLLOWER_ACCOUNT,
  venue: "ctrader",
  action: "open",
  side: "buy",
  instrument_key: null,
  outcome: reason === null ? "filled" : "refused",
  reason,
  venue_code: null,
  command_id: null,
  copied_volume: null,
  price: null,
  slippage: null,
  stages: {},
  mfx_ms: 11,
  signal_to_order_ms: 14,
  deal: { action: "open", side: "buy", units: "100000", price: null, instrument_key: null },
  symbol: reason === null ? "EURUSD" : null,
  risk: null,
});
const page = (items: unknown[], next: string | null, extra: Record<string, unknown> = {}) =>
  json(200, { items, next_cursor: next, returned: items.length, ...extra });

const client = (net: ReturnType<typeof fake>) =>
  new MfxClient(BASE, "mfxk_TEST", SEED, { fetch: net.fetch, sleep: () => Promise.resolve() });

type Call = ReturnType<typeof fake>["calls"][number];
const sent = (call: Call | undefined): unknown =>
  call?.init.body === undefined
    ? undefined
    : JSON.parse(new TextDecoder().decode(call.init.body as Uint8Array));
const key = (call: Call | undefined) => new Headers(call?.init.headers).get("Idempotency-Key");
const route = (call: Call | undefined) => `${call?.init.method ?? ""} ${call?.url.pathname ?? ""}`;

describe("a leader is made, read, listed, changed, paused, resumed and retired with one key a write", () => {
  it("creates, reads, changes and retires a leader on the contract's routes", async () => {
    const net = fake(
      json(201, leader()),
      json(200, leader()),
      json(200, leader()),
      json(200, leader("paused")),
      json(200, leader()),
      json(200, leader("retired")),
    );
    const copy = client(net).copy;
    expect(copy).toBeInstanceOf(Copy);
    const made = await copy.createLeader({
      source: "account",
      accountId: ACCOUNT.toUpperCase(),
      signalLifetimeS: 30,
      filters: { symbols: ["EURUSD"], side: "buy" },
      limits: { max_risk_pct: "2.5" },
      whoMayJoin: { accounts: "listed", account_ids: [FOLLOWER_ACCOUNT] },
      idempotencyKey: "lead-1",
    });
    expect(made.state).toBe("active");
    expect(route(net.calls[0])).toBe("POST /v1/copy/leaders");
    expect(key(net.calls[0])).toBe("lead-1");
    expect(sent(net.calls[0])).toEqual({
      source: "account",
      account_id: ACCOUNT,
      signal_lifetime_s: 30,
      filters: { symbols: ["EURUSD"], side: "buy" },
      limits: { max_risk_pct: "2.5" },
      who_may_join: { accounts: "listed", account_ids: [FOLLOWER_ACCOUNT] },
    });
    await copy.getLeader(LEADER);
    expect(route(net.calls[1])).toBe(`GET /v1/copy/leaders/${LEADER}`);
    expect(key(net.calls[1])).toBeNull();
    await copy.updateLeader(LEADER, { signalLifetimeS: 60, idempotencyKey: "lead-2" });
    expect(route(net.calls[2])).toBe(`PATCH /v1/copy/leaders/${LEADER}`);
    expect(sent(net.calls[2])).toEqual({ signal_lifetime_s: 60 });
    expect((await copy.pauseLeader(LEADER, { idempotencyKey: "lead-3" })).state).toBe("paused");
    await copy.resumeLeader(LEADER, { idempotencyKey: "lead-4" });
    const retired = await copy.retireLeader(LEADER, {
      closeCopied: false,
      reason: "desk closed",
      idempotencyKey: "lead-5",
    });
    expect(retired.state).toBe("retired");
    expect(net.calls.slice(3).map(route)).toEqual([
      `POST /v1/copy/leaders/${LEADER}/pause`,
      `POST /v1/copy/leaders/${LEADER}/resume`,
      `POST /v1/copy/leaders/${LEADER}/retire`,
    ]);
    expect(sent(net.calls[3])).toBeUndefined();
    expect(net.calls.slice(2).map(key)).toEqual(["lead-2", "lead-3", "lead-4", "lead-5"]);
    expect(sent(net.calls[5])).toEqual({ close_copied: false, reason: "desk closed" });
  });

  it("lists leaders by state across pages and keeps the stats row", async () => {
    const net = fake(
      page([leader()], "c-2", { stats }),
      page([leader("paused")], null, { stats }),
      page([leader()], null, { stats }),
      page([], null),
      () => new Response(null, { status: 200 }),
    );
    const copy = client(net).copy;
    const ids: string[] = [];
    for await (const each of copy.leaders({ state: ["active", "paused"], limit: 1 })) {
      ids.push(each.id);
    }
    expect(ids).toEqual([LEADER, LEADER]);
    expect(net.calls[0]?.url.search).toBe("?limit=1&state=active%2Cpaused");
    expect(net.calls[1]?.url.searchParams.get("cursor")).toBe("c-2");
    const first = await copy.leadersPage({
      state: "active",
      source: "external",
      accountId: ACCOUNT,
    });
    expect(first).toBeInstanceOf(CopyPage);
    expect(first.stats).toEqual(stats);
    expect(Object.fromEntries(net.calls[2]?.url.searchParams ?? [])).toEqual({
      state: "active",
      source: "external",
      account_id: ACCOUNT,
    });
    expect((await copy.leadersPage()).stats).toBeNull();
    const empty = await copy.leadersPage();
    expect([empty.length, empty.stats, empty.nextCursor]).toEqual([0, null, null]);
  });

  it("throws ConflictError for a leader over the plan, and never retries the write", async () => {
    const net = fake(
      json(409, {
        error: {
          code: "quota_exceeded",
          message: "over the plan",
          details: { reason: "plan_limit", limit: "copy_leaders" },
        },
      }),
    );
    const failure: unknown = await client(net)
      .copy.createLeader({ source: "external", signalLifetimeS: 30, idempotencyKey: "lead-6" })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ConflictError);
    expect((failure as ConflictError).code).toBe("quota_exceeded");
    expect(net.calls).toHaveLength(1);
    expect(sent(net.calls[0])).toEqual({ source: "external", signal_lifetime_s: 30 });
  });

  it("refuses a source outside the contract before sending", async () => {
    const net = fake();
    const copy = client(net).copy;
    await expect(
      copy.createLeader({
        source: "everyone" as "account",
        signalLifetimeS: 30,
        idempotencyKey: "k",
      }),
    ).rejects.toThrow(RangeError);
    await expect(copy.leadersPage({ source: "everyone" as "account" })).rejects.toThrow(RangeError);
    await expect(copy.leadersPage({ state: [] })).rejects.toThrow(RangeError);
    await expect(copy.leadersPage({ state: "gone" as "active" })).rejects.toThrow(RangeError);
    expect(net.calls).toHaveLength(0);
  });
});

describe("an external leader sends an open and a close and a binary float is never sent", () => {
  it("posts an open and a close with the contract's names", async () => {
    const net = fake(json(202, accepted()), json(202, accepted()), json(202, accepted(true)));
    const copy = client(net).copy;
    const open = await copy.sendOpenSignal(LEADER, {
      id: "s-1",
      symbol: "EURUSD",
      side: "buy",
      volume: "1E+0",
      sl: "1.0800",
      tp: "1.1000",
      instrumentKey: "fx:EURUSD",
      time: new Date(AT),
      account: { balance: "10000", trades: 3 },
      idempotencyKey: "sig-1",
    });
    expect(open.signal_id).toBe(SIGNAL);
    expect(route(net.calls[0])).toBe(`POST /v1/copy/leaders/${LEADER}/signals`);
    expect(key(net.calls[0])).toBe("sig-1");
    expect(sent(net.calls[0])).toEqual({
      id: "s-1",
      symbol: "EURUSD",
      side: "buy",
      volume: "1",
      instrument_key: "fx:EURUSD",
      sl: "1.0800",
      tp: "1.1000",
      time: "2026-11-13T09:00:00.000Z",
      account: { balance: "10000", trades: 3 },
    });
    await copy.sendOpenSignal(LEADER, {
      id: "s-2",
      symbol: "CL-SPREAD",
      side: "sell",
      units: "100000",
      sl: "-1.25",
      tp: " -3.5E+0",
      idempotencyKey: "sig-2",
    });
    expect(sent(net.calls[1])).toEqual({
      id: "s-2",
      symbol: "CL-SPREAD",
      side: "sell",
      units: "100000",
      sl: "-1.25",
      tp: "-3.5",
    });
    const close = await copy.sendCloseSignal(LEADER, {
      id: "s-3",
      close: "s-1",
      idempotencyKey: "sig-3",
    });
    expect(close.duplicate).toBe(true);
    expect(sent(net.calls[2])).toEqual({ id: "s-3", close: "s-1" });
  });

  it("refuses both or neither of volume and units, a bad side and a number", async () => {
    const net = fake();
    const copy = client(net).copy;
    const base = { id: "x", symbol: "EURUSD", side: "buy" as const, idempotencyKey: "k" };
    await expect(copy.sendOpenSignal(LEADER, base)).rejects.toThrow(RangeError);
    await expect(copy.sendOpenSignal(LEADER, { ...base, volume: "1", units: "1" })).rejects.toThrow(
      RangeError,
    );
    await expect(
      copy.sendOpenSignal(LEADER, { ...base, side: "long" as "buy", volume: "1" }),
    ).rejects.toThrow(RangeError);
    await expect(
      copy.sendOpenSignal(LEADER, { ...base, volume: 0.1 as unknown as string }),
    ).rejects.toThrow(TypeError);
    await expect(copy.sendOpenSignal(LEADER, { ...base, volume: "-1" })).rejects.toThrow(
      /non-negative/,
    );
    await expect(copy.sendOpenSignal(LEADER, { ...base, units: "-100" })).rejects.toThrow(
      /non-negative/,
    );
    for (const stop of ["--1", "-", "1-", "-1e999"]) {
      await expect(copy.sendOpenSignal(LEADER, { ...base, volume: "1", sl: stop })).rejects.toThrow(
        RangeError,
      );
    }
    await expect(
      copy.sendOpenSignal(LEADER, { ...base, volume: "1", tp: -1.5 as unknown as string }),
    ).rejects.toThrow(TypeError);
    await expect(
      copy.createLeader({
        source: "external",
        signalLifetimeS: 30,
        limits: { max_risk_pct: 2.5 as unknown as string },
        idempotencyKey: "k",
      }),
    ).rejects.toThrow(/binary float/);
    await expect(
      copy.sendOpenSignal(LEADER, { ...base, volume: "1", time: new Date("nope") }),
    ).rejects.toThrow(TypeError);
    await expect(
      copy.sendCloseSignal(LEADER, { id: "y", close: "", idempotencyKey: "k" }),
    ).rejects.toThrow(TypeError);
    expect(net.calls).toHaveLength(0);
  });
});

describe("a follower is made, previewed, read, listed, changed, paused, resumed, resynced and unfollowed", () => {
  it("previews as a read with no key, retried after a 429", async () => {
    const preview = {
      account_id: FOLLOWER_ACCOUNT,
      venue: "ctrader",
      leader_id: LEADER,
      refusal: null,
      inputs: {},
      rows: [
        { follower_volume: "50000", reason: null },
        { follower_volume: null, reason: "mapping" },
      ],
    };
    const net = fake(error(429, "rate_limited", { "Retry-After": "0" }), json(200, preview));
    const scaling: CopyScaling = { mode: "equity_ratio" };
    const got = await client(net).copy.previewFollower({
      accountId: FOLLOWER_ACCOUNT,
      leaderId: LEADER,
      scaling,
      rows: [{ symbol: "EURUSD", volume: "1.00" }],
      bounds: { max_volume: "5" },
      symbolMap: { XAUUSD: "GOLD" },
      options: { reverse: false },
    });
    expect(got.rows.map((r) => r.reason)).toEqual([null, "mapping"]);
    expect(got.rows.map((r) => r.follower_volume)).toEqual(["50000", null]);
    expect(net.calls).toHaveLength(2);
    expect(route(net.calls[1])).toBe("POST /v1/copy/followers/preview");
    expect(key(net.calls[1])).toBeNull();
    expect(sent(net.calls[1])).toEqual({
      account_id: FOLLOWER_ACCOUNT,
      leader_id: LEADER,
      scaling: { mode: "equity_ratio" },
      rows: [{ symbol: "EURUSD", volume: "1.00" }],
      bounds: { max_volume: "5" },
      symbol_map: { XAUUSD: "GOLD" },
      options: { reverse: false },
    });
    const copy = client(fake()).copy;
    const ask = { accountId: FOLLOWER_ACCOUNT, leaderId: LEADER, scaling };
    await expect(copy.previewFollower({ ...ask, rows: [] })).rejects.toThrow(RangeError);
    await expect(copy.previewFollower({ ...ask, rows: "EURUSD" as unknown as [] })).rejects.toThrow(
      RangeError,
    );
    const many = Array.from({ length: 201 }, () => ({ symbol: "EURUSD", volume: "1" }));
    await expect(copy.previewFollower({ ...ask, rows: many })).rejects.toThrow(RangeError);
  });

  it("creates a follower with its mandate and throws ValidationError for the venue", async () => {
    const net = fake(
      json(201, follower()),
      json(422, {
        error: {
          code: "unprocessable",
          message: "an MT5 netting account cannot follow",
          details: { reason: "not_on_this_venue", options: ["margin_mode"] },
        },
      }),
    );
    const copy = client(net).copy;
    await copy.createFollower({
      accountId: FOLLOWER_ACCOUNT,
      leaderId: LEADER,
      scaling: { mode: "fixed_multiplier", multiplier: "0.5" },
      bounds: { min_volume: "0.01", max_volume: null, max_open: 5 },
      symbolMap: { US30: "DJ30.cash" },
      options: { delay_ms: 0, when_risk_unchecked: "copy" },
      riskLimits: { daily_pct: "3", basis: "equity" },
      closeOnStopout: true,
      groupId: GROUP,
      idempotencyKey: "fol-1",
    });
    expect(key(net.calls[0])).toBe("fol-1");
    expect(sent(net.calls[0])).toEqual({
      account_id: FOLLOWER_ACCOUNT,
      leader_id: LEADER,
      scaling: { mode: "fixed_multiplier", multiplier: "0.5" },
      bounds: { min_volume: "0.01", max_volume: null, max_open: 5 },
      symbol_map: { US30: "DJ30.cash" },
      options: { delay_ms: 0, when_risk_unchecked: "copy" },
      risk_limits: { daily_pct: "3", basis: "equity" },
      close_on_stopout: true,
      group_id: GROUP,
    });
    const failure: unknown = await copy
      .createFollower({
        accountId: FOLLOWER_ACCOUNT,
        leaderId: LEADER,
        scaling: { mode: "balance_ratio" },
        idempotencyKey: "fol-2",
      })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ValidationError);
    expect((failure as ValidationError).details).toMatchObject({
      reason: "not_on_this_venue",
      options: ["margin_mode"],
    });
    for (const word of ["ignore", null, true]) {
      await expect(
        copy.updateFollower(FOLLOWER, {
          options: { when_risk_unchecked: word as "copy" },
          idempotencyKey: "fol-3",
        }),
      ).rejects.toThrow(/when_risk_unchecked is refuse or copy/);
      await expect(
        copy.previewFollower({
          accountId: FOLLOWER_ACCOUNT,
          leaderId: LEADER,
          scaling: { mode: "equity_ratio" },
          rows: [{ symbol: "EURUSD", volume: "1" }],
          options: { when_risk_unchecked: word as "refuse" },
        }),
      ).rejects.toThrow(RangeError);
    }
    expect(net.calls).toHaveLength(2);
  });

  it("reads, lists, changes, pauses, resumes, resyncs and unfollows", async () => {
    const net = fake(
      json(200, follower()),
      page([follower()], "c-2", { stats: { followers: 2 } }),
      page([follower()], null, { stats: { followers: 2 } }),
      json(200, follower()),
      json(200, follower("paused")),
      json(200, follower()),
      json(202, follower()),
      json(200, follower("unfollowed")),
    );
    const copy = client(net).copy;
    await copy.getFollower(FOLLOWER);
    expect(route(net.calls[0])).toBe(`GET /v1/copy/followers/${FOLLOWER}`);
    const ids: string[] = [];
    for await (const each of copy.followers({
      state: "copying",
      leaderId: LEADER,
      accountId: FOLLOWER_ACCOUNT,
      groupId: GROUP,
    })) {
      ids.push(each.id);
    }
    expect(ids).toHaveLength(2);
    expect(Object.fromEntries(net.calls[1]?.url.searchParams ?? [])).toEqual({
      state: "copying",
      leader_id: LEADER,
      account_id: FOLLOWER_ACCOUNT,
      group_id: GROUP,
    });
    expect(net.calls[2]?.url.searchParams.get("cursor")).toBe("c-2");
    await copy.updateFollower(FOLLOWER, {
      scaling: { mode: "fixed_volume", volume: "0.10" },
      idempotencyKey: "fol-3",
    });
    expect(route(net.calls[3])).toBe(`PATCH /v1/copy/followers/${FOLLOWER}`);
    expect(sent(net.calls[3])).toEqual({ scaling: { mode: "fixed_volume", volume: "0.10" } });
    await copy.pauseFollower(FOLLOWER, { idempotencyKey: "fol-4" });
    await copy.resumeFollower(FOLLOWER, { idempotencyKey: "fol-5" });
    await copy.resyncFollower(FOLLOWER, { idempotencyKey: "fol-6" });
    const gone = await copy.unfollow(FOLLOWER, { closeCopied: true, idempotencyKey: "fol-7" });
    expect(gone.state).toBe("unfollowed");
    expect(net.calls.slice(4).map(route)).toEqual([
      `POST /v1/copy/followers/${FOLLOWER}/pause`,
      `POST /v1/copy/followers/${FOLLOWER}/resume`,
      `POST /v1/copy/followers/${FOLLOWER}/resync`,
      `POST /v1/copy/followers/${FOLLOWER}/unfollow`,
    ]);
    expect(net.calls.slice(3).map(key)).toEqual(["fol-3", "fol-4", "fol-5", "fol-6", "fol-7"]);
    expect(sent(net.calls[7])).toEqual({ close_copied: true });
  });
});

describe("stop-outs are listed and reset, and a group's members are added, removed, paused and resumed", () => {
  it("lists and resets stop-outs", async () => {
    const stopout = { id: "s", state: "active" };
    const net = fake(
      page([stopout], "c-2"),
      page([{ ...stopout, state: "expired" }], null),
      json(200, follower()),
      json(409, {
        error: {
          code: "state_error",
          message: "none",
          details: { reason: "no_active_stopout" },
        },
      }),
    );
    const copy = client(net).copy;
    const states: string[] = [];
    for await (const s of copy.stopouts(FOLLOWER, { state: ["active", "expired"] })) {
      states.push(s.state);
    }
    expect(states).toEqual(["active", "expired"]);
    expect(route(net.calls[0])).toBe(`GET /v1/copy/followers/${FOLLOWER}/stopouts`);
    expect(net.calls[0]?.url.searchParams.get("state")).toBe("active,expired");
    await copy.resetStopouts(FOLLOWER, {
      reason: "limit raised",
      limit: "daily",
      idempotencyKey: "reset-1",
    });
    expect(route(net.calls[2])).toBe(`POST /v1/copy/followers/${FOLLOWER}/stopouts/reset`);
    expect(sent(net.calls[2])).toEqual({ reason: "limit raised", limit: "daily" });
    const failure: unknown = await copy
      .resetStopouts(FOLLOWER, { reason: "again", idempotencyKey: "reset-2" })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(StateError);
    expect(net.calls).toHaveLength(4);
  });

  it("creates, lists and changes a group and manages its members", async () => {
    const net = fake(
      json(201, group()),
      json(200, group()),
      page([group()], "c-2", { stats: { groups: 2 } }),
      page([group()], null, { stats: { groups: 2 } }),
      json(200, group()),
      json(200, group()),
      json(200, group()),
      json(200, {
        results: [
          { follower_id: FOLLOWER, outcome: "done", reason: null },
          { follower_id: SECOND, outcome: "refused", reason: "in_another_group" },
        ],
      }),
      json(200, { results: [{ follower_id: FOLLOWER, outcome: "done", reason: null }] }),
      json(200, group("paused")),
      json(200, group()),
    );
    const copy = client(net).copy;
    await copy.createGroup({
      name: "Desk A",
      template: {
        scaling: { mode: "fixed_multiplier", multiplier: "1" },
        options: { when_risk_unchecked: "refuse" },
      },
      grossExposureCap: "250000",
      placementPolicy: "same_region",
      idempotencyKey: "grp-1",
    });
    expect(sent(net.calls[0])).toEqual({
      name: "Desk A",
      template: {
        scaling: { mode: "fixed_multiplier", multiplier: "1" },
        options: { when_risk_unchecked: "refuse" },
      },
      gross_exposure_cap: "250000",
      placement_policy: "same_region",
    });
    await copy.getGroup(GROUP);
    let count = 0;
    for await (const g of copy.groups({ state: "active" })) count += g.followers_live;
    expect(count).toBe(2);
    expect(net.calls[2]?.url.searchParams.get("state")).toBe("active");
    await copy.updateGroup(GROUP, {
      name: "Desk B",
      grossExposureCap: null,
      idempotencyKey: "g2",
    });
    expect(sent(net.calls[4])).toEqual({ name: "Desk B", gross_exposure_cap: null });
    await copy.updateGroup(GROUP, {
      grossExposureCap: "1000",
      placementPolicy: null,
      idempotencyKey: "g3",
    });
    expect(sent(net.calls[5])).toEqual({ gross_exposure_cap: "1000", placement_policy: null });
    await copy.updateGroup(GROUP, { template: {}, idempotencyKey: "g4" });
    expect(sent(net.calls[6])).toEqual({ template: {} });
    const added = await copy.addGroupFollowers(GROUP, [FOLLOWER, SECOND], {
      idempotencyKey: "g5",
    });
    expect(added.results.map((r) => r.outcome)).toEqual(["done", "refused"]);
    expect(route(net.calls[7])).toBe(`POST /v1/copy/groups/${GROUP}/followers`);
    expect(sent(net.calls[7])).toEqual({ follower_ids: [FOLLOWER, SECOND] });
    await copy.removeGroupFollowers(GROUP, [FOLLOWER], { idempotencyKey: "g6" });
    expect(route(net.calls[8])).toBe(`POST /v1/copy/groups/${GROUP}/followers/remove`);
    await copy.pauseGroup(GROUP, { idempotencyKey: "g7" });
    await copy.resumeGroup(GROUP, { idempotencyKey: "g8" });
    expect(net.calls.map(key)).toEqual([
      "grp-1",
      null,
      null,
      null,
      "g2",
      "g3",
      "g4",
      "g5",
      "g6",
      "g7",
      "g8",
    ]);
    const none = client(fake()).copy;
    await expect(
      none.updateGroup(GROUP, {
        template: { options: { when_risk_unchecked: "maybe" as "copy" } },
        idempotencyKey: "k",
      }),
    ).rejects.toThrow(/template.options.when_risk_unchecked is refuse or copy/);
    await expect(none.addGroupFollowers(GROUP, [], { idempotencyKey: "k" })).rejects.toThrow(
      RangeError,
    );
    await expect(
      none.addGroupFollowers(GROUP, FOLLOWER as unknown as string[], { idempotencyKey: "k" }),
    ).rejects.toThrow(RangeError);
    await expect(
      none.removeGroupFollowers(GROUP, Array<string>(501).fill(FOLLOWER), {
        idempotencyKey: "k",
      }),
    ).rejects.toThrow(RangeError);
  });
});

describe("the copy log sends its filters comma-joined and its window and keeps the stats row", () => {
  it("sends the filters and window and walks the pages", async () => {
    const net = fake(
      page([row("mapping"), row("min_volume")], "c-2", { stats: logStats }),
      page([row(null)], null, { stats: logStats }),
      page([row("broker")], null, { stats: logStats }),
    );
    const copy = client(net).copy;
    const reasons: (string | null)[] = [];
    for await (const each of copy.log({
      leaderId: LEADER,
      followerId: FOLLOWER,
      accountId: FOLLOWER_ACCOUNT,
      signalId: SIGNAL,
      outcome: ["refused", "filled"],
      reason: ["mapping", "min_volume"],
      venue: "ctrader",
      from: new Date("2026-11-12T00:00:00Z"),
      to: new Date("2026-11-13T00:00:00Z"),
      sort: "mfx_ms",
      limit: 2,
    })) {
      reasons.push(each.reason);
    }
    expect(reasons).toEqual(["mapping", "min_volume", null]);
    expect(route(net.calls[0])).toBe("GET /v1/copy/log");
    expect(Object.fromEntries(net.calls[0]?.url.searchParams ?? [])).toEqual({
      limit: "2",
      leader_id: LEADER,
      follower_id: FOLLOWER,
      account_id: FOLLOWER_ACCOUNT,
      signal_id: SIGNAL,
      outcome: "refused,filled",
      reason: "mapping,min_volume",
      venue: "ctrader",
      from: "2026-11-12T00:00:00.000Z",
      to: "2026-11-13T00:00:00.000Z",
      sort: "mfx_ms",
    });
    expect(net.calls[1]?.url.searchParams.get("cursor")).toBe("c-2");
    const one = await copy.logPage({ from: new Date("2026-11-12T00:00:00Z") });
    expect(one.stats?.refused).toBe(2);
    expect(net.calls[2]?.url.search).toBe("?from=2026-11-12T00%3A00%3A00.000Z");
  });

  it("refuses a reason outside the closed list, a reversed window, a bad order or cursor", async () => {
    const net = fake();
    const copy = client(net).copy;
    await expect(copy.logPage({ reason: "terminal_not_active" as "mapping" })).rejects.toThrow(
      RangeError,
    );
    await expect(
      copy.logPage({
        from: new Date("2026-11-13T00:00:00Z"),
        to: new Date("2026-11-12T00:00:00Z"),
      }),
    ).rejects.toThrow(RangeError);
    await expect(copy.logPage({ sort: "slowest" as "mfx_ms" })).rejects.toThrow(RangeError);
    await expect(copy.logPage({ cursor: 7 as unknown as string })).rejects.toThrow(TypeError);
    await expect(copy.logPage({ to: "today" as unknown as Date })).rejects.toThrow(TypeError);
    expect(net.calls).toHaveLength(0);
    expect(REFUSAL_REASONS).toEqual([
      "mapping",
      "min_volume",
      "no_stop",
      "risk_rule",
      "plan_limit",
      "stopped_out",
      "signal_expired",
      "skip_pending",
      "close_only",
      "paused",
      "account_not_connected",
      "market_closed",
      "no_conversion",
      "not_on_this_venue",
      "venue_unavailable",
      "broker",
    ]);
  });
});

describe("the copy events are read by their type, naming the account and its venue", () => {
  it("reads every copy event and nothing else", () => {
    const common = {
      schema_version: "1",
      follower_id: FOLLOWER,
      leader_id: LEADER,
      account_id: FOLLOWER_ACCOUNT,
      venue: "ctrader",
      at: AT,
    };
    const kinds = COPY_EVENT_TYPES.map((type) => {
      const event = copyEventOf(new StreamMessage("events", 1, type, common));
      return event?.type;
    });
    expect(kinds).toEqual([
      "copy.copied",
      "copy.refused",
      "copy.stopout",
      "copy.drift",
      "copy.state_changed",
      "copy.closed",
    ]);
    const copied = copyEventOf({
      type: "copy.copied",
      data: {
        ...common,
        signal_id: SIGNAL,
        command_id: "0191f0c2-bbbb-7ccc-8ddd-000000000001",
        deal: {
          action: "open",
          side: "buy",
          units: "100000",
          price: "1.08512",
          instrument_key: "fx:EURUSD",
        },
        as: { symbol: "EURUSD", side: "buy", volume: "50000", price: null },
        latency_ms: 12.5,
        slippage: null,
        stages: { detect_ms: 2, broker_ms: 40.5 },
      },
    });
    if (copied?.type !== "copy.copied") throw new Error("not a copy");
    const latency: number | null = copied.data.latency_ms;
    const detect: number | undefined = copied.data.stages.detect_ms;
    expect([latency, detect, copied.data.stages.broker_ms]).toEqual([12.5, 2, 40.5]);
    expect(copied.data.as.volume).toBe("50000");
    expect(copied.data.deal.units).toBe("100000");
    const refused = copyEventOf({
      type: "copy.refused",
      data: { ...common, reason: "broker", venue_code: "TRADING_BAD_VOLUME" },
    });
    if (refused?.type !== "copy.refused") throw new Error("not a refusal");
    expect(refused.data.reason).toBe("broker");
    expect(REFUSAL_REASONS).toContain(refused.data.reason);
    expect(refused.data.venue_code).toBe("TRADING_BAD_VOLUME");
    expect(copyEventOf(new StreamMessage("events", 2, "order.placed", common))).toBeNull();
    expect(copyEventOf(new StreamMessage("md:x", 3, null, {}))).toBeNull();
    expect(() => copyEventOf({ type: "copy.drift", data: { venue: "mt5" } })).toThrow(TypeError);
    expect(() =>
      copyEventOf({ type: "copy.drift", data: null as unknown as Record<string, unknown> }),
    ).toThrow(TypeError);
    expect(() =>
      copyEventOf({ type: "copy.drift", data: "x" as unknown as Record<string, unknown> }),
    ).toThrow(TypeError);
  });
});

describe("every copy method refuses a bad id, key or choice before sending anything", () => {
  it("refuses before sending", async () => {
    const net = fake();
    const copy = client(net).copy;
    const k = { idempotencyKey: "k" };
    const bad = "not-a-uuid";
    const refusals: Promise<unknown>[] = [
      copy.getLeader(bad),
      copy.getFollower(bad),
      copy.getGroup(bad),
      copy.pauseLeader(bad, k),
      copy.resumeFollower(bad, k),
      copy.pauseGroup(LEADER, { idempotencyKey: "" }),
      copy.resumeGroup(bad, k),
      copy.stopoutsPage(bad),
      copy.leadersPage({ accountId: bad }),
      copy.followersPage({ groupId: bad }),
      copy.groupsPage({ state: "closed" as "active" }),
      copy.groupsPage({ limit: 0 }),
      copy.retireLeader(LEADER, { reason: "r", ...k } as unknown as {
        closeCopied: boolean;
        reason: string;
        idempotencyKey: string;
      }),
      copy.retireLeader(LEADER, { closeCopied: true, reason: "", ...k }),
      copy.unfollow(FOLLOWER, k as unknown as { closeCopied: boolean; idempotencyKey: string }),
      copy.createFollower({ accountId: bad, leaderId: LEADER, ...k }),
      copy.createGroup({ name: "", ...k }),
      copy.updateGroup(GROUP, { name: "", ...k }),
      copy.updateGroup(GROUP, { grossExposureCap: "-1", ...k }),
      copy.addGroupFollowers(GROUP, [bad], k),
      copy.resetStopouts(FOLLOWER, { reason: "", ...k }),
      copy.updateLeader(LEADER, { idempotencyKey: undefined as unknown as string }),
    ];
    for (const refusal of refusals) {
      const error: unknown = await refusal.catch((e: unknown) => e);
      expect(error instanceof TypeError || error instanceof RangeError, String(error)).toBe(true);
    }
    expect(net.calls).toHaveLength(0);
  });
});

const CLOSE = "06abfa00-0000-7000-8000-0000000000a1";
const BATCH = "06abfa00-0000-7000-8000-0000000000a2";
const closeRow = (state: Schemas["CopyCloseState"] = "pending"): Schemas["CopyClose"] => ({
  id: CLOSE,
  follower_id: FOLLOWER,
  leader_id: LEADER,
  account_id: FOLLOWER_ACCOUNT,
  group_id: GROUP,
  batch_id: BATCH,
  cause: "group_close",
  reason: "desk closing",
  cutoff_at: AT,
  requested_by: "key",
  attempt: 1,
  next_attempt_at: null,
  state,
  created_at: AT,
  finished_at: null,
  entries: [],
});
const closeStats = { pending: 1, done: 1, incomplete: 0, superseded: 0 };

describe("a group's close needs pause, its rollover a key only when applied, and requested closes are followed", () => {
  it("closes, rolls over and follows the closes on the contract's routes", async () => {
    const net = fake(
      json(202, {
        group_id: GROUP,
        batch_id: BATCH,
        paused: true,
        followers: 1,
        closes: [CLOSE],
      }),
      json(200, {
        group_id: GROUP,
        dry_run: true,
        fields: ["scaling"],
        results: [],
        next_after: null,
      }),
      json(200, { group_id: GROUP, dry_run: false, fields: [], results: [], next_after: null }),
      page([closeRow()], "c2", { stats: closeStats }),
      page([closeRow("done")], null, { stats: closeStats }),
      json(200, closeRow("incomplete")),
    );
    const copy = client(net).copy;
    const closed = await copy.closeGroup(GROUP, {
      reason: "desk closing",
      pause: true,
      idempotencyKey: "gc-1",
    });
    expect(closed.closes).toEqual([CLOSE]);
    expect(route(net.calls[0])).toBe(`POST /v1/copy/groups/${GROUP}/close`);
    expect(sent(net.calls[0])).toEqual({ reason: "desk closing", pause: true });
    expect(key(net.calls[0])).toBe("gc-1");

    await copy.rolloverGroup(GROUP, { dryRun: true, fields: ["scaling"], limit: 100 });
    expect(route(net.calls[1])).toBe(`POST /v1/copy/groups/${GROUP}/rollover`);
    expect(sent(net.calls[1])).toEqual({ dry_run: true, fields: ["scaling"], limit: 100 });
    expect(key(net.calls[1])).toBeNull();
    await copy.rolloverGroup(GROUP, { dryRun: false, after: FOLLOWER, idempotencyKey: "ro-1" });
    expect(sent(net.calls[2])).toEqual({ dry_run: false, after: FOLLOWER });
    expect(key(net.calls[2])).toBe("ro-1");

    const refusals: Promise<unknown>[] = [
      copy.closeGroup(GROUP, { reason: "r", idempotencyKey: "k" } as unknown as {
        reason: string;
        pause: boolean;
        idempotencyKey: string;
      }),
      copy.rolloverGroup(GROUP, { dryRun: false }),
      copy.rolloverGroup(GROUP, { dryRun: true, idempotencyKey: "k" }),
      copy.rolloverGroup(GROUP, { dryRun: true, fields: ["name" as "scaling"] }),
      copy.rolloverGroup(GROUP, { dryRun: true, limit: 501 }),
      copy.closesPage({ from: new Date(AT), to: new Date("2026-11-12T00:00:00Z") }),
      copy.closesPage({ state: "open" as "pending" }),
    ];
    for (const refusal of refusals) {
      const error: unknown = await refusal.catch((e: unknown) => e);
      expect(error instanceof TypeError || error instanceof RangeError, String(error)).toBe(true);
    }
    expect(net.calls).toHaveLength(3);

    const ids: string[] = [];
    for await (const c of copy.closes({
      batchId: BATCH,
      groupId: GROUP,
      state: ["pending", "incomplete"],
      from: new Date("2026-11-12T00:00:00Z"),
    })) {
      ids.push(c.state);
    }
    expect(ids).toEqual(["pending", "done"]);
    expect(Object.fromEntries(net.calls[3]?.url.searchParams ?? [])).toEqual({
      group_id: GROUP,
      batch_id: BATCH,
      state: "pending,incomplete",
      from: "2026-11-12T00:00:00.000Z",
    });
    expect(net.calls[4]?.url.searchParams.get("cursor")).toBe("c2");
    const one = await copy.getClose(CLOSE);
    expect(one.state).toBe("incomplete");
    expect(route(net.calls[5])).toBe(`GET /v1/copy/closes/${CLOSE}`);
  });
});

describe("a response enum word from a later version of the API reads as sent and never fails the call", () => {
  it("reads a word it does not know as the word", async () => {
    const later = "a_word_from_a_later_version";
    const net = fake(
      page([closeRow(), { ...closeRow("done"), cause: later }], null, { stats: closeStats }),
      page([leader(), { ...leader(), source: later, state: later }], null, {
        stats: { leaders: 2, active: 1, paused: 0, retired: 0 },
      }),
    );
    const copy = client(net).copy;
    const closes = await copy.closesPage();
    expect(closes.items.map((c) => [c.cause, c.state])).toEqual([
      ["group_close", "pending"],
      [later, "done"],
    ]);
    const leaders = await copy.leadersPage();
    expect(leaders.items.map((x) => [x.source, x.state])).toEqual([
      ["account", "active"],
      [later, later],
    ]);
    const refused: unknown = await copy
      .leadersPage({ source: later as "account" })
      .catch((e: unknown) => e);
    expect(refused instanceof TypeError || refused instanceof RangeError, String(refused)).toBe(
      true,
    );
    expect(net.calls).toHaveLength(2);
  });
});

describe("signals, every stop-out, followers sorted and out of step, and the log by group are read as the contract sends them", () => {
  it("reads the tenant's signals, stop-outs, followers and log", async () => {
    const signal = {
      id: SIGNAL,
      leader_id: LEADER,
      kind: "fill",
      action: "open",
      side: "buy",
      volume_units: "100000",
      price: "1.0850",
      sl: null,
      tp: null,
      instrument_key: "fx:EURUSD",
      leader_currency: "USD",
      source_id: null,
      iat: AT,
      exp: AT,
      created_at: AT,
      outcomes: { filled: 2, refused: 1, skipped: 0 },
    };
    const stopout = {
      id: "06abfa00-0000-7000-8000-0000000000b1",
      follower_id: FOLLOWER,
      limit: "daily",
      used: "5.2",
      period_start: AT,
      period_end: null,
      closed: [],
      state: "active",
      reset: null,
      created_at: AT,
    };
    const net = fake(
      page([signal], "c2", { stats: { signals: 1, fill: 1, external: 0 } }),
      page([signal], null, { stats: { signals: 1, fill: 1, external: 0 } }),
      page([stopout], null, { stats: { stopouts: 1, active: 1, reset: 0, expired: 0 } }),
      page([follower()], null, { stats: {} }),
      page([row("risk_rule")], null, { stats: logStats }),
      page([stopout], "c2", { stats: { stopouts: 1, active: 1, reset: 0, expired: 0 } }),
      page([], null, { stats: { stopouts: 1, active: 1, reset: 0, expired: 0 } }),
    );
    const copy = client(net).copy;
    const from = new Date("2026-11-12T00:00:00Z");
    let filled = 0;
    for await (const x of copy.signals({
      leaderId: LEADER,
      kind: "fill",
      action: ["open", "close"],
      from,
    })) {
      filled += x.outcomes.filled;
    }
    expect(filled).toBe(4);
    expect(route(net.calls[0])).toBe("GET /v1/copy/signals");
    expect(Object.fromEntries(net.calls[0]?.url.searchParams ?? [])).toEqual({
      from: "2026-11-12T00:00:00.000Z",
      leader_id: LEADER,
      kind: "fill",
      action: "open,close",
    });
    const stops = await copy.tenantStopoutsPage({
      state: ["active", "reset"],
      groupId: GROUP,
      to: from,
    });
    expect(stops.stats?.active).toBe(1);
    expect(route(net.calls[2])).toBe("GET /v1/copy/stopouts");
    expect(Object.fromEntries(net.calls[2]?.url.searchParams ?? [])).toEqual({
      to: "2026-11-12T00:00:00.000Z",
      state: "active,reset",
      group_id: GROUP,
    });
    await copy.followersPage({ sort: "oldest", outOfStep: true });
    expect(Object.fromEntries(net.calls[3]?.url.searchParams ?? [])).toEqual({
      out_of_step: "true",
      sort: "oldest",
    });
    const log = await copy.logPage({ groupId: GROUP, reason: "risk_rule" });
    expect(log.stats?.mfx_ms_p95).toBe(30);
    expect(Object.fromEntries(net.calls[4]?.url.searchParams ?? [])).toEqual({
      group_id: GROUP,
      reason: "risk_rule",
    });

    const refusals: Promise<unknown>[] = [
      copy.signalsPage({ kind: "manual" as "fill" }),
      copy.signalsPage({ action: [] }),
      copy.tenantStopoutsPage({ state: "gone" as "active" }),
      copy.tenantStopoutsPage({ from: new Date("nope") }),
      copy.followersPage({ sort: "largest" as "newest" }),
      copy.followersPage({ outOfStep: "yes" as unknown as boolean }),
    ];
    for (const refusal of refusals) {
      const error: unknown = await refusal.catch((e: unknown) => e);
      expect(error instanceof TypeError || error instanceof RangeError, String(error)).toBe(true);
    }
    expect(net.calls).toHaveLength(5);
    const all: string[] = [];
    for await (const x of copy.tenantStopouts({ followerId: FOLLOWER })) all.push(x.id);
    expect(all).toEqual([stopout.id]);
    expect(net.calls[6]?.url.searchParams.get("cursor")).toBe("c2");
  });
});

describe("copy.closed and a refusal's Risk detail are read as the contract's copy events", () => {
  it("reads copy.closed and a Risk refusal", () => {
    const common = {
      schema_version: "1",
      follower_id: FOLLOWER,
      leader_id: LEADER,
      account_id: FOLLOWER_ACCOUNT,
      venue: "ctrader",
      at: AT,
    };
    const closed = copyEventOf({
      type: "copy.closed",
      data: {
        ...common,
        close_id: CLOSE,
        cause: "unfollowed",
        state: "incomplete",
        closed: [{ symbol: "EURUSD", volume: "50000", command_id: null }],
        not_closed: [{ symbol: "XAUUSD", volume: "10", why: "netting" }],
      },
    });
    expect(closed?.type).toBe("copy.closed");
    if (closed?.type !== "copy.closed") throw new Error("not copy.closed");
    expect(closed.data.not_closed[0]?.why).toBe("netting");
    expect(closed.data.closed[0]?.volume).toBe("50000");
    const refused = copyEventOf({
      type: "copy.refused",
      data: {
        ...common,
        signal_id: SIGNAL,
        deal: { action: "open", side: "buy", units: "1", price: null, instrument_key: null },
        outcome: "refused",
        reason: "risk_rule",
        venue_code: null,
        why: null,
        risk: {
          reason: "daily_loss",
          rule: "daily_loss",
          policy_id: null,
          version: null,
          used: "450",
          limit: "500",
          would_be: "520",
          challenge_id: CLOSE,
          challenge_version: 2,
        },
      },
    });
    if (refused?.type !== "copy.refused") throw new Error("not copy.refused");
    expect(refused.data.risk?.would_be).toBe("520");
    expect(refused.data.risk?.challenge_version).toBe(2);
    expect(COPY_EVENT_TYPES).toContain("copy.closed");
  });
});
