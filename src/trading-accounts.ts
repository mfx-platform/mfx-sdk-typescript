// `client.tradingAccounts`: the tenant's trading accounts over every venue.
//
// One trading account is one account at one venue: an MT5 account (run by one terminal, or two with
// HA), and a cTrader account. An MT5 account takes its first terminal's id, and `get` also takes
// any of its terminals' ids. Its state is the venue-neutral word (CONNECTED, DEGRADED,
// REAUTH_NEEDED, ...); `client.terminals.get` has the MT5 detail.
//
// The same object trades an account and reads it on any venue: the nine commands of
// `client.execution` keyed on the account (`exec:write`), and its funds, positions, pending orders,
// deals and symbols (`acct:read`). The platform hands each to the account's lead runner. A cTrader
// account is connected through a grant: `startCtraderGrant` answers the consent link to send the
// trader to, `ctraderGrant` lists the accounts they shared, and `connectCtraderAccounts` makes the
// chosen ones trading accounts of yours (`term:write`).
//
// DECISION: a namespace of its own beside `client.accounts`, which stays what it was: the balance,
// positions and deals of a terminal's account. Folding the two together would give `accounts.get`
// two meanings.

import {
  Accounts,
  type Account,
  type Deal,
  type DealPageOptions,
  type DealWindow,
  type PendingOrderList,
  type PositionList,
} from "./accounts.js";
import { idempotencyKey, limit as pageLimit, uuid } from "./arguments.js";
import type { MfxClient } from "./client.js";
import {
  Execution,
  type ClosePosition,
  type ClosePositionBy,
  type ClosePositionPartial,
  type Keyed,
  type ModifyOrder,
  type ModifyPosition,
  type PlaceOrder,
  type SetTrailingStop,
} from "./execution.js";
import type { components } from "./generated/api.js";
import { everyItem, pageOf, type Page } from "./pages.js";
import type { ExecutionResult } from "./results.js";

/** One trading account at one venue, as the API describes it. */
export type TradingAccount = components["schemas"]["TradingAccount"];
/** The trading technology an account is on. */
export type Venue = TradingAccount["venue"];
/** An account's state, in words that hold on every venue. */
export type AccountState = TradingAccount["state"];
/** Live or demo. */
export type AccountEnvironment = NonNullable<TradingAccount["environment"]>;

/** The symbols one cTrader account can trade, with their volume rules in lots and leverage. */
export type TradingSymbolList = components["schemas"]["TradingSymbolList"];
/** One symbol of a cTrader account. */
export type TradingSymbol = components["schemas"]["TradingSymbol"];
/** A cTrader grant: its state and, once ACTIVE, the accounts the trader shared. */
export type CtraderGrant = components["schemas"]["CtraderGrant"];
/** A started grant: the consent link to send the trader to, and until when it works. */
export type CtraderGrantStarted = components["schemas"]["CtraderGrantStarted"];
/** What a grant lets MFX Hub do: `accounts` reads only, `trading` reads and trades. */
export type GrantScope = components["schemas"]["CtraderGrantCreate"]["scope"];

/** What {@link TradingAccounts.startCtraderGrant} takes. */
export interface StartCtraderGrant {
  /** One grant covers live or demo accounts. */
  readonly environment: AccountEnvironment;
  readonly scope: GrantScope;
  /** Where the trader comes back to, https only, with `grant_id`, `result` and your state. */
  readonly returnUrl: string;
  /** Your own value, returned unchanged on the return URL; never read by MFX Hub. */
  readonly tenantState?: string;
  readonly idempotencyKey: string;
}

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

/** Read, trade and connect the trading accounts this key's tenant holds. */
export class TradingAccounts {
  readonly #client: MfxClient;
  readonly #orders: Execution;
  readonly #reads: Accounts;

  constructor(client: MfxClient) {
    this.#client = client;
    this.#orders = new Execution(client, "accounts");
    this.#reads = new Accounts(client, "accounts");
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

  // ------------------------------------------------------------------------------------- reads

  /**
   * Balance, equity, margin and profile, answered by the account's lead runner. On cTrader the
   * equity is computed by the platform (the venue sends none); `stale` says when it could not be.
   */
  async funds(accountId: string): Promise<Account> {
    return this.#reads.account(accountId);
  }

  /** Every open position, as one snapshot. On cTrader `volume` is in lots. */
  async positions(accountId: string): Promise<PositionList> {
    return this.#reads.positions(accountId);
  }

  /** Every pending order, as one snapshot. */
  async pendingOrders(accountId: string): Promise<PendingOrderList> {
    return this.#reads.pendingOrders(accountId);
  }

  /**
   * One page of deals inside a window of at most 31 days, newest first, optionally of one
   * position. On cTrader every time is UTC and `magic` is the order's origin marker.
   */
  async dealsPage(accountId: string, options: DealPageOptions): Promise<Page<Deal>> {
    return this.#reads.dealsPage(accountId, options);
  }

  /** Every deal inside the window, following the cursor, one request a page. */
  deals(accountId: string, window: DealWindow): AsyncGenerator<Deal, void, undefined> {
    return this.#reads.deals(accountId, window);
  }

  /**
   * The symbols a cTrader account can trade: a volume a command sends must be a whole
   * `volume_step` between `volume_min` and `volume_max`, in lots. An MT5 account is refused.
   */
  async symbols(accountId: string): Promise<TradingSymbolList> {
    const id = uuid("accountId", accountId);
    const path = `/accounts/${id}/symbols`;
    return (await this.#client.read({ method: "GET", path })) as TradingSymbolList;
  }

  // ---------------------------------------------------------------------------------- commands
  // The same bodies and rules as `client.execution`, sent to /accounts/{id}/...: each resolves to
  // a result and never rejects. Read the outcome with `client.execution.waitFor`.

  /**
   * Place a market or pending order on the account. `volume` is in lots on every venue, and on
   * cTrader a whole step of the symbol (`symbols`). On cTrader `magic` stays on the order as its
   * label, and a market order's stops are set just after the fill (`protectionNotSet` says when
   * that failed).
   */
  async placeOrder(accountId: string, order: PlaceOrder): Promise<ExecutionResult> {
    return this.#orders.placeOrder(accountId, order);
  }

  /** Amend a pending order's price, stops or expiry. */
  async modifyOrder(
    accountId: string,
    ticket: number,
    change: ModifyOrder,
  ): Promise<ExecutionResult> {
    return this.#orders.modifyOrder(accountId, ticket, change);
  }

  /** Cancel a pending order. */
  async cancelOrder(accountId: string, ticket: number, options: Keyed): Promise<ExecutionResult> {
    return this.#orders.cancelOrder(accountId, ticket, options);
  }

  /** Move a position's stop loss, take profit, or both. */
  async modifyPosition(
    accountId: string,
    ticket: number,
    change: ModifyPosition,
  ): Promise<ExecutionResult> {
    return this.#orders.modifyPosition(accountId, ticket, change);
  }

  /** Close a position in full. */
  async closePosition(
    accountId: string,
    ticket: number,
    options: ClosePosition,
  ): Promise<ExecutionResult> {
    return this.#orders.closePosition(accountId, ticket, options);
  }

  /** Close part of a position, in lots. */
  async closePositionPartial(
    accountId: string,
    ticket: number,
    options: ClosePositionPartial,
  ): Promise<ExecutionResult> {
    return this.#orders.closePositionPartial(accountId, ticket, options);
  }

  /**
   * Close a position against an opposite one. cTrader has no close-by: it is done as two closes,
   * the result says `closeByEmulated` and `deals` holds both.
   */
  async closePositionBy(
    accountId: string,
    ticket: number,
    options: ClosePositionBy,
  ): Promise<ExecutionResult> {
    return this.#orders.closePositionBy(accountId, ticket, options);
  }

  /** Trail a position's stop loss. A venue without a trailing stop refuses it, as a result. */
  async setTrailingStop(
    accountId: string,
    ticket: number,
    options: SetTrailingStop,
  ): Promise<ExecutionResult> {
    return this.#orders.setTrailingStop(accountId, ticket, options);
  }

  /** Remove a position's trailing stop. */
  async clearTrailingStop(
    accountId: string,
    ticket: number,
    options: Keyed,
  ): Promise<ExecutionResult> {
    return this.#orders.clearTrailingStop(accountId, ticket, options);
  }

  // ----------------------------------------------------------------------------- cTrader grants

  /**
   * Start connecting a trader's cTrader accounts; resolves to the consent link to send them to.
   * They sign in at cTrader (MFX Hub never sees the password), choose the accounts to share and
   * come back to `returnUrl`. The link lives 15 minutes. A plan without cTrader is forbidden.
   */
  async startCtraderGrant(grant: StartCtraderGrant): Promise<CtraderGrantStarted> {
    const key = idempotencyKey(grant.idempotencyKey);
    if (typeof grant.returnUrl !== "string" || !grant.returnUrl.startsWith("https://")) {
      throw new TypeError("returnUrl is an https:// URL");
    }
    const body = {
      environment: grant.environment,
      scope: grant.scope,
      return_url: grant.returnUrl,
      ...(grant.tenantState === undefined ? {} : { tenant_state: grant.tenantState }),
    };
    return (await this.#client.write({
      method: "POST",
      path: "/accounts/ctrader/grants",
      body,
      idempotencyKey: key,
    })) as CtraderGrantStarted;
  }

  /** One grant: PENDING, ACTIVE, REVOKED or EXPIRED, and once ACTIVE the accounts shared. */
  async ctraderGrant(grantId: string): Promise<CtraderGrant> {
    const id = uuid("grantId", grantId);
    const path = `/accounts/ctrader/grants/${id}`;
    return (await this.#client.read({ method: "GET", path })) as CtraderGrant;
  }

  /**
   * Make some of an ACTIVE grant's accounts trading accounts of yours, by cTrader's ids (1 to
   * 50). Each starts PENDING and is CONNECTED once authorised at cTrader.
   */
  async connectCtraderAccounts(
    grantId: string,
    ctidTraderAccountIds: readonly (string | number)[],
    options: Keyed,
  ): Promise<TradingAccount[]> {
    const id = uuid("grantId", grantId);
    const key = idempotencyKey(options.idempotencyKey);
    const ids = ctidTraderAccountIds.map(String);
    if (ids.length === 0) throw new RangeError("connect at least one account");
    const body = (await this.#client.write({
      method: "POST",
      path: `/accounts/ctrader/grants/${id}/accounts`,
      body: { ctid_trader_account_ids: ids },
      idempotencyKey: key,
    })) as { readonly items: TradingAccount[] };
    return body.items;
  }

  /** Revoke a grant: its accounts move to REAUTH_NEEDED; a new grant reconnects them. */
  async revokeCtraderGrant(grantId: string, options: Keyed): Promise<CtraderGrant> {
    const id = uuid("grantId", grantId);
    return (await this.#client.write({
      method: "DELETE",
      path: `/accounts/ctrader/grants/${id}`,
      idempotencyKey: idempotencyKey(options.idempotencyKey),
    })) as CtraderGrant;
  }
}
