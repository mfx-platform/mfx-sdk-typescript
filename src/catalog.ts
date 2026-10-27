// `client.catalog`: what a tenant's brokers offer, and what it costs right now.
//
// This first slice is the quote. A quote is never returned without saying how old it is
// (`age_s`): a stale quote reads exactly like a live one and gets acted on. Its prices are the
// API's decimal strings, every digit kept.

import { uuid } from "./arguments.js";
import type { MfxClient } from "./client.js";
import type { components } from "./generated/api.js";

/** One symbol's current quote, with its age and whether the market can be traded. */
export type Quote = components["schemas"]["SymbolQuote"];

/** Which of a tenant's servers and account types a symbol is meant on. */
export interface QuoteOptions {
  /** Needed when the symbol is on more than one of your servers (409 `ambiguous_symbol`). */
  readonly serverId?: string;
  /** Needed when the symbol is listed under more than one account type on that server. */
  readonly accountType?: string;
}

/** The tenant's catalogue of brokers and symbols. */
export class Catalog {
  readonly #client: MfxClient;

  constructor(client: MfxClient) {
    this.#client = client;
  }

  /**
   * The current quote for one symbol, read from one of your terminals on that broker's server.
   * `state` says whether the market can be traded (`open`, `closed_session`, ...);
   * `broker_time` is the broker's own clock, which is not UTC.
   *
   * @param brokerId the broker, from the catalogue
   * @param symbol the broker's own symbol name (`EURUSD.sd`)
   */
  async quote(brokerId: string, symbol: string, options: QuoteOptions = {}): Promise<Quote> {
    const broker = uuid("brokerId", brokerId);
    if (typeof symbol !== "string" || symbol === "") {
      throw new TypeError("symbol is the broker's symbol name");
    }
    if (options.accountType !== undefined && typeof options.accountType !== "string") {
      throw new TypeError("accountType is the account type's name");
    }
    const body = await this.#client.read({
      method: "GET",
      path: `/brokers/${broker}/symbols/${encodeURIComponent(symbol)}/quote`,
      query: {
        server_id: options.serverId === undefined ? undefined : uuid("serverId", options.serverId),
        account_type: options.accountType,
      },
    });
    return body as Quote;
  }
}
