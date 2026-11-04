// `client.accounts`: what a terminal's trading account holds.
//
// The account, its open positions and its pending orders are read from the terminal's latest
// snapshot, each with its `as_of`: a change made a moment ago can take a few seconds to show, so
// read again rather than treat its absence as a failure. Closed deals are history: read inside a
// window, a page at a time.
//
// As elsewhere in the SDK, what comes back is the API's own object, typed from the contract, with
// its field names as the API sends them.

import { limit as pageLimit, uuid } from "./arguments.js";
import type { MfxClient } from "./client.js";
import type { components } from "./generated/api.js";
import { everyItem, pageOf, type Page } from "./pages.js";

/** The account's figures: balance, equity, margin, as of its latest snapshot. */
export type Account = components["schemas"]["Account"];
/** Every open position, as one snapshot with its `as_of`. */
export type PositionList = components["schemas"]["PositionList"];
/** One open position. */
export type Position = components["schemas"]["Position"];
/** Every pending order, as one snapshot with its `as_of`. */
export type PendingOrderList = components["schemas"]["PendingOrderList"];
/** One pending order. */
export type PendingOrder = components["schemas"]["PendingOrder"];
/** One closed deal. */
export type Deal = components["schemas"]["Deal"];

/** The window {@link Accounts.deals} reads. Both ends are required. */
export interface DealWindow {
  readonly from: Date;
  readonly to: Date;
  /** Only the deals of this position. */
  readonly position?: number;
  /** How many to a page, 1 to 200. */
  readonly limit?: number;
}

/** What {@link Accounts.dealsPage} takes. */
export interface DealPageOptions extends DealWindow {
  /** The `nextCursor` of the page before; leave it out for the first page. */
  readonly cursor?: string;
}

function instant(name: string, value: unknown): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${name} is a Date; a deals window has both ends`);
  }
  return value.toISOString();
}

/** Read the trading account behind a terminal: figures, positions, pending orders and deals. */
export class Accounts {
  readonly #client: MfxClient;

  constructor(client: MfxClient) {
    this.#client = client;
  }

  /** The account's figures. Another tenant's terminal is not found. */
  async account(terminalId: string): Promise<Account> {
    const id = uuid("terminalId", terminalId);
    return (await this.#client.read({
      method: "GET",
      path: `/terminals/${id}/account`,
    })) as Account;
  }

  /** Every open position, as one snapshot with its `as_of`. */
  async positions(terminalId: string): Promise<PositionList> {
    const id = uuid("terminalId", terminalId);
    const path = `/terminals/${id}/positions`;
    return (await this.#client.read({ method: "GET", path })) as PositionList;
  }

  /** Every pending order, as one snapshot with its `as_of`. */
  async pendingOrders(terminalId: string): Promise<PendingOrderList> {
    const id = uuid("terminalId", terminalId);
    const path = `/terminals/${id}/orders/pending`;
    return (await this.#client.read({ method: "GET", path })) as PendingOrderList;
  }

  /**
   * One page of closed deals inside a window, newest first. The window is required, by the API
   * and so by this: an unbounded history read is the query that takes a database down.
   */
  async dealsPage(terminalId: string, options: DealPageOptions): Promise<Page<Deal>> {
    const id = uuid("terminalId", terminalId);
    const from = instant("from", options.from);
    const to = instant("to", options.to);
    if (options.to.getTime() < options.from.getTime()) {
      throw new RangeError("the deals window ends before it starts");
    }
    if (options.cursor !== undefined && typeof options.cursor !== "string") {
      throw new TypeError("cursor is the nextCursor of the page before");
    }
    if (
      options.position !== undefined &&
      (!Number.isSafeInteger(options.position) || options.position < 1)
    ) {
      throw new TypeError("position is a positive whole number, the position's ticket");
    }
    const body = await this.#client.read({
      method: "GET",
      path: `/terminals/${id}/history/deals`,
      query: {
        from,
        to,
        position: options.position,
        cursor: options.cursor,
        limit: pageLimit(options.limit),
      },
    });
    return pageOf<Deal>(body);
  }

  /** Every closed deal inside the window, following the cursor, one request a page. */
  deals(terminalId: string, window: DealWindow): AsyncGenerator<Deal, void, undefined> {
    return everyItem((cursor) =>
      this.dealsPage(terminalId, { ...window, ...(cursor === undefined ? {} : { cursor }) }),
    );
  }
}
