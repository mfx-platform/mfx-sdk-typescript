// docs/sdkref.json, the SDK reference the docs site renders (format mfx-sdkref/1), is generated
// from the package's public exports by tools/sdkref.mjs. These tests hold the generator to the
// format: the pages and anchors, Markdown doc text, the contract operation each method calls,
// nothing internal in the file, and the committed file being exactly what the source generates.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, beforeAll, expect, it } from "vitest";

import * as sdk from "../../src/index.js";
import { MfxClient } from "../../src/index.js";
import { match, scan } from "../../tools/check-public.mjs";
import {
  HAND_SCHEMAS,
  OUTPUT,
  PAGES,
  build,
  codeSpanGenerics,
  convert,
  errorCodes,
  generate,
  omitEmpty,
  partsToMarkdown,
} from "../../tools/sdkref.mjs";
import { BASE, SEED } from "./net.js";

interface Param {
  name: string;
  type: string;
  default?: string;
  doc: string;
}
interface Member {
  anchor: string;
  kind: string;
  name: string;
  signature: string;
  doc: string;
  params?: Param[];
  returns?: { type: string; doc: string };
  operation?: string;
}
interface Type {
  anchor: string;
  kind: string;
  name: string;
  signature: string;
  doc: string;
  extends?: string[];
  code?: string;
  schema?: string;
  members?: Member[];
  params?: Param[];
  returns?: { type: string; doc: string };
  operation?: string;
}
interface Reference {
  format: string;
  language: string;
  package: string;
  version: string;
  install: string;
  links?: Record<string, string>;
  pages: { id: string; intro: string; types: Type[] }[];
}

const ROOT = process.cwd();
const ORDER = PAGES.map((p) => p.id);
const OPERATIONS = JSON.parse(
  readFileSync(join(ROOT, "tools", "sdkref-operations.json"), "utf8"),
) as Record<string, string>;

let text = "";
let ref: Reference;
const types = (): Type[] => ref.pages.flatMap((p) => p.types);
const members = (): [Type, Member][] =>
  types().flatMap((t) => (t.members ?? []).map((m): [Type, Member] => [t, m]));

beforeAll(async () => {
  text = await generate(ROOT);
  ref = JSON.parse(text) as Reference;
}, 120_000);

/** Markdown with its fenced blocks and code spans taken out. */
const prose = (md: string): string =>
  md.replace(/^```[\s\S]*?^```/gm, "").replace(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, "code");

describe("the TypeScript SDK reference is generated in format mfx-sdkref/1 from the package's public exports", () => {
  it("writes the head from package.json", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      version: string;
    };
    expect(ref.format).toBe("mfx-sdkref/1");
    expect(ref.language).toBe("typescript");
    expect(ref.package).toBe("@mfxhub/sdk");
    expect(ref.version).toBe(pkg.version);
    expect(ref.install).toBe("npm install @mfxhub/sdk");
    expect(ref.links?.["source"]).toBe("https://github.com/mfx-platform/mfx-sdk-typescript");
  });

  it("lists the pages in the format's order, each with its intro", () => {
    const ids = ref.pages.map((p) => p.id);
    expect(ids).toEqual(ORDER.filter((id) => ids.includes(id)));
    expect(ids).toEqual(ORDER);
    for (const page of ref.pages) expect(page.intro).not.toBe("");
  });

  it("gives every type and member a unique anchor under its page and type", () => {
    const seen = new Set<string>();
    for (const page of ref.pages) {
      for (const type of page.types) {
        expect(type.anchor).toBe(`${page.id}.${type.name}`);
        for (const m of type.members ?? []) {
          expect(m.anchor.startsWith(`${type.anchor}.`)).toBe(true);
          expect(m.anchor).toMatch(/^[a-z-]+\.[A-Za-z_]\w*\.[A-Za-z_]\w*$/);
        }
        for (const a of [type.anchor, ...(type.members ?? []).map((m) => m.anchor)]) {
          expect(seen.has(a), a).toBe(false);
          seen.add(a);
        }
      }
    }
  });

  it("documents every runtime export, and nothing private", () => {
    const names = new Set(types().map((t) => t.name));
    for (const name of Object.keys(sdk)) expect(names.has(name), name).toBe(true);
    for (const [, m] of members()) expect(m.name.startsWith("#")).toBe(false);
    for (const generated of ["components", "operations", "paths"]) {
      expect(names.has(generated)).toBe(false);
    }
  });

  it("writes kinds from the format and complete one-line signatures", () => {
    const typeKinds = [
      "class",
      "interface",
      "record",
      "enum",
      "error",
      "constant",
      "alias",
      "function",
    ];
    const memberKinds = ["method", "property", "field", "constructor", "value"];
    for (const t of types()) {
      expect(typeKinds).toContain(t.kind);
      expect(t.signature).not.toMatch(/\n|\.\.\.\s*[)\]},>]|…/);
    }
    for (const [, m] of members()) {
      expect(memberKinds).toContain(m.kind);
      expect(m.signature).not.toMatch(/\n|\.\.\.\s*[)\]},>]|…/);
    }
    const place = members().find(([t, m]) => t.name === "Execution" && m.name === "placeOrder");
    expect(place?.[1].signature).toBe(
      "placeOrder(terminalId: string, order: PlaceOrder): Promise<ExecutionResult>",
    );
    const side = types().find((t) => t.name === "Side");
    expect(side?.signature).toBe('type Side = "buy" | "sell"');
  });

  it("leaves an empty optional key out, keeping doc even when empty", () => {
    expect(text).not.toMatch(/: null|: \[\]|: \{\}/);
    expect(omitEmpty({ a: "", b: [], c: null, d: undefined, doc: "", e: 1 })).toEqual({
      doc: "",
      e: 1,
    });
  });
});

describe("doc comments become Markdown: links are [Name](#anchor), generics are code spans, tags fill their keys", () => {
  it("writes a resolving link for a listed target and a code span for any other", () => {
    const listed = { name: "deals" };
    const anchor = (target: unknown) => (target === listed ? "accounts.Accounts.deals" : undefined);
    const md = partsToMarkdown(
      [
        { kind: "text", text: "Read with " },
        { kind: "inline-tag", tag: "@link", text: "Accounts.deals", target: listed },
        { kind: "text", text: " or " },
        { kind: "inline-tag", tag: "@link", text: "Elsewhere", target: { name: "Elsewhere" } },
        { kind: "code", text: "`x`" },
      ],
      anchor,
    );
    expect(md).toBe("Read with [Accounts.deals](#accounts.Accounts.deals) or `Elsewhere``x`");
  });

  it("puts a generic in prose in a code span, and leaves code spans alone", () => {
    expect(codeSpanGenerics("returns Page<Deal> or `Promise<void>`")).toBe(
      "returns `Page<Deal>` or `Promise<void>`",
    );
    expect(codeSpanGenerics("a Map<string, Set<number>>[] here")).toBe(
      "a `Map<string, Set<number>>[]` here",
    );
  });

  it("resolves every cross-reference in the file, and leaves no doc-tool markup or angle bracket", () => {
    const anchors = new Set([
      ...types().map((t) => t.anchor),
      ...members().map(([, m]) => m.anchor),
    ]);
    const docs: string[] = [
      ...ref.pages.map((p) => p.intro),
      ...types().map((t) => t.doc),
      ...members().flatMap(([, m]) => [
        m.doc,
        m.returns?.doc ?? "",
        ...(m.params ?? []).map((p) => p.doc),
      ]),
    ];
    let links = 0;
    for (const doc of docs) {
      const text = prose(doc);
      for (const [, name, target] of text.matchAll(/\[([^\]]*)\]\(([^)]*)\)/g)) {
        links += 1;
        expect(name).not.toBe("");
        expect(anchors.has((target ?? "").slice(1)), target).toBe(true);
      }
      expect(text).not.toMatch(/\{@|[<>]/);
    }
    expect(links).toBeGreaterThan(50);
  });

  it("fills a parameter's doc from @param", () => {
    const ctor = members().find(
      ([t, m]) => t.name === "MfxClient" && m.kind === "constructor",
    )?.[1];
    expect(ctor?.params?.map((p) => p.name)).toEqual(["baseUrl", "keyId", "privateKey", "options"]);
    expect(ctor?.params?.[1]?.doc).toBe("the API key's id");
    expect(ctor?.params?.[3]?.default).toBe("{}");
  });

  it("describes a free function's call as a method's: parameters and return", () => {
    const fn = types().find((t) => t.name === "errorFor");
    expect(fn?.kind).toBe("function");
    expect(fn?.params?.map((p) => [p.name, p.type, p.default])).toEqual([
      ["code", "string", undefined],
      ["message", "string", undefined],
      ["status", "number", undefined],
      ["details", "Readonly<Record<string, unknown>>", "{}"],
      ["retryAfterS", "number | null", "null"],
    ]);
    expect(fn?.returns?.type).toBe("MfxApiError");
    for (const t of types()) {
      if (t.kind !== "function") {
        expect(t.params ?? t.returns ?? t.operation).toBeUndefined();
      }
    }
  });

  it("writes every default value in full, never cut short", () => {
    const defaults = [
      ...types().flatMap((t) => t.params ?? []),
      ...members().flatMap(([, m]) => m.params ?? []),
    ].flatMap((p) => (p.default === undefined ? [] : [p.default]));
    expect(defaults.length).toBeGreaterThan(10);
    for (const d of defaults) {
      expect(d).not.toBe("...");
      expect(d).not.toContain("\n");
    }
    const signer = members().find(
      ([t, m]) => t.name === "RequestSigner" && m.kind === "constructor",
    )?.[1];
    expect(signer?.params?.find((p) => p.name === "nonce")?.default).toBe(
      '() => randomBytes(16).toString("base64url")',
    );
  });
});

// --- The operation each method calls ---------------------------------------------------------------

const ID = "0191f0c2-aaaa-7bbb-8ccc-000000000001";
const KEY = "k-sdkref-1";

/** Every (method, path template, operationId) of the contract, from the generated types. */
function contractOperations(): { method: string; pattern: RegExp; operationId: string }[] {
  const api = readFileSync(join(ROOT, "src", "generated", "api.ts"), "utf8");
  const start = api.indexOf("export interface paths");
  const body = api.slice(start, api.indexOf("\n}\n", start));
  const out: { method: string; pattern: RegExp; operationId: string }[] = [];
  let path = "";
  for (const line of body.split("\n")) {
    const p = /^ {2}"([^"]+)": \{/.exec(line);
    if (p) path = p[1] ?? "";
    const op = /^ {4}(get|put|post|delete|patch): operations\["([^"]+)"\]/.exec(line);
    if (op) {
      const source = path
        .split(/\{[^}]+\}/)
        .map((piece) => piece.replace(/[.*+?^$()|[\]\\]/g, "\\$&"))
        .join("[^/]+");
      out.push({
        method: (op[1] ?? "").toUpperCase(),
        pattern: new RegExp(`^${source}$`),
        operationId: op[2] ?? "",
      });
    }
  }
  return out;
}

const NAMESPACE: Record<string, string> = {
  Terminals: "terminals",
  Execution: "execution",
  TradingAccounts: "tradingAccounts",
  Accounts: "accounts",
  Catalog: "catalog",
  MarketData: "md",
  Risk: "risk",
  Copy: "copy",
  Billing: "billing",
  Tenant: "tenant",
};

const ORDER_ARGS = { symbol: "EURUSD", side: "buy", volume: "0.01", idempotencyKey: KEY };
const WINDOW = { from: new Date("2026-01-01T00:00:00Z"), to: new Date("2026-01-02T00:00:00Z") };

/** Arguments for a method whose generic ones would be refused before anything is sent. */
const ARGS: Record<string, unknown[]> = {
  "Terminals.create": [{ brokerId: ID, serverId: ID, idempotencyKey: KEY }],
  "Terminals.bulkRestart": [{ reason: "nightly", terminalIds: [ID], idempotencyKey: KEY }],
  "Execution.placeOrder": [ID, ORDER_ARGS],
  "Execution.modifyOrder": [ID, 1, { price: "1.1", idempotencyKey: KEY }],
  "Execution.modifyPosition": [ID, 1, { sl: "1.1", idempotencyKey: KEY }],
  "Execution.closePositionPartial": [ID, 1, { volume: "0.01", idempotencyKey: KEY }],
  "Execution.closePositionBy": [ID, 1, { byTicket: 2, idempotencyKey: KEY }],
  "Execution.setTrailingStop": [ID, 1, { distance: "0.0020", idempotencyKey: KEY }],
  "Execution.waitFor": [ID],
  "Execution.getCommand": [ID],
  "TradingAccounts.placeOrder": [ID, ORDER_ARGS],
  "TradingAccounts.modifyOrder": [ID, 1, { price: "1.1", idempotencyKey: KEY }],
  "TradingAccounts.modifyPosition": [ID, 1, { sl: "1.1", idempotencyKey: KEY }],
  "TradingAccounts.closePositionPartial": [ID, 1, { volume: "0.01", idempotencyKey: KEY }],
  "TradingAccounts.closePositionBy": [ID, 1, { byTicket: 2, idempotencyKey: KEY }],
  "TradingAccounts.setTrailingStop": [ID, 1, { distance: "0.0020", idempotencyKey: KEY }],
  "TradingAccounts.dealsPage": [ID, WINDOW],
  "TradingAccounts.deals": [ID, WINDOW],
  "TradingAccounts.startCtraderGrant": [
    {
      environment: "demo",
      scope: "trading",
      returnUrl: "https://example.com/back",
      idempotencyKey: KEY,
    },
  ],
  "TradingAccounts.connectCtraderAccounts": [ID, [4321], { idempotencyKey: KEY }],
  "Accounts.dealsPage": [ID, WINDOW],
  "Accounts.deals": [ID, WINDOW],
  "Catalog.quote": [ID, "EURUSD"],
  "MarketData.subscribeAccount": [ID, "EURUSD", { idempotencyKey: KEY }],
  "MarketData.accountCandles": [ID, { symbol: "EURUSD", timeframe: "M1", ...WINDOW }],
  "Risk.activate": [ID, [ID], { version: 1, idempotencyKey: KEY }],
  "Risk.equity": [ID, new Date("2026-11-01T00:00:00Z")],
  "Risk.closeScope": [ID, "mfx_positions"],
  "Risk.deactivate": [ID, { reason: "closing", idempotencyKey: KEY }],
  "Risk.clear": [ID, "drawdown", { reason: "checked", idempotencyKey: KEY }],
  "Risk.check": [ID, { symbol: "EURUSD", side: "buy", type: "market", volume: "0.40" }],
  "Risk.pausePlan": [ID, { reason: "news", idempotencyKey: KEY }],
  "Risk.enrol": [ID, [ID], { idempotencyKey: KEY }],
  "Copy.createLeader": [{ source: "external", signalLifetimeS: 30, idempotencyKey: KEY }],
  "Copy.retireLeader": [ID, { closeCopied: false, reason: "closed", idempotencyKey: KEY }],
  "Copy.sendOpenSignal": [
    ID,
    { id: "s-1", symbol: "EURUSD", side: "buy", volume: "1", idempotencyKey: KEY },
  ],
  "Copy.sendCloseSignal": [ID, { id: "s-2", close: "s-1", idempotencyKey: KEY }],
  "Copy.createFollower": [
    {
      accountId: ID,
      leaderId: ID,
      scaling: { mode: "fixed_multiplier", multiplier: "1" },
      idempotencyKey: KEY,
    },
  ],
  "Copy.previewFollower": [
    {
      accountId: ID,
      leaderId: ID,
      scaling: { mode: "fixed_multiplier", multiplier: "1" },
      rows: [{ symbol: "EURUSD", volume: "1.00" }],
    },
  ],
  "Copy.unfollow": [ID, { closeCopied: true, idempotencyKey: KEY }],
  "Copy.resetStopouts": [ID, { reason: "raised", idempotencyKey: KEY }],
  "Copy.createGroup": [{ name: "Desk A", idempotencyKey: KEY }],
  "Copy.addGroupFollowers": [ID, [ID], { idempotencyKey: KEY }],
  "Copy.removeGroupFollowers": [ID, [ID], { idempotencyKey: KEY }],
  "Copy.closeGroup": [ID, { reason: "closing", pause: true, idempotencyKey: KEY }],
  "Copy.rolloverGroup": [ID, { dryRun: true }],
};

/** Generic arguments from a method's parameters: an id for a string, 1 for a number, a key for options. */
function argsFor(key: string, params: Param[]): unknown[] {
  const given = ARGS[key];
  if (given !== undefined) return given;
  return params.map((p) => {
    if (p.type === "string") return ID;
    if (p.type === "number") return 1;
    return { idempotencyKey: KEY };
  });
}

interface Sent {
  method: string;
  path: string;
}

/** The first request `call` sends, or what it threw before sending one. */
async function firstRequest(
  call: (client: MfxClient, sent: Sent[]) => unknown,
): Promise<Sent | string> {
  const sent: Sent[] = [];
  const fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    sent.push({ method: init?.method ?? "GET", path: url.pathname.replace(/^\/v1/, "") });
    return Promise.reject(new TypeError("fetch failed"));
  };
  const client = new MfxClient(BASE, "mfxk_TEST", SEED, {
    fetch,
    sleep: () => Promise.resolve(),
    readRetries: 0,
  });
  let thrown = "";
  try {
    const result = call(client, sent) as (Promise<unknown> & { next?: unknown }) | undefined;
    if (typeof result?.next === "function") {
      await (result as unknown as AsyncGenerator).next();
    } else {
      await result;
    }
  } catch (error) {
    thrown = String(error);
  }
  return sent[0] ?? `nothing sent: ${thrown}`;
}

describe("each method's operation is the contract operation whose request it sends", () => {
  it("matches every listed method to the request it sends", async () => {
    const contract = contractOperations();
    const params = new Map(members().map(([t, m]) => [`${t.name}.${m.name}`, m.params ?? []]));
    const wrong: string[] = [];
    for (const [key, operationId] of Object.entries(OPERATIONS)) {
      const [owner = "", name = ""] = key.split(".");
      const args = argsFor(key, params.get(key) ?? []);
      // The stream's upgrade is GET /stream on a WebSocket, not fetch: checked by its URL below.
      if (owner === "MfxClient" || owner === "MfxStream") continue;
      const first = await firstRequest((client) => {
        const target = (
          client as unknown as Record<string, Record<string, (...a: unknown[]) => unknown>>
        )[NAMESPACE[owner] ?? ""];
        return target?.[name]?.(...args);
      });
      if (typeof first === "string") {
        wrong.push(`${key}: ${first}`);
        continue;
      }
      const found = contract.find((c) => c.method === first.method && c.pattern.test(first.path));
      if (found?.operationId !== operationId) {
        wrong.push(`${key}: sent ${first.method} ${first.path} (${found?.operationId ?? "none"})`);
      }
    }
    expect(wrong).toEqual([]);
  }, 60_000);

  it("opens the stream with the contract's openStream", async () => {
    const urls: string[] = [];
    const client = new MfxClient(BASE, "mfxk_TEST", SEED, { sleep: () => Promise.resolve() });
    await client
      .stream({
        connect: (url) => {
          urls.push(url);
          return Promise.reject(new Error("closed"));
        },
        maxReconnects: 0,
      })
      .catch(() => undefined);
    const path = new URL(urls[0] ?? "wss://x/none").pathname.replace(/^\/v1/, "");
    const open = contractOperations().find((c) => c.method === "GET" && c.pattern.test(path));
    expect(open?.operationId).toBe("openStream");
    expect(OPERATIONS["MfxClient.stream"]).toBe("openStream");
    expect(OPERATIONS["MfxStream.open"]).toBe("openStream");
  });

  it("lists every method of an API namespace, and writes each one's operation into the file", () => {
    for (const [owner] of Object.entries(NAMESPACE)) {
      const type = types().find((t) => t.name === owner);
      for (const m of type?.members ?? []) {
        if (m.kind !== "method") continue;
        expect(OPERATIONS[`${owner}.${m.name}`], `${owner}.${m.name}`).toBeDefined();
        expect(m.operation).toBe(OPERATIONS[`${owner}.${m.name}`]);
      }
    }
  });
});

describe("docs/sdkref.json is committed clean and current, and published with the public tree", () => {
  it("is exactly what the source generates, every time", async () => {
    expect(readFileSync(join(ROOT, OUTPUT), "utf8")).toBe(text);
    expect(await generate(ROOT)).toBe(text);
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).not.toContain("\r");
  }, 120_000);

  it("holds no internal word", () => {
    expect(text).not.toMatch(/AB#|\bDEC-|\bMT5\b|-intern[a]l\b/);
    expect(text).not.toMatch(/\bcells?\b/i);
    expect(scan([[OUTPUT, text]], new Set())).toEqual([]);
  });

  it("refuses MT5 and cells in a reference file, not elsewhere", () => {
    expect(scan([[OUTPUT, '"doc": "an MT5 account"']], new Set())).toEqual([`${OUTPUT}:1: MT5`]);
    expect(scan([[OUTPUT, '"doc": "its cell"']], new Set())).toEqual([`${OUTPUT}:1: cell`]);
    expect(scan([[OUTPUT, '"type": "mt5Retcode"']], new Set())).toEqual([]);
    expect(match("an MT5 account", new Set())).toBeNull();
  });

  // The export tool is private; the public repository is what it writes.
  it.skipIf(!existsSync(join(ROOT, "tools", "export-public.mjs")))(
    "is published with its generator and the operation list",
    async () => {
      // Imported by URL, not a literal path: the public tree has no tools/export-public.mjs, and
      // its type check must not try to resolve it.
      const tool = pathToFileURL(join(ROOT, "tools", "export-public.mjs")).href;
      const { INCLUDE } = (await import(tool)) as {
        INCLUDE: string[];
      };
      for (const path of [OUTPUT, "tools/sdkref.mjs", "tools/sdkref-operations.json"]) {
        expect(INCLUDE).toContain(path);
      }
    },
  );

  it("rewrites the comment limit in the terminal's words", async () => {
    const client = new MfxClient(BASE, "mfxk_TEST", SEED, {
      fetch: () => Promise.reject(new Error("x")),
    });
    await expect(
      client.execution.placeOrder(ID, { ...ORDER_ARGS, side: "buy", comment: "x".repeat(32) }),
    ).rejects.toThrow(
      "comment is at most 31 characters; the terminal would cut a longer one (32 given)",
    );
  });
});

describe("every error class carries the API code the SDK maps to it", () => {
  it("writes each mapped class's code, and errorFor answers that class for it", () => {
    const errors = types().filter((t) => t.kind === "error");
    expect(errors.length).toBeGreaterThan(20);
    const withCode = errors.filter((t) => t.code !== undefined);
    expect(withCode.length).toBe(20);
    for (const t of withCode) {
      const made = sdk.errorFor(t.code ?? "", "m", 400);
      expect(made.constructor.name).toBe(t.name);
    }
    const names = new Set(withCode.map((t) => t.name));
    for (const base of [
      "MfxError",
      "MfxApiError",
      "PaymentRequiredError",
      "EdgeError",
      "StreamClosed",
    ]) {
      expect(names.has(base)).toBe(false);
    }
    for (const t of types()) if (t.kind !== "error") expect(t.code).toBeUndefined();
  });

  it("reads the code table from the source", () => {
    const codes = errorCodes(
      'const BY_CODE: X = { not_found: NotFoundError, "rate_limited": RateLimitError };',
    );
    expect([...codes]).toEqual([
      ["NotFoundError", "not_found"],
      ["RateLimitError", "rate_limited"],
    ]);
    expect(() => errorCodes("const BY_CODE = { a: A, b: A };")).toThrow(/maps two codes/);
  });
});

/**
 * The keys of components.schemas in the vendored contract, spec/openapi.yaml: a line scan of its
 * two-space block YAML, as the suite's checker reads it.
 */
function contractSchemas(): Set<string> {
  const names = new Set<string>();
  let section = "";
  for (const line of readFileSync(join(ROOT, "spec", "openapi.yaml"), "utf8").split(/\r?\n/)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) section = line.trimEnd() === "components:" ? "components" : "";
    else if (indent === 2 && section !== "") {
      section = line.trimEnd() === "  schemas:" ? "schemas" : "components";
    } else if (section === "schemas") {
      const key = /^ {4}(["']?)([A-Za-z][A-Za-z0-9_]*)\1:/.exec(line);
      if (key?.[2] !== undefined) names.add(key[2]);
    }
  }
  return names;
}

const typeNamed = (name: string): Type => {
  const found = types().find((t) => t.name === name);
  if (found === undefined) throw new Error(`no type ${name}`);
  return found;
};

describe("a type that is one contract object names its schema, read from the source", () => {
  it("names the schema of each alias of a generated contract type, case kept", () => {
    expect(typeNamed("Position").schema).toBe("Position");
    expect(typeNamed("Account").schema).toBe("Account");
    expect(typeNamed("Terminal").schema).toBe("TenantTerminal");
    expect(typeNamed("Quote").schema).toBe("SymbolQuote");
    expect(typeNamed("CatalogSymbol").schema).toBe("Symbol");
    expect(typeNamed("TradingAccount").schema).toBe("TradingAccount");
    expect(typeNamed("CtraderGrant").schema).toBe("CtraderGrant");
    expect(typeNamed("CtraderGrantStarted").schema).toBe("CtraderGrantStarted");
    expect(typeNamed("TerminalConditionChanged").schema).toBe("TerminalConditionChanged");
  });

  it("follows the module's own alias of the schemas, and an array's element", () => {
    // risk.ts and billing.ts write S["X"], copy.ts Schemas["X"].
    expect(typeNamed("RiskPolicy").schema).toBe("RiskPolicy");
    expect(typeNamed("BillingInvoice").schema).toBe("BillingInvoice");
    expect(typeNamed("CopyLeader").schema).toBe("CopyLeader");
    // Candle = CandleList["items"][number], an array of the contract's Candle.
    expect(typeNamed("Candle").schema).toBe("Candle");
  });

  it("names a string enum's schema when the enum is one", () => {
    expect(typeNamed("CommandState").schema).toBe("CommandState");
    expect(typeNamed("CopyReason").schema).toBe("CopyReason");
    expect(typeNamed("CopyVenue").schema).toBe("Venue");
  });

  it("names the schema of each hand-written type in the explicit list", () => {
    expect([...HAND_SCHEMAS]).toEqual([
      ["Tickets", "CommandTickets"],
      ["BillingAction", "BillingAction"],
      ["PlanChange", "PlanChangeSummary"],
    ]);
    for (const [name, schema] of HAND_SCHEMAS) expect(typeNamed(name).schema).toBe(schema);
  });

  it("names none for one property's inline type, a generic over a schema or an SDK type", () => {
    for (const name of [
      "TerminalState", // Terminal["state"]: one property's inline enum
      "Venue", // TradingAccount["venue"]: inline in the contract, not a reference to Venue
      "AccountEnvironment",
      "Redundancy",
      "Side",
      "CopyLeaderStats", // CopyLeaderPage["stats"]: inline
      "CopyPreviewRow",
      "LeaderFiltersInput", // Partial<CopyLeaderFilters>: not the schema itself
      "GroupTemplateInput",
      "CopyEvent",
      "StreamEvent",
      "Timeframe",
      "ExecutionResult", // the SDK's own answer, wider than any one schema
      "RiskRefusal",
      "DueDocument",
      "ClientOptions",
      "PlaceOrder",
    ]) {
      expect(typeNamed(name).schema, name).toBeUndefined();
    }
  });
});

describe("a client, an error, a helper or a function names no contract schema", () => {
  it("puts schema on aliases and interfaces only", () => {
    for (const t of types()) {
      if (!["alias", "interface"].includes(t.kind)) expect(t.schema, t.anchor).toBeUndefined();
      for (const m of t.members ?? []) expect("schema" in m, m.anchor).toBe(false);
    }
    for (const name of ["MfxClient", "Execution", "Terminals", "Copy", "Risk", "Page"]) {
      expect(typeNamed(name).schema, name).toBeUndefined();
    }
    // An error class whose name is also a schema's is still an error, not the object.
    expect(typeNamed("BillingPaymentRequiredError").kind).toBe("error");
    expect(typeNamed("BillingPaymentRequiredError").schema).toBeUndefined();
    for (const name of ["errorFor", "signingMessage", "isUsable", "copyEventOf"]) {
      expect(typeNamed(name).kind).toBe("function");
      expect(typeNamed(name).schema).toBeUndefined();
    }
  });
});

describe("every schema the reference names is a schema of the SDK's vendored contract", () => {
  it("names only schemas the contract has", () => {
    const contract = contractSchemas();
    expect(contract.size).toBeGreaterThan(100);
    const named = types().filter((t) => t.schema !== undefined);
    expect(named.length).toBeGreaterThan(90);
    for (const t of named) {
      expect(t.schema).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
      expect(contract.has(t.schema ?? ""), `${t.anchor}: ${String(t.schema)}`).toBe(true);
    }
  });

  it("writes schema after doc and before members, as the format orders the keys", () => {
    const keys = Object.keys(typeNamed("Tickets"));
    expect(keys.indexOf("schema")).toBeGreaterThan(keys.indexOf("doc"));
    expect(keys.indexOf("schema")).toBeLessThan(keys.indexOf("members"));
  });
});

describe("a hand-written schema entry that names no listed type fails the generation", () => {
  it("refuses an entry for a type that is not there, or is a class", async () => {
    const project = await convert(join(ROOT, "src", "index.ts"), join(ROOT, "tsconfig.build.json"));
    const operations = new Map(Object.entries(OPERATIONS));
    const codes = errorCodes(readFileSync(join(ROOT, "src", "errors.ts"), "utf8"));
    for (const name of ["NoSuchType", "MfxClient"]) {
      const schemas = new Map([...HAND_SCHEMAS, [name, "Account"]]);
      expect(() => {
        build(project, { operations, codes, schemas, head: undefined });
      }).toThrow(`sdkref: no alias or interface for ${name}`);
    }
  }, 120_000);
});
