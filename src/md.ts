// `client.md`: market data by a cTrader account.
//
// An MT5 symbol streams from its broker server; a cTrader symbol streams from the account that
// holds it. The subscription is a resource: it exists at once, `pending` until the first spot
// arrives, and the spots then stream on `md:{accountId}:{symbol}` as `md.tick` (see
// `Channel.md`). One per account and symbol: asking again answers the live one, and asking after
// a stop reopens it. Two of your accounts at one broker and environment share one stream.
//
// An MT5 account is refused on all three routes with `StateError` (`details.reason` is
// `not_on_this_venue`): it streams its server, and its candles are its server's.
//
// DECISION: this namespace holds the cTrader account's routes only. The server-keyed market-data
// routes (`POST /md/subscriptions`, `GET /md/candles`) have no TypeScript method yet; `unsubscribe`
// is here because the contract stops an account subscription with `DELETE /md/subscriptions/{id}`
// and a subscription that could not be stopped would be a leak.

import { idempotencyKey, limit as pageLimit, uuid } from "./arguments.js";
import type { MfxClient } from "./client.js";
import type { Keyed } from "./execution.js";
import type { components } from "./generated/api.js";
import { everyItem, pageOf, type Page } from "./pages.js";
import type { Timeframe } from "./stream.js";

/** A cTrader account's market-data subscription: `pending` until its first spot. */
export type AccountMdSubscription = components["schemas"]["AccountMdSubscription"];
/** Bars, oldest first. */
export type CandleList = components["schemas"]["CandleList"];
/** One bar: `o`, `h`, `l`, `c` as decimal strings, `v` the tick volume, `ts` its open time. */
export type Candle = CandleList["items"][number];

const TIMEFRAMES: readonly string[] = [
  "M1",
  "M5",
  "M15",
  "M30",
  "H1",
  "H4",
  "D1",
  "W1",
  "MN1",
] satisfies readonly Timeframe[];

/** What {@link MarketData.accountSubscriptionsPage} takes. */
export interface AccountSubscriptionPageOptions {
  /** The `nextCursor` of the page before; leave it out for the first page. */
  readonly cursor?: string;
  /** How many to a page, 1 to 200. */
  readonly limit?: number;
}

/** What {@link MarketData.accountCandles} takes. */
export interface AccountCandlesOptions {
  /** The account's own name for the symbol, as `tradingAccounts.symbols` lists it. */
  readonly symbol: string;
  readonly timeframe: Timeframe;
  /** Start of the window, a Date. */
  readonly from: Date;
  /** End of the window, a Date. */
  readonly to: Date;
  /** At most this many bars, 1 to 1000; the newest of the window. The platform's default is 1000. */
  readonly limit?: number;
}

function instant(name: string, value: unknown): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${name} is a Date; a candles window has both ends`);
  }
  return value.toISOString();
}

function symbolName(value: unknown): string {
  if (typeof value !== "string" || value === "") {
    throw new TypeError("symbol is the account's own name for it, a non-empty string");
  }
  return value;
}

/** Subscribe to, list and read the market data of the cTrader accounts this tenant holds. */
export class MarketData {
  readonly #client: MfxClient;

  constructor(client: MfxClient) {
    this.#client = client;
  }

  /**
   * Stream one symbol's spots of one cTrader account (`md:write`). `symbol` is the account's own
   * name for it. Created at once, `pending` until the first spot. Sent once and never retried;
   * the same `idempotencyKey` again answers the same subscription. An MT5 account is a
   * `StateError` (`details.reason` `not_on_this_venue`); another tenant's, or none, is a
   * `NotFoundError`. Stop it with {@link MarketData.unsubscribe}.
   */
  async subscribeAccount(
    accountId: string,
    symbol: string,
    options: Keyed,
  ): Promise<AccountMdSubscription> {
    const id = uuid("accountId", accountId);
    const key = idempotencyKey(options.idempotencyKey);
    return (await this.#client.write({
      method: "POST",
      path: `/accounts/${id}/md/subscriptions`,
      body: { symbol: symbolName(symbol) },
      idempotencyKey: key,
    })) as AccountMdSubscription;
  }

  /** One page of an account's subscriptions, newest first (`md:read`). One request. */
  async accountSubscriptionsPage(
    accountId: string,
    options: AccountSubscriptionPageOptions = {},
  ): Promise<Page<AccountMdSubscription>> {
    const id = uuid("accountId", accountId);
    const limit = pageLimit(options.limit);
    if (options.cursor !== undefined && typeof options.cursor !== "string") {
      throw new TypeError("cursor is the nextCursor of the page before");
    }
    const body = await this.#client.read({
      method: "GET",
      path: `/accounts/${id}/md/subscriptions`,
      query: { cursor: options.cursor, limit },
    });
    return pageOf<AccountMdSubscription>(body);
  }

  /** Every subscription of an account, following the cursor, one request a page. */
  accountSubscriptions(
    accountId: string,
    options: { readonly limit?: number } = {},
  ): AsyncGenerator<AccountMdSubscription, void, undefined> {
    return everyItem((cursor) =>
      this.accountSubscriptionsPage(accountId, {
        ...options,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    );
  }

  /**
   * Stop a subscription, by id (`md:write`). The same call stops a server subscription and a
   * cTrader account's. Sent once and never retried.
   */
  async unsubscribe(subscriptionId: string, options: Keyed): Promise<void> {
    const id = uuid("subscriptionId", subscriptionId);
    const key = idempotencyKey(options.idempotencyKey);
    await this.#client.write({
      method: "DELETE",
      path: `/md/subscriptions/${id}`,
      idempotencyKey: key,
    });
  }

  /**
   * A cTrader account's bars for a window, oldest first, at most 1000 a call (`md:read`). The
   * bars are Spotware's trendbars for the account's own symbol name, in UTC; when the window
   * holds more than `limit` the answer is the newest of them, and the forming bar is included
   * when the window reaches now. Nothing is stored: each read goes through the account's runner
   * and counts against the same per-terminal limit a minute as the server-keyed read. A 429 is
   * retried after its `Retry-After` and thrown as `RateLimitError` once the retries run out; an
   * account with no runner connected is `UpstreamError` (503); an MT5 account is a `StateError`
   * (`not_on_this_venue`). No bar in the window is an empty list.
   */
  async accountCandles(accountId: string, options: AccountCandlesOptions): Promise<CandleList> {
    const id = uuid("accountId", accountId);
    const symbol = symbolName(options.symbol);
    if (!TIMEFRAMES.includes(options.timeframe)) {
      throw new RangeError(
        `timeframe is one of ${TIMEFRAMES.join(", ")}; got ${options.timeframe}`,
      );
    }
    const from = instant("from", options.from);
    const to = instant("to", options.to);
    if (options.to.getTime() < options.from.getTime()) {
      throw new RangeError("the candles window ends before it starts");
    }
    const { limit } = options;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) {
      throw new RangeError(`limit is a whole number from 1 to 1000; got ${String(limit)}`);
    }
    return (await this.#client.read({
      method: "GET",
      path: `/accounts/${id}/md/candles`,
      query: { symbol, tf: options.timeframe, from, to, limit },
    })) as CandleList;
  }
}
