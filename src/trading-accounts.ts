// `client.tradingAccounts`: the tenant's trading accounts over every venue.
//
// One trading account is one account at one venue: an MT5 account (run by one terminal, or two with
// HA), and from the cTrader release a cTrader account. An MT5 account's id is its terminal's id, so
// an id you already hold reads its account, and `get` also takes either HA terminal's id. Its state
// is the venue-neutral word (CONNECTED, DEGRADED, REAUTH_NEEDED, ...); `client.terminals.get` has
// the MT5 detail.
//
// DECISION: a namespace of its own beside `client.accounts`, which stays what it was: the balance,
// positions and deals of a terminal's account. Folding the two together would give `accounts.get`
// two meanings.

import { limit as pageLimit, uuid } from "./arguments.js";
import type { MfxClient } from "./client.js";
import type { components } from "./generated/api.js";
import { everyItem, pageOf, type Page } from "./pages.js";

/** One trading account at one venue, as the API describes it. */
export type TradingAccount = components["schemas"]["TradingAccount"];
/** The trading technology an account is on. */
export type Venue = TradingAccount["venue"];
/** An account's state, in words that hold on every venue. */
export type AccountState = TradingAccount["state"];
/** Live or demo. */
export type AccountEnvironment = NonNullable<TradingAccount["environment"]>;

/** Narrow the list on the platform, before the page is cut. */
export interface TradingAccountFilter {
  /** Only accounts on this venue, or on one of these. */
  readonly venue?: Venue | readonly Venue[];
  /** Only live, or only demo, accounts. */
  readonly environment?: AccountEnvironment;
  /** Only accounts in this state, or in one of these. */
  readonly state?: AccountState | readonly AccountState[];
}

/** What {@link TradingAccounts.page} takes. */
export interface TradingAccountPageOptions extends TradingAccountFilter {
  /** The `nextCursor` of the page before; leave it out for the first page. */
  readonly cursor?: string;
  /** How many to a page, 1 to 200. */
  readonly limit?: number;
}

function joined(name: string, value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  const words: readonly string[] = typeof value === "string" ? [value] : value;
  if (words.length === 0) throw new RangeError(`${name} is one or more values; got none`);
  for (const word of words) {
    if (typeof word !== "string" || word === "") throw new TypeError(`${name} is a list of words`);
  }
  return words.join(",");
}

/** Read the trading accounts this key's tenant holds. Needs `acct:read`. */
export class TradingAccounts {
  readonly #client: MfxClient;

  constructor(client: MfxClient) {
    this.#client = client;
  }

  /**
   * One trading account, by its own id or by one of its terminals' ids. Another tenant's, or an id
   * that is not an account of yours, is 404.
   */
  async get(accountId: string): Promise<TradingAccount> {
    const id = uuid("accountId", accountId);
    return (await this.#client.read({ method: "GET", path: `/accounts/${id}` })) as TradingAccount;
  }

  /** One page of this tenant's trading accounts, newest first. One request. */
  async page(options: TradingAccountPageOptions = {}): Promise<Page<TradingAccount>> {
    const limit = pageLimit(options.limit);
    if (options.cursor !== undefined && typeof options.cursor !== "string") {
      throw new TypeError("cursor is the nextCursor of the page before");
    }
    if (options.environment !== undefined && typeof options.environment !== "string") {
      throw new TypeError("environment is live or demo");
    }
    const body = await this.#client.read({
      method: "GET",
      path: "/accounts",
      query: {
        cursor: options.cursor,
        limit,
        venue: joined("venue", options.venue),
        environment: options.environment,
        state: joined("state", options.state),
      },
    });
    return pageOf<TradingAccount>(body);
  }

  /**
   * Every trading account, following the cursor, one request a page. There is no total. The
   * filters narrow the list on the platform, so a filtered page is never short for being filtered.
   */
  list(
    options: Omit<TradingAccountPageOptions, "cursor"> = {},
  ): AsyncGenerator<TradingAccount, void, undefined> {
    const limit = pageLimit(options.limit);
    const rest: Omit<TradingAccountPageOptions, "cursor"> = {
      ...(limit === undefined ? {} : { limit }),
      ...(options.venue === undefined ? {} : { venue: options.venue }),
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(options.state === undefined ? {} : { state: options.state }),
    };
    return everyItem((cursor) =>
      this.page({ ...rest, ...(cursor === undefined ? {} : { cursor }) }),
    );
  }
}
