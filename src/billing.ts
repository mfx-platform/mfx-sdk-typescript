// `client.billing`: your organisation's billing, as an integration reads it (`billing:read`).
//
// Read only: the standing of each billing profile, its balance and month to date, the forecast to
// month end, the prices you pay, the public price list and your invoices. Top-ups, payment methods
// and profiles are changed in the portal, never here.
//
//     const summary = await client.billing.summary();
//     if (summary.standing.stage !== "ok") console.log(summary.standing.action);
//     for await (const invoice of client.billing.invoices({ state: "overdue" })) {
//       console.log(invoice.number, invoice.total_usd);
//     }
//
// Money stays exact: every amount is the contract's decimal string ("184.20") as the platform
// wrote it, never a number.
//
// A write anywhere else in the API can be refused for billing with `BillingPaymentRequiredError`
// (402); these reads never are.
//
// Invoices come two ways, as Risk Management's lists do: `invoicesPage` reads one page, and
// `invoices` follows the cursor to the end.

import { limit as pageLimit, uuid, words } from "./arguments.js";
import type { MfxClient } from "./client.js";
import type { components, operations } from "./generated/api.js";
import { everyItem, pageOf } from "./pages.js";

type S = components["schemas"];

/** The organisation's billing: every profile with its standing, and the most urgent at the top. */
export type BillingSummary = S["BillingSummary"];
/** One billing profile: its balance, today's daily charge, month to date and standing. */
export type BillingProfile = S["BillingProfile"];
/** A month for one billing profile, to date by product and forecast to month end. */
export type BillingForecast = S["BillingForecast"];
/** A price list: the public one, or the prices your organisation pays. */
export type BillingPriceList = S["BillingPriceList"];
/** One invoice, as a list shows it. */
export type BillingInvoice = S["BillingInvoice"];
/** One invoice in full: its summary by product, tax, what is matched and how to pay. */
export type BillingInvoiceDetail = S["BillingInvoiceDetail"];
/** A page of invoices. */
export type BillingInvoicePage = S["BillingInvoicePage"];
/** Where a billing profile stands on payment. */
export type BillingStanding = S["BillingStanding"];

/** An invoice's state, as the invoice list filters by it. */
export type InvoiceState = NonNullable<
  NonNullable<operations["listBillingInvoices"]["parameters"]["query"]>["state"]
>[number];

const INVOICE_STATES: readonly InvoiceState[] = [
  "issued",
  "due",
  "overdue",
  "settlement_in_progress",
  "part_settled",
  "settled",
  "void",
];

/** What {@link Billing.invoicesPage} takes. */
export interface InvoiceListOptions {
  /** Only this billing profile's invoices. */
  readonly billingProfileId?: string;
  /** One state, or several: sent comma-separated, checked here. */
  readonly state?: InvoiceState | readonly InvoiceState[];
  /** The `next_cursor` of the page before; leave it out for the first page. */
  readonly cursor?: string;
  /** How many to a page, 1 to 200 (50 when left out). */
  readonly limit?: number;
}

/**
 * Billing reads (`billing:read`; {@link Billing.priceList} needs no scope). Never refused for
 * billing: a suspended profile still reads its own standing.
 */
export class Billing {
  readonly #client: MfxClient;

  constructor(client: MfxClient) {
    this.#client = client;
  }

  async #read<T>(path: string, query?: Record<string, unknown>): Promise<T> {
    return (await this.#client.read({
      method: "GET",
      path,
      ...(query === undefined ? {} : { query: query as never }),
    })) as T;
  }

  /**
   * The public price list: the plans, every item with its monthly price, and `next`, the
   * following list once it is released.
   *
   * It needs no key. The SDK signs it as it signs every request, which the platform accepts and
   * ignores, so the same client reads it whatever its key's scopes.
   */
  async priceList(): Promise<BillingPriceList> {
    return this.#read("/price-list");
  }

  /**
   * The organisation's billing (`GET /billing`): every billing profile with its standing, and
   * `standing` at the top, the most urgent of theirs. {@link profile} reads one in full.
   */
  async summary(): Promise<BillingSummary> {
    return this.#read("/billing");
  }

  /** One billing profile: its balance, today's daily charge, month to date and standing. */
  async profile(profileId: string): Promise<BillingProfile> {
    return this.#read(`/billing/profiles/${uuid("profileId", profileId)}`);
  }

  /**
   * A month for one billing profile, to date by product and forecast to month end. `month` is
   * `YYYY-MM`, this month when left out; a past month gives its final figures.
   */
  async forecast(
    profileId: string,
    options: { readonly month?: string } = {},
  ): Promise<BillingForecast> {
    const id = uuid("profileId", profileId);
    return this.#read(`/billing/profiles/${id}/forecast`, { month: options.month });
  }

  /**
   * The prices your organisation pays, in the price list's shape: your Enterprise agreement's
   * (`scope` `tenant`) when one is in force, otherwise the list in force.
   */
  async prices(): Promise<BillingPriceList> {
    return this.#read("/billing/prices");
  }

  /** One invoice, with its summary by product, tax, what is matched and how to pay. */
  async invoice(invoiceId: string): Promise<BillingInvoiceDetail> {
    return this.#read(`/billing/invoices/${uuid("invoiceId", invoiceId)}`);
  }

  /**
   * One page of invoices, newest first, across your billing profiles. Pass the page's
   * `next_cursor` back as `cursor` for the next, until it is null.
   */
  async invoicesPage(options: InvoiceListOptions = {}): Promise<BillingInvoicePage> {
    const { billingProfileId } = options;
    return this.#read("/billing/invoices", {
      billing_profile_id:
        billingProfileId === undefined ? undefined : uuid("billingProfileId", billingProfileId),
      state: words("state", options.state, INVOICE_STATES),
      cursor: options.cursor,
      limit: pageLimit(options.limit),
    });
  }

  /**
   * Every invoice, newest first, following the cursor; narrowed as {@link invoicesPage} is.
   * `limit` is the page size, not a total.
   */
  invoices(
    options: Omit<InvoiceListOptions, "cursor"> = {},
  ): AsyncGenerator<BillingInvoice, void, undefined> {
    return everyItem(async (cursor) =>
      pageOf<BillingInvoice>(
        await this.invoicesPage({ ...options, ...(cursor === undefined ? {} : { cursor }) }),
      ),
    );
  }
}
