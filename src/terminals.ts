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
 * than create another.
 */
export function isUsable(terminal: Pick<Terminal, "state">): boolean {
  return terminal.state === "ACTIVE";
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
}
