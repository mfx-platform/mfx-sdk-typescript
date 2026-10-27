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
import type { components } from "./generated/api.js";
import { everyItem, pageOf, type Page } from "./pages.js";

/** A terminal, as the API describes it. */
export type Terminal = components["schemas"]["TenantTerminal"];
/** The states a terminal moves through. Only ACTIVE can be used; see {@link isUsable}. */
export type TerminalState = Terminal["state"];
/** How a terminal is replicated. */
export type Redundancy = components["schemas"]["TerminalCreate"]["redundancy"];

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
export interface PageOptions {
  /** The `nextCursor` of the page before; leave it out for the first page. */
  readonly cursor?: string;
  /** How many to a page, 1 to 200. */
  readonly limit?: number;
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
      query: { cursor: options.cursor, limit },
    });
    return pageOf<Terminal>(body);
  }

  /** Every terminal, following the cursor, one request a page. There is no total. */
  list(options: Pick<PageOptions, "limit"> = {}): AsyncGenerator<Terminal, void, undefined> {
    const limit = pageLimit(options.limit);
    return everyItem((cursor) =>
      this.page({
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit }),
      }),
    );
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
