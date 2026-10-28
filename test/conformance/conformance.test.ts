// The TypeScript SDK passes the shared SDK test suite: every case, played back by the suite's fake
// MFX Hub on localhost, through this SDK's public surface.
//
// This file is the TypeScript runner. It holds no rule: it asks the fake hub for each case, turns
// the case's neutral operation into the TypeScript call, and checks what came back against the
// case and against the hub's verdict on what was sent. The rules are the suite's (./suite/cases),
// vendored at the version in suite-version.txt; the hub is started by ./hub.ts.

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, inject, it } from "vitest";

import * as errors from "../../src/errors.js";
import { MfxClient, SigningKey, StreamMessage, signingMessage } from "../../src/index.js";

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
  if (op in VOCABULARY.ops) throw new NotYet(`this SDK has no ${op} yet`);
  throw new Error(`this runner does not know the operation ${JSON.stringify(op)}`);
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
