// The TypeScript SDK passes the shared SDK test suite: every case, played back by the suite's fake
// MFX Hub on localhost, through this SDK's public surface.
//
// This file is the TypeScript runner. It holds no rule: it asks the fake hub for each case, turns
// the case's neutral operation into the TypeScript call, and checks what came back against the
// case and against the hub's verdict on what was sent. The rules are the suite's (./suite/cases),
// vendored at the version in suite-version.txt; the hub is started by ./hub.ts.

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, inject, it, vi } from "vitest";

import * as errors from "../../src/errors.js";
import {
  MfxClient,
  SERVICE_AGREEMENT_WARNING,
  SigningKey,
  StreamMessage,
  copyEventOf,
  signingMessage,
} from "../../src/index.js";
import type {
  CopyEvent,
  CopyOptionsInput,
  CopyOutcome,
  CopyPreviewRow,
  CopyReason,
  CopyScaling,
  Timeframe,
} from "../../src/index.js";

interface Vocabulary {
  readonly key: { readonly id: string; readonly seed_hex: string };
  readonly ops: Readonly<Record<string, unknown>>;
  readonly errors: readonly string[];
}

type Observe =
  | { readonly returns: Readonly<Record<string, unknown>> }
  | { readonly raises: string; readonly fields?: Readonly<Record<string, unknown>> }
  | { readonly refuses: string };

interface Case {
  readonly id: string;
  readonly rule: string;
  readonly call: { readonly op: string; readonly args: Readonly<Record<string, unknown>> };
  readonly observe: Observe;
}

type ErrorClass = abstract new (...args: never[]) => Error;

const read = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));

const VOCABULARY = read("./suite/vocabulary.json") as Vocabulary;
/** Cases this SDK does not pass yet, each with the reason. Empty at 1.0 (the suite's rule). */
const NOT_YET = read("./not-yet.json") as Readonly<Record<string, string>>;
const SEED = Buffer.from(VOCABULARY.key.seed_hex, "hex");

/** The suite's neutral error kinds, as this SDK's classes. */
const KINDS: Readonly<Record<string, ErrorClass>> = {
  ...(Object.fromEntries(
    Object.entries(errors).filter(([name]) => VOCABULARY.errors.includes(name)),
  ) as Record<string, ErrorClass>),
  ApiError: errors.MfxApiError,
  TransportError: errors.MfxTransportError,
  Timeout: errors.MfxTimeout,
};

function cases(): Case[] {
  const directory = new URL("./suite/cases/", import.meta.url);
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .flatMap((name) => read(`./suite/cases/${name}`) as Case[]);
}

/** Raised for an operation this SDK has not built yet; such a case is listed in not-yet.json. */
class NotYet extends Error {}

/** A case argument as TypeScript: `$decimal` is the decimal string, `$float` a number. */
function value(raw: unknown): unknown {
  if (typeof raw === "object" && raw !== null) {
    if ("$decimal" in raw) return String(raw.$decimal);
    if ("$float" in raw) return Number(raw.$float);
  }
  return raw;
}

/** A decimal string without its sign of zero and trailing zeros, so 1.50 and 1.5 compare equal. */
function decimal(text: string): string {
  const [whole = "", fraction = ""] = text.trim().replace(/^\+/, "").split(".");
  const negative = whole.startsWith("-");
  const digits = (negative ? whole.slice(1) : whole).replace(/^0+(?=\d)/, "") || "0";
  const tail = fraction.replace(/0+$/, "");
  const body = tail === "" ? digits : `${digits}.${tail}`;
  return negative && body !== "0" ? `-${body}` : body;
}

function same(got: unknown, want: unknown): boolean {
  if (typeof want === "object" && want !== null && "$decimal" in want) {
    return (
      (typeof got === "string" || typeof got === "number") &&
      decimal(String(got)) === decimal(String(want.$decimal))
    );
  }
  return JSON.stringify(got) === JSON.stringify(want);
}

/** A case's field name (snake_case, the suite's) as this SDK's property (camelCase). */
const camel = (name: string): string =>
  name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

/** Makes the case's call through this SDK and describes what came back in the suite's names. */
async function call(
  client: MfxClient,
  op: string,
  args: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const a = Object.fromEntries(Object.entries(args).map(([name, raw]) => [name, value(raw)]));
  if (op === "signing.sign") {
    const message = signingMessage(
      String(a.timestamp),
      String(a.nonce),
      String(a.method),
      String(a.path_with_query),
      Buffer.from(String(a.body)),
    );
    return { signature: new SigningKey(SEED).sign(message) };
  }
  if (op === "tenant.service_agreement") {
    const due = await client.tenant.serviceAgreement();
    return {
      due: due.due,
      held: due.held,
      plan: due.plan,
      plan_change_state: due.plan_change?.state ?? null,
      plan_change_to: due.plan_change?.to ?? null,
      documents: due.documents.map((d) => d.document),
      accept_url: due.accept_url,
    };
  }
  if (op === "agreement.due_warnings") {
    // Fresh clients, one after another, each reading the terminal `calls` times; only the SDK's
    // warning that a Service Agreement is due is counted.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      for (let made = 0; made < Number(a.clients); made++) {
        const each = new MfxClient(client.baseUrl, client.keyId, SEED, {
          sleep: () => Promise.resolve(),
        });
        for (let sent = 0; sent < Number(a.calls); sent++) {
          await each.terminals.get(String(a.terminal_id));
        }
      }
      return {
        warnings: warn.mock.calls.filter(([said]) => said === SERVICE_AGREEMENT_WARNING).length,
      };
    } finally {
      warn.mockRestore();
    }
  }
  if (op === "terminals.get") {
    const terminal = await client.terminals.get(String(a.terminal_id));
    return { id: terminal.id, state: terminal.state };
  }
  if (op === "terminals.page") {
    const page = await client.terminals.page(a);
    return { count: page.length, next_cursor: page.nextCursor };
  }
  if (op === "terminals.list") {
    const ids: string[] = [];
    for await (const terminal of client.terminals.list()) ids.push(terminal.id);
    return { ids };
  }
  if (op === "terminals.create") {
    const terminal = await client.terminals.create({
      farmId: String(a.farm_id),
      brokerId: String(a.broker_id),
      serverId: String(a.server_id),
      idempotencyKey: String(a.idempotency_key),
    });
    return { id: terminal.id, state: terminal.state };
  }
  if (op === "execution.place_order") {
    const result = await client.execution.placeOrder(String(a.terminal_id), {
      symbol: a.symbol as string,
      side: a.side as "buy" | "sell",
      volume: a.volume as string,
      idempotencyKey: a.idempotency_key as string,
    });
    return {
      ok: result.ok,
      state: result.state,
      command_id: result.commandId,
      duplicate: result.duplicate,
      retryable: result.retryable,
      exec_price: result.execPrice,
      position: result.tickets.position,
      comment_raw: result.commentRaw,
    };
  }
  if (op === "catalog.quote") {
    const quote = await client.catalog.quote(String(a.broker_id), String(a.symbol));
    return { bid: quote.bid, ask: quote.ask, age_s: quote.age_s, state: quote.state };
  }
  if (op === "stream.read") {
    return readStream(client, a.channels as string[], Number(a.count));
  }
  if (op === "stream.close_waiting") {
    return closeWaiting(client, a.channels as string[]);
  }
  if (op === "md.subscribe_account") {
    const subscription = await client.md.subscribeAccount(String(a.account_id), String(a.symbol), {
      idempotencyKey: String(a.idempotency_key),
    });
    return {
      id: subscription.id,
      account_id: subscription.account_id,
      symbol: subscription.symbol,
      state: subscription.state,
    };
  }
  if (op === "md.account_subscriptions") {
    const symbols: string[] = [];
    for await (const subscription of client.md.accountSubscriptions(String(a.account_id))) {
      symbols.push(subscription.symbol);
    }
    return { symbols };
  }
  if (op === "md.account_candles") {
    const bars = await client.md.accountCandles(String(a.account_id), {
      symbol: String(a.symbol),
      timeframe: a.timeframe as Timeframe,
      from: new Date(String(a.from)),
      to: new Date(String(a.to)),
    });
    return {
      count: bars.items.length,
      first_open: bars.items[0]?.o ?? null,
      last_close: bars.items.at(-1)?.c ?? null,
    };
  }
  if (op === "risk.check") {
    const order = { symbol: a.symbol, side: a.side, type: "market", volume: a.volume } as never;
    const checked = await client.risk.check(String(a.account_id), order);
    return { verdict: checked.verdict };
  }
  if (op === "risk.create_plan") {
    const order = { symbol: a.symbol, side: a.side, type: "market", volume: a.volume };
    const step = {
      trigger: { kind: "r", value: "1" },
      action: { kind: "close_part", pct: "50" },
      held_by: "mfx",
    };
    const plan = await client.risk.createPlan(
      { account_id: a.account_id, order, steps: [step] } as never,
      { idempotencyKey: String(a.idempotency_key) },
    );
    return { id: plan.id };
  }
  if (op === "risk.create_policy") {
    const policy = await client.risk.createPolicy(String(a.name), a.rules as never, {
      reset: a.reset as never,
      idempotencyKey: String(a.idempotency_key),
    });
    return { id: policy.id, version: policy.current_version.version };
  }
  if (op === "risk.challenge_accounts") {
    const ids: string[] = [];
    for await (const account of client.risk.challengeAccounts(String(a.challenge_id), {
      state: a.state as never,
      sort: a.sort as never,
    })) {
      ids.push(account.account_id);
    }
    return { ids };
  }
  if (op.startsWith("copy.")) return copyCall(client, op, a);
  if (op in VOCABULARY.ops) throw new NotYet(`this SDK has no ${op} yet`);
  throw new Error(`this runner does not know the operation ${JSON.stringify(op)}`);
}

/** The Copy Trading operations, through `client.copy`. */
async function copyCall(
  client: MfxClient,
  op: string,
  a: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const copy = client.copy;
  const key = { idempotencyKey: a.idempotency_key as string };
  if (op === "copy.create_leader") {
    const leader = await copy.createLeader({
      source: a.source as "account" | "external",
      ...(a.account_id === undefined ? {} : { accountId: a.account_id as string }),
      signalLifetimeS: a.signal_lifetime_s as number,
      ...key,
    });
    return { id: leader.id, source: leader.source, state: leader.state };
  }
  if (op === "copy.leaders") {
    const state = a.state as "active"[] | undefined;
    const ids: string[] = [];
    let statsLeaders: number | null = null;
    let cursor: string | undefined;
    do {
      const page = await copy.leadersPage({
        ...(state === undefined ? {} : { state }),
        ...(cursor === undefined ? {} : { cursor }),
      });
      ids.push(...page.items.map((leader) => leader.id));
      statsLeaders ??= page.stats?.leaders ?? null;
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return { ids, stats_leaders: statsLeaders };
  }
  if (op === "copy.send_open_signal") {
    const accepted = await copy.sendOpenSignal(a.leader_id as string, {
      id: a.id as string,
      symbol: a.symbol as string,
      side: a.side as "buy" | "sell",
      volume: a.volume as string,
      ...key,
    });
    return { signal_id: accepted.signal_id, duplicate: accepted.duplicate };
  }
  if (op === "copy.create_follower") {
    const follower = await copy.createFollower({
      accountId: a.account_id as string,
      leaderId: a.leader_id as string,
      scaling: a.scaling as CopyScaling,
      ...(a.options === undefined ? {} : { options: a.options as CopyOptionsInput }),
      ...key,
    });
    return { id: follower.id, state: follower.state, mandate_version: follower.mandate_version };
  }
  if (op === "copy.preview_follower") {
    const preview = await copy.previewFollower({
      accountId: a.account_id as string,
      leaderId: a.leader_id as string,
      scaling: a.scaling as CopyScaling,
      rows: a.rows as CopyPreviewRow[],
    });
    return {
      refusal: preview.refusal,
      follower_volumes: preview.rows.map((row) => row.follower_volume),
      reasons: preview.rows.map((row) => row.reason),
    };
  }
  if (op === "copy.unfollow") {
    const follower = await copy.unfollow(a.follower_id as string, {
      closeCopied: a.close_copied as boolean,
      ...key,
    });
    return { state: follower.state };
  }
  if (op === "copy.reset_stopouts") {
    const follower = await copy.resetStopouts(a.follower_id as string, {
      reason: a.reason as string,
      ...key,
    });
    return { state: follower.state };
  }
  if (op === "copy.log") {
    const log = await copy.logPage({
      ...(a.outcome === undefined ? {} : { outcome: a.outcome as CopyOutcome[] }),
      ...(a.reason === undefined ? {} : { reason: a.reason as CopyReason[] }),
      ...(a.from === undefined ? {} : { from: new Date(a.from as string) }),
      ...(a.to === undefined ? {} : { to: new Date(a.to as string) }),
    });
    return {
      count: log.length,
      reasons: log.items.map((row) => row.reason),
      stats_refused: log.stats?.refused ?? null,
    };
  }
  if (op === "copy.add_group_followers") {
    const result = await copy.addGroupFollowers(
      a.group_id as string,
      a.follower_ids as string[],
      key,
    );
    return {
      outcomes: result.results.map((item) => item.outcome),
      reasons: result.results.map((item) => item.reason),
    };
  }
  if (op === "copy.close_group") {
    const closed = await copy.closeGroup(a.group_id as string, {
      reason: a.reason as string,
      pause: a.pause as boolean,
      ...key,
    });
    return { batch_id: closed.batch_id, paused: closed.paused, closes: closed.closes };
  }
  if (op === "copy.rollover_group") {
    const rolled = await copy.rolloverGroup(a.group_id as string, {
      dryRun: a.dry_run as boolean,
      ...(a.fields === undefined ? {} : { fields: a.fields as "scaling"[] }),
      ...(a.after === undefined ? {} : { after: a.after as string }),
      ...(a.limit === undefined ? {} : { limit: a.limit as number }),
      ...(a.idempotency_key === undefined ? {} : key),
    });
    return {
      outcomes: rolled.results.map((item) => item.outcome),
      reasons: rolled.results.map((item) => item.reason),
      next_after: rolled.next_after,
    };
  }
  if (op === "copy.closes") {
    const ids: string[] = [];
    const states: string[] = [];
    let statsIncomplete: number | null = null;
    let cursor: string | undefined;
    do {
      const page = await copy.closesPage({
        ...(a.batch_id === undefined ? {} : { batchId: a.batch_id as string }),
        ...(a.state === undefined ? {} : { state: a.state as "pending"[] }),
        ...(cursor === undefined ? {} : { cursor }),
      });
      ids.push(...page.items.map((close) => close.id));
      states.push(...page.items.map((close) => close.state));
      statsIncomplete ??= page.stats?.incomplete ?? null;
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return { ids, states, stats_incomplete: statsIncomplete };
  }
  if (op === "copy.read_events") return readCopyEvents(client, Number(a.count));
  throw new Error(`this runner does not know the operation ${JSON.stringify(op)}`);
}

/** Read `count` messages on the events channel as the SDK's typed copy events. */
async function readCopyEvents(client: MfxClient, count: number): Promise<Record<string, unknown>> {
  const events: CopyEvent[] = [];
  const stream = await client.stream({ maxReconnects: 3 });
  try {
    await stream.subscribe("events");
    for await (const message of stream) {
      if (message instanceof StreamMessage) {
        const event = copyEventOf(message);
        if (event !== null) events.push(event);
        if (events.length >= count) break;
      }
    }
  } finally {
    await stream.close();
  }
  return {
    types: events.map((event) => event.type),
    accounts: events.map((event) => event.data.account_id),
    venues: events.map((event) => event.data.venue),
    reasons: events.map((event) => (event.type === "copy.refused" ? event.data.reason : null)),
  };
}

/**
 * Subscribe in order, read `count` data messages, and report them with the stream's counters. A
 * few reconnects are allowed, enough for any case; the client's sleep is a no-op, so a reconnect is
 * decided by the stream and not waited for.
 */
async function readStream(
  client: MfxClient,
  channels: readonly string[],
  count: number,
): Promise<Record<string, unknown>> {
  const seqs: (number | null)[] = [];
  const types: (string | null)[] = [];
  const stream = await client.stream({ maxReconnects: 3 });
  try {
    for (const channel of channels) await stream.subscribe(channel);
    for await (const event of stream) {
      if (event instanceof StreamMessage) {
        seqs.push(event.seq);
        types.push(event.type);
        if (seqs.length >= count) break;
      }
    }
  } finally {
    await stream.close();
  }
  const stats = stream.stats;
  return {
    seqs,
    types,
    dropped: stats.dropped,
    reconnects: stats.reconnects,
    lifetime_reconnects: stats.lifetimeReconnects,
    slow_consumer_drops: stats.slowConsumerDrops,
    resyncs: stats.resyncs,
    refused: stats.refused,
  };
}

/**
 * Leave a read waiting on a quiet stream, close the stream, and see whether the read ended: it
 * has when it finishes within 2 s with nothing, no message and no error.
 */
async function closeWaiting(
  client: MfxClient,
  channels: readonly string[],
): Promise<Record<string, unknown>> {
  const stream = await client.stream({ maxReconnects: 3 });
  for (const channel of channels) await stream.subscribe(channel);
  const waiting = stream.next().then(
    (event) => event === null,
    () => false,
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  await stream.close();
  const ended = await Promise.race([
    waiting,
    new Promise<boolean>((resolve) => {
      setTimeout(() => {
        resolve(false);
      }, 2000);
    }),
  ]);
  return { ended, reconnects: stream.stats.reconnects };
}

async function hub(path: string, body?: unknown): Promise<unknown> {
  const control = inject("hubUrl").replace(/\/v1$/, "");
  const answer = await fetch(
    `${control}${path}`,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  expect(answer.status, `${path} answered ${answer.status}`).toBe(200);
  return answer.json();
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("the TypeScript SDK passes every case of the shared SDK test suite", () => {
  const all = cases();

  it("lists as not yet passed only cases the suite has", () => {
    const ids = new Set(all.map((c) => c.id));
    expect(Object.keys(NOT_YET).filter((id) => !ids.has(id))).toEqual([]);
  });

  // Given a case of the shared SDK test suite, played back by the suite's fake MFX Hub
  // When this SDK makes the case's call, signed with the suite's test key
  // Then it returns, raises or refuses exactly as the case observes, and the hub's verdict is that
  // every request the case expects arrived in order, signed and shaped as the case says, and
  // nothing else did. A case listed in not-yet.json must fail, so the list cannot go stale.
  for (const { id, rule } of all) {
    const test = id in NOT_YET ? it.fails : it;
    test(`${id}: ${rule}`, async () => {
      const c = (await hub("/_hub/case", { id })) as Case;
      const client = new MfxClient(inject("hubUrl"), VOCABULARY.key.id, SEED, {
        sleep: () => Promise.resolve(),
      });
      const observe = c.observe;
      if ("raises" in observe) {
        const kind = KINDS[observe.raises];
        expect(kind, `the SDK has no error kind ${observe.raises}`).toBeDefined();
        const error = await caught(call(client, c.call.op, c.call.args));
        expect(error).toBeInstanceOf(kind);
        for (const [name, want] of Object.entries(observe.fields ?? {})) {
          expect((error as Record<string, unknown>)[camel(name)], name).toEqual(want);
        }
      } else if ("refuses" in observe) {
        expect(observe.refuses).toBe("invalid_argument");
        const error = await caught(call(client, c.call.op, c.call.args));
        expect(error instanceof TypeError || error instanceof RangeError, String(error)).toBe(true);
      } else {
        const got = await call(client, c.call.op, c.call.args);
        for (const [name, want] of Object.entries(observe.returns)) {
          expect(same(got[name], want), `${name}: ${JSON.stringify(got[name])}`).toBe(true);
        }
      }
      const verdict = (await hub("/_hub/verdict")) as { ok: boolean; problems: string[] };
      expect(verdict.problems).toEqual([]);
      expect(verdict.ok).toBe(true);
    });
  }
});
