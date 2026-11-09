// `client.terminals`: a tenant's terminals.
//
// The slice a tenant's first hour is made of: ask for a terminal, watch it reach ACTIVE, read it.
// Every write takes an idempotency key, and it has no default.
//
// DECISION: options are camelCase, as TypeScript callers write them, and what comes back is the
// API's own object, typed from the contract, with its field names as the API sends them
// (`state_since`, `created_at`). Renaming every field would put a hand-written copy of the
// contract between the caller and the API, and it would drift. The Page wrapper is the one
// exception, because it is the SDK's own type, not the API's.

import { idempotencyKey, limit as pageLimit, uuid } from "./arguments.js";
import type { MfxClient } from "./client.js";
import type { components, operations } from "./generated/api.js";
import { everyItem, pageOf, type Page } from "./pages.js";

/** A terminal, as the API describes it. */
export type Terminal = components["schemas"]["TenantTerminal"];
/** The states a terminal moves through. Only ACTIVE can be used; see {@link isUsable}. */
export type TerminalState = Terminal["state"];
/** How a terminal is replicated. */
export type Redundancy = components["schemas"]["TerminalCreate"]["redundancy"];

/** The states the list can be narrowed to, as the contract declares them. */
type ListState = NonNullable<
  NonNullable<operations["listTerminals"]["parameters"]["query"]>["state"]
>;

/** A terminal's journal: its lines newest first, and whether they were read live. */
export type TerminalJournal = components["schemas"]["TerminalJournal"];
/** One line of a terminal's MetaTrader journal. */
export type JournalLine = components["schemas"]["JournalLine"];

/** What {@link Terminals.journal} takes. */
export interface JournalOptions {
  /** How many lines, newest first: 1 to 200. The platform's default is 100. */
  readonly lines?: number;
}

/** Narrow a terminal list in the query, before the page is cut. */
export interface TerminalFilter {
  /** Only terminals carrying every one of these labels, by exact key and value. At most 10. */
  readonly labels?: Readonly<Record<string, string>>;
  /** Only terminals in one of these states. */
  readonly state?: ListState | ListState[number];
}

/** What {@link Terminals.create} takes. */
export interface CreateTerminal {
  /** The broker, from the catalogue. */
  readonly brokerId: string;
  /** The broker's server the terminal logs in to. */
  readonly serverId: string;
  /** Required: the same key sent again returns the same terminal, not a second one. */
  readonly idempotencyKey: string;
  /** Leave it out and the platform chooses a farm; the one it chose is on the answer. */
  readonly farmId?: string;
  readonly streaming?: boolean;
  readonly execution?: boolean;
  /** The broker's own symbol names (`EURUSD.sd`). */
  readonly instruments?: readonly string[];
  readonly labels?: Readonly<Record<string, string>>;
  readonly redundancy?: Redundancy;
}

/** What {@link Terminals.page} takes. */
export interface PageOptions extends TerminalFilter {
  /** The `nextCursor` of the page before; leave it out for the first page. */
  readonly cursor?: string;
  /** How many to a page, 1 to 200. */
  readonly limit?: number;
}

function labelQuery(labels: TerminalFilter["labels"]): string[] | undefined {
  if (labels === undefined) return undefined;
  const pairs = Object.entries(labels);
  if (pairs.length > 10) throw new RangeError("labels is at most 10 pairs");
  return pairs.map(([key, value]) => {
    if (key === "" || key.includes(":")) {
      throw new RangeError(`a label key is not empty and has no colon: ${JSON.stringify(key)}`);
    }
    if (typeof value !== "string") throw new TypeError(`label ${key} is a string`);
    if (key.length + 1 + value.length > 200) {
      throw new RangeError(`label ${key} is over 200 characters`);
    }
    return `${key}:${value}`;
  });
}

function stateQuery(state: TerminalFilter["state"]): string | undefined {
  if (state === undefined) return undefined;
  const states: readonly string[] = typeof state === "string" ? [state] : state;
  if (states.length === 0) throw new RangeError("state is one or more states; got none");
  return states.join(",");
}

/**
 * Can this terminal be used right now: market data, execution, account reads? True only in ACTIVE.
 * OFFLINE means its cell is not reporting; the platform brings it back by itself, so retry rather
 * than create another. QUEUED means it is placed and waiting for its turn to start: its cell
 * starts terminals a few at a time, and `queue.expected_start_at` says when to expect it.
 */
export function isUsable(terminal: Pick<Terminal, "state">): boolean {
  return terminal.state === "ACTIVE";
}

/** Where a QUEUED terminal waits: its place, its expected start and why it waits. */
export type TerminalQueue = components["schemas"]["TerminalQueue"];
/** A bulk restart or retire: what was taken, what was refused, and its expected finish. */
export type BulkAction = components["schemas"]["BulkAction"];

/** The states a terminal passes through on its way to ACTIVE; every other state is settled. */
const ON_ITS_WAY: ReadonlySet<string> = new Set([
  "REQUESTED",
  "QUEUED",
  "PROVISIONING",
  "LOGGING_IN",
]);
const POLL_FROM_MS = 2_000;
const POLL_CAP_MS = 15_000;
/** A QUEUED terminal is read again at its expected start, but never less often than this. */
const QUEUED_CAP_MS = 60_000;

/** What {@link Terminals.waitUntilActive} takes. */
export interface WaitOptions {
  /** How long to wait in all, in milliseconds. 15 minutes unless given. */
  readonly timeoutMs?: number;
}

/** Which of your terminals a bulk action takes, and why. At least one filter. */
export interface BulkAsk {
  /** Why; written to the audit log and to each item. */
  readonly reason: string;
  /** Required: the same key sent again returns the same action. */
  readonly idempotencyKey: string;
  readonly farmId?: string;
  readonly brokerId?: string;
  readonly terminalIds?: readonly string[];
  /** Without it, a terminal with open positions is refused and the rest are taken. */
  readonly confirmOpenPositions?: boolean;
}

function bulkBody(ask: BulkAsk): components["schemas"]["BulkTerminalAsk"] {
  if (typeof ask.reason !== "string" || ask.reason.trim() === "" || ask.reason.length > 500) {
    throw new RangeError("reason is 1 to 500 characters");
  }
  if (ask.farmId === undefined && ask.brokerId === undefined && ask.terminalIds === undefined) {
    throw new RangeError("a bulk action names farmId, brokerId or terminalIds");
  }
  if (ask.terminalIds !== undefined && ask.terminalIds.length > 1000) {
    throw new RangeError("terminalIds is at most 1000");
  }
  return {
    reason: ask.reason,
    confirm_open_positions: ask.confirmOpenPositions ?? false,
    ...(ask.farmId === undefined ? {} : { farm_id: uuid("farmId", ask.farmId) }),
    ...(ask.brokerId === undefined ? {} : { broker_id: uuid("brokerId", ask.brokerId) }),
    ...(ask.terminalIds === undefined
      ? {}
      : { terminal_ids: ask.terminalIds.map((id) => uuid("terminalIds", id)) }),
  };
}

/** How long to wait before the next read of a terminal still on its way. */
function nextWaitMs(terminal: Terminal, backoffMs: number, nowMs: number): number {
  const expected = terminal.state === "QUEUED" ? terminal.queue?.expected_start_at : undefined;
  if (typeof expected === "string") {
    const until = Date.parse(expected) - nowMs;
    if (Number.isFinite(until)) return Math.min(Math.max(until, POLL_FROM_MS), QUEUED_CAP_MS);
  }
  return Math.min(backoffMs, POLL_CAP_MS);
}

/** Provision and inspect the terminals this key's tenant owns. */
export class Terminals {
  readonly #client: MfxClient;

  constructor(client: MfxClient) {
    this.#client = client;
  }

  /** One terminal: its state, since when, and its observed conditions. Another tenant's is 404. */
  async get(terminalId: string): Promise<Terminal> {
    const id = uuid("terminalId", terminalId);
    return (await this.#client.read({ method: "GET", path: `/terminals/${id}` })) as Terminal;
  }

  /** One page of this tenant's terminals, newest first. One request. */
  async page(options: PageOptions = {}): Promise<Page<Terminal>> {
    const limit = pageLimit(options.limit);
    if (options.cursor !== undefined && typeof options.cursor !== "string") {
      throw new TypeError("cursor is the nextCursor of the page before");
    }
    const body = await this.#client.read({
      method: "GET",
      path: "/terminals",
      query: {
        cursor: options.cursor,
        limit,
        label: labelQuery(options.labels),
        state: stateQuery(options.state),
      },
    });
    return pageOf<Terminal>(body);
  }

  /**
   * Every terminal, following the cursor, one request a page. There is no total. `labels` and
   * `state` narrow the list on the platform, so a filtered page is never short for being filtered.
   */
  list(options: Omit<PageOptions, "cursor"> = {}): AsyncGenerator<Terminal, void, undefined> {
    const limit = pageLimit(options.limit);
    const rest: Omit<PageOptions, "cursor"> = {
      ...(limit === undefined ? {} : { limit }),
      ...(options.labels === undefined ? {} : { labels: options.labels }),
      ...(options.state === undefined ? {} : { state: options.state }),
    };
    return everyItem((cursor) =>
      this.page({ ...rest, ...(cursor === undefined ? {} : { cursor }) }),
    );
  }

  /**
   * The terminal's MetaTrader journal, newest first. While it runs the lines are read from its
   * cell (`from: "live"`); after it stops they are the last lines its cell kept, for 24 hours
   * (`from: "last_words"`). Account numbers are masked. A terminal with no lines held is 409.
   */
  async journal(terminalId: string, options: JournalOptions = {}): Promise<TerminalJournal> {
    const id = uuid("terminalId", terminalId);
    const lines = options.lines;
    if (lines !== undefined && (typeof lines !== "number" || !Number.isInteger(lines))) {
      throw new TypeError("lines is a whole number");
    }
    if (lines !== undefined && (lines < 1 || lines > 200)) {
      throw new RangeError(`lines is 1 to 200; got ${lines}`);
    }
    return (await this.#client.read({
      method: "GET",
      path: `/terminals/${id}/journal`,
      query: { lines },
    })) as TerminalJournal;
  }

  /**
   * Ask for a terminal. Answered at once in state REQUESTED; the move to a cell happens after.
   * Sent once and never retried: if the answer is lost, send the same idempotency key again.
   */
  async create(request: CreateTerminal): Promise<Terminal> {
    const key = idempotencyKey(request.idempotencyKey);
    const body: components["schemas"]["TerminalCreate"] = {
      broker_id: uuid("brokerId", request.brokerId),
      server_id: uuid("serverId", request.serverId),
      streaming: request.streaming ?? false,
      execution: request.execution ?? false,
      redundancy: request.redundancy ?? "none",
      ...(request.farmId === undefined ? {} : { farm_id: uuid("farmId", request.farmId) }),
      ...(request.instruments === undefined ? {} : { instruments: [...request.instruments] }),
      ...(request.labels === undefined ? {} : { labels: { ...request.labels } }),
    };
    return (await this.#client.write({
      method: "POST",
      path: "/terminals",
      body,
      idempotencyKey: key,
    })) as Terminal;
  }

  /**
   * Read the terminal until it is no longer on its way to ACTIVE (REQUESTED, QUEUED, PROVISIONING,
   * LOGGING_IN), or until `timeoutMs` has been waited. Returns the last read either way: ACTIVE,
   * a state it settled in instead (FAILED, for one), or still on its way when the time ran out.
   *
   * A QUEUED terminal is read again at its `queue.expected_start_at` (between 2 s and a minute
   * away), not on a fixed beat: its cell starts terminals a few at a time, so asking every two
   * seconds tells nothing new. Any other state is read again after 2 s, doubling to 15 s.
   */
  async waitUntilActive(terminalId: string, options: WaitOptions = {}): Promise<Terminal> {
    const timeoutMs = options.timeoutMs ?? 15 * 60_000;
    if (typeof timeoutMs !== "number" || !(timeoutMs >= 0)) {
      throw new RangeError("timeoutMs is 0 or more");
    }
    let waited = 0;
    let backoff = POLL_FROM_MS;
    let terminal = await this.get(terminalId);
    while (ON_ITS_WAY.has(terminal.state) && waited < timeoutMs) {
      const ms = Math.min(nextWaitMs(terminal, backoff, Date.now()), timeoutMs - waited);
      await this.#client.pause(ms);
      waited += ms;
      backoff *= 2;
      terminal = await this.get(terminalId);
    }
    return terminal;
  }

  /**
   * Restart many of your terminals at once. Each is judged by the rules of a single restart; a
   * refused one is listed in `refused` with its rule's code and the rest are taken. Each cell
   * carries its share at its own pace, so the terminals already running on it are not slowed.
   * Answered at once with the action and its expected finish; its items never expire.
   */
  async bulkRestart(ask: BulkAsk): Promise<BulkAction> {
    return this.#bulk("/terminals:restart", ask);
  }

  /** Retire many of your terminals at once, as {@link bulkRestart} restarts them. */
  async bulkRetire(ask: BulkAsk): Promise<BulkAction> {
    return this.#bulk("/terminals:retire", ask);
  }

  /** A bulk action's progress: counts per state, what was refused, and its expected finish. */
  async getBulkAction(bulkActionId: string): Promise<BulkAction> {
    const id = uuid("bulkActionId", bulkActionId);
    return (await this.#client.read({ method: "GET", path: `/bulk-actions/${id}` })) as BulkAction;
  }

  /** Cancel a bulk action: its waiting items are cancelled, running ones finish. */
  async cancelBulkAction(
    bulkActionId: string,
    options: { readonly idempotencyKey: string },
  ): Promise<BulkAction> {
    const id = uuid("bulkActionId", bulkActionId);
    return (await this.#client.write({
      method: "POST",
      path: `/bulk-actions/${id}/cancel`,
      idempotencyKey: idempotencyKey(options.idempotencyKey),
    })) as BulkAction;
  }

  async #bulk(path: string, ask: BulkAsk): Promise<BulkAction> {
    const key = idempotencyKey(ask.idempotencyKey);
    const body = bulkBody(ask);
    return (await this.#client.write({
      method: "POST",
      path,
      body,
      idempotencyKey: key,
    })) as BulkAction;
  }
}
