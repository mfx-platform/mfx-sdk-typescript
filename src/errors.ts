/**
 * Every failure a read can raise, typed by the platform's `error.code`.
 *
 * The code decides; the HTTP status only when the code is one this version does not know, so a
 * code the platform adds later still arrives as a typed error rather than failing the caller.
 * Execution methods never raise: they return an `ExecutionResult` instead.
 */

/** Every failure this SDK raises. */
export class MfxError extends Error {
  override name = "MfxError";
}

/**
 * The request never got an answer: DNS, TCP, TLS, a dropped connection.
 *
 * `mayHaveReached` is false only when the connection never opened, so nothing was sent. A
 * connection that dropped after the request was written may have delivered it.
 */
export class MfxTransportError extends MfxError {
  override name = "MfxTransportError";

  constructor(
    message: string,
    readonly mayHaveReached = true,
  ) {
    super(message);
  }
}

/** No answer in time. Never retried: the request may have arrived. */
export class MfxTimeout extends MfxTransportError {
  override name = "MfxTimeout";
}

/** The platform answered with an error. */
export class MfxApiError extends MfxError {
  override name = "MfxApiError";

  constructor(
    message: string,
    /** The HTTP status; 0 for an error sent on the stream. */
    readonly status: number,
    /** The platform's error code, as it arrived. */
    readonly code: string,
    /** What the platform said about it, such as the field that was wrong. */
    readonly details: Readonly<Record<string, unknown>> = {},
    /** How long the platform asked the caller to wait, from Retry-After. */
    readonly retryAfterS: number | null = null,
  ) {
    super(message);
  }
}

/** The request cannot be taken as it was sent; `details` says which part. */
export class ValidationError extends MfxApiError {
  override name = "ValidationError";
}
/**
 * What a Risk Management refusal names: the rule, the figures and the policy or challenge behind it,
 * as a refusal's details and a copy refusal's `risk` carry them.
 */
export interface RiskRefusal {
  readonly reason: string;
  readonly rule: string | null;
  /** The policy whose rule refused it; null when a challenge's rule did. */
  readonly policyId: string | null;
  readonly version: number | null;
  /** The challenge whose rule refused it; null when a policy's rule did. */
  readonly challengeId: string | null;
  readonly challengeVersion: number | null;
  /** Figures as the platform wrote them, in the account's currency. */
  readonly used: string | null;
  readonly limit: string | null;
  readonly wouldBe: string | null;
}

function textOrNull(value: unknown): string | null {
  if (typeof value === "string") return value === "" ? null : value;
  return typeof value === "number" ? String(value) : null;
}

function wholeOrNull(value: unknown): number | null {
  if (typeof value === "boolean" || value === undefined || value === null || value === "") {
    return null;
  }
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

/**
 * A new entry broke a Risk Management rule in force on the account (422 `risk_refused`); nothing
 * was sent to the broker. Send a smaller entry, add a stop, or wait for the inputs to be fresh
 * (`risk_inputs_stale`) or for the window to open.
 */
export class RiskRefusedError extends ValidationError {
  override name = "RiskRefusedError";

  /** What refused the entry, read from `details`. */
  get refusal(): RiskRefusal {
    const d = this.details;
    return {
      reason: textOrNull(d["reason"]) ?? "risk_refused",
      rule: textOrNull(d["rule"]),
      policyId: textOrNull(d["policy_id"]),
      version: wholeOrNull(d["version"]),
      challengeId: textOrNull(d["challenge_id"]),
      challengeVersion: wholeOrNull(d["challenge_version"]),
      used: textOrNull(d["used"]),
      limit: textOrNull(d["limit"]),
      wouldBe: textOrNull(d["would_be"]),
    };
  }
}

/** The request is not signed by a key the platform knows. */
export class AuthError extends MfxApiError {
  override name = "AuthError";
}
/** The key may not do this. */
export class ForbiddenError extends MfxApiError {
  override name = "ForbiddenError";
}
/**
 * A change that relaxes protection, made without `risk:override` and a reason (403
 * `risk_override_required`). Nothing was changed.
 */
export class RiskOverrideRequiredError extends ForbiddenError {
  override name = "RiskOverrideRequiredError";
}
/** The operator has disabled the tenant. */
export class TenantDisabledError extends ForbiddenError {
  override name = "TenantDisabledError";
}
/** The operator has suspended the tenant. */
export class TenantSuspendedError extends ForbiddenError {
  override name = "TenantSuspendedError";
}
/** A planned maintenance window; `details.ends_at` says when it ends. */
export class MaintenanceError extends ForbiddenError {
  override name = "MaintenanceError";
}
/**
 * 402: a payment is missing. Not retryable unchanged: it ends when someone pays.
 *
 * `BillingPaymentRequiredError` is the one the platform sends to an API key; a 402 whose code this
 * version does not know arrives as this class, by its status, with its code kept.
 */
export class PaymentRequiredError extends MfxApiError {
  override name = "PaymentRequiredError";
}

/** What clears a billing standing (the contract's `BillingAction`). */
export interface BillingAction {
  /** `top_up` or `pay_invoice`; read a word you do not know as text. */
  readonly kind: string;
  /**
   * The portal page that does it, relative to the portal's address (`/billing/top-up`): join it
   * to the portal's address to give a person a link.
   */
  readonly portalPath: string;
  /** At least this much clears it, in USD: the decimal string the platform wrote, never a number. */
  readonly amountUsd: string | null;
  /** The invoice to pay; null for a top-up. */
  readonly invoiceId: string | null;
}

const DECIMAL_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/** A decimal the platform wrote, kept exactly as written; anything that is not one reads as null. */
function amountOrNull(value: unknown): string | null {
  return typeof value === "string" && DECIMAL_TEXT.test(value) ? value : null;
}

/** A word the platform wrote; anything else reads as null. */
function wordOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** A moment the platform wrote; one that is missing or cannot be read is null. */
function timeOrNull(value: unknown): Date | null {
  if (typeof value !== "string" || value === "") return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * 402 `billing_payment_required`: a payment is missing on the billing profile the request falls
 * under, and nothing was done.
 *
 * It is **not retryable**: sending the same request again changes nothing until the payment is
 * made. At `stage` `reminder` it comes only from a request that adds something billed (a new
 * account, an add-on switched on). Once `stage` is `suspended` it can come from **any write** on
 * the tenant or the profile (orders, account changes, copy settings), whatever route it was sent
 * to, not only the routes that document it. **Reads keep working** throughout, the billing reads
 * (`client.billing`) included.
 *
 * What a caller does: show `message` and {@link action} to a person. `action.portalPath` is the
 * portal page where they fix it (a top-up, or the invoice to pay). Once paid, the accounts are
 * released, usually within the hour; then send the request again (a write under the same
 * idempotency key). `payBy` is the last moment a payment avoids the suspension that begins at
 * `suspendsAt`.
 *
 * Execution methods never throw: an order refused for billing comes back as a refused
 * `ExecutionResult` whose `detail` carries this error's message.
 *
 * Every detail is read from `details`, and is null where the platform did not say or wrote
 * something that cannot be read.
 */
export class BillingPaymentRequiredError extends PaymentRequiredError {
  override name = "BillingPaymentRequiredError";

  /** The tenant the refusal concerns. */
  get tenantId(): string | null {
    return textOrNull(this.details["tenant_id"]);
  }

  /** The billing profile the request falls under; on Standard, its one profile. */
  get billingProfileId(): string | null {
    return textOrNull(this.details["billing_profile_id"]);
  }

  /**
   * `reminder` (only what adds something billed is refused) or `suspended` (every write on the
   * profile's accounts is). Read a word you do not know as text.
   */
  get stage(): string | null {
    return wordOrNull(this.details["stage"]);
  }

  /**
   * Why: `balance_used_up` or `invoice_overdue` (the contract's `details.cause`). Named apart from
   * `Error.cause`, which stays the standard slot for the error that caused this one, so tools that
   * walk error chains keep working.
   */
  get billingCause(): string | null {
    return wordOrNull(this.details["cause"]);
  }

  /** When the stage began. */
  get since(): Date | null {
    return timeOrNull(this.details["since"]);
  }

  /** The first suspended moment. */
  get suspendsAt(): Date | null {
    return timeOrNull(this.details["suspends_at"]);
  }

  /** The last moment a payment avoids the suspension. */
  get payBy(): Date | null {
    return timeOrNull(this.details["pay_by"]);
  }

  /** What clears it, with the portal page that does it; null if the platform named none. */
  get action(): BillingAction | null {
    const raw = this.details["action"];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const action = raw as Readonly<Record<string, unknown>>;
    const kind = action["kind"];
    const portalPath = action["portal_path"];
    if (typeof kind !== "string" || typeof portalPath !== "string") return null;
    return {
      kind,
      portalPath,
      amountUsd: amountOrNull(action["amount_usd"]),
      invoiceId: textOrNull(action["invoice_id"]),
    };
  }
}

/** No such thing; also the answer for another tenant's id. */
export class NotFoundError extends MfxApiError {
  override name = "NotFoundError";
}
/** The request conflicts with what already exists. */
export class ConflictError extends MfxApiError {
  override name = "ConflictError";
}
/** The thing exists and is not in a state this can be done in. */
export class StateError extends ConflictError {
  override name = "StateError";
}
/** A legal document due, as a refusal for an unaccepted agreement names it. */
export interface DueDocument {
  /**
   * Which document: `terms`, `mt5_licence`, `service_agreement_<plan>` (the contract's
   * `LegalDocumentKey`, an open list: a key this version does not know is one more document).
   */
  readonly document: string;
  /** The version due; null if the platform wrote none that can be read. */
  readonly number: number | null;
  /** The plan a Service Agreement belongs to; null for the Terms and the licence. */
  readonly plan: string | null;
  /**
   * When its grace period ends or ended (`grace_ends_at`); null for a plan change, which waits
   * for acceptance instead.
   */
  readonly graceEndsAt: Date | null;
}

/** A move from one plan to another, as a refusal names it (the contract's `PlanChangeSummary`). */
export interface PlanChange {
  readonly id: string;
  /** The plan now: `standard` or `enterprise`. */
  readonly from: string;
  /** The plan after acceptance. */
  readonly to: string;
  /** `awaiting_acceptance`, `active`, `lapsed` or `withdrawn`; read a word you do not know as text. */
  readonly state: string;
  readonly requestedAt: Date | null;
  /** When an awaiting change lapses if nobody accepts it; null once decided. */
  readonly until: Date | null;
  /** MFX Hub asked for the change (true) or the organisation did (false); null if unsaid. */
  readonly requestedByOperator: boolean | null;
}

/** Each readable entry of `details.documents`; one without a document key is skipped. */
function documentsOf(value: unknown): readonly DueDocument[] {
  if (!Array.isArray(value)) return [];
  const due: DueDocument[] = [];
  for (const raw of value as unknown[]) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Readonly<Record<string, unknown>>;
    const document = wordOrNull(entry["document"]);
    if (document === null) continue;
    due.push({
      document,
      number: wholeOrNull(entry["number"]),
      plan: wordOrNull(entry["plan"]),
      graceEndsAt: timeOrNull(entry["grace_ends_at"]),
    });
  }
  return due;
}

/**
 * 409 `terms_not_accepted`: a version of the Terms of Service or the MetaTrader 5 licence the
 * organisation must accept is past its grace period, and nobody has accepted it. Not retryable
 * unchanged.
 *
 * Adding a terminal and attaching an expert advisor are refused until an owner or admin accepts
 * it in the customer portal; nothing running is touched, and reads, orders and positions keep
 * working. {@link documents} names each document, its version and when its grace period ended.
 */
export class TermsNotAcceptedError extends ConflictError {
  override name = "TermsNotAcceptedError";

  /** Each document due, from `details.documents`; empty if the platform named none. */
  get documents(): readonly DueDocument[] {
    return documentsOf(this.details["documents"]);
  }
}

/**
 * 409 `service_agreement_not_accepted`: the organisation is moving to another plan and the new
 * plan's Service Agreement has not been accepted, or a version of its plan's Service Agreement
 * that must be accepted is past its grace period. Not retryable unchanged.
 *
 * Until an owner or admin accepts it at {@link acceptUrl}, adding a terminal, attaching an expert
 * advisor, generating or replacing an API key and asking for higher limits are refused. Nothing
 * running is touched: reads, orders, positions, detach, stop, restart and resume all keep
 * working. Where the Terms are held as well, this is the error, and {@link documents} lists every
 * document due. `client.tenant.serviceAgreement()` says what is due at any time.
 *
 * Every detail is read from `details`, and is null (or empty) where the platform did not say or
 * wrote something that cannot be read.
 */
export class ServiceAgreementNotAcceptedError extends ConflictError {
  override name = "ServiceAgreementNotAcceptedError";

  /** The plan change awaiting acceptance; null when none is (a version past its grace period). */
  get planChange(): PlanChange | null {
    const raw = this.details["plan_change"];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const change = raw as Readonly<Record<string, unknown>>;
    const id = wordOrNull(change["id"]);
    const from = wordOrNull(change["from"]);
    const to = wordOrNull(change["to"]);
    const state = wordOrNull(change["state"]);
    if (id === null || from === null || to === null || state === null) return null;
    const byOperator = change["requested_by_operator"];
    return {
      id,
      from,
      to,
      state,
      requestedAt: timeOrNull(change["requested_at"]),
      until: timeOrNull(change["until"]),
      requestedByOperator: typeof byOperator === "boolean" ? byOperator : null,
    };
  }

  /** Each document due, the Terms included when they are held too; empty if none was named. */
  get documents(): readonly DueDocument[] {
    return documentsOf(this.details["documents"]);
  }

  /** Where an owner or admin accepts, in the customer portal. */
  get acceptUrl(): string | null {
    return wordOrNull(this.details["accept_url"]);
  }
}

/** The terminal cannot be placed. */
export class PlacementError extends ConflictError {
  override name = "PlacementError";
}
/** MFX Hub does not support this broker or server now; the message says why. */
export class UnsupportedBrokerError extends ConflictError {
  override name = "UnsupportedBrokerError";
}
/** Too many requests; `retryAfterS` says how long to wait. */
export class RateLimitError extends MfxApiError {
  override name = "RateLimitError";
}
/** The tenant's terminal or broker did not answer. */
export class UpstreamError extends MfxApiError {
  override name = "UpstreamError";
}
/** A store of the platform's own did not answer; `retryAfterS` says when to try again. */
export class DependencyUnavailableError extends UpstreamError {
  override name = "DependencyUnavailableError";
}
/** An answer from the network's edge, not from MFX Hub (a 502 or 504). */
export class EdgeError extends UpstreamError {
  override name = "EdgeError";
}
/** MFX Hub failed, and it is not the caller's request that is wrong. */
export class InternalError extends MfxApiError {
  override name = "InternalError";
}

type ApiErrorClass = new (
  message: string,
  status: number,
  code: string,
  details?: Readonly<Record<string, unknown>>,
  retryAfterS?: number | null,
) => MfxApiError;

const BY_CODE: Readonly<Record<string, ApiErrorClass>> = {
  validation_error: ValidationError,
  auth_error: AuthError,
  forbidden: ForbiddenError,
  tenant_disabled: TenantDisabledError,
  tenant_suspended: TenantSuspendedError,
  maintenance: MaintenanceError,
  // 402, and about neither the key nor the request: a payment is missing on the billing profile.
  // Mapped by code because once a profile is suspended any write can answer it.
  billing_payment_required: BillingPaymentRequiredError,
  not_found: NotFoundError,
  conflict: ConflictError,
  state_error: StateError,
  placement_error: PlacementError,
  // 409, holding additions only, until an owner or admin accepts the documents named.
  terms_not_accepted: TermsNotAcceptedError,
  service_agreement_not_accepted: ServiceAgreementNotAcceptedError,
  risk_refused: RiskRefusedError,
  risk_override_required: RiskOverrideRequiredError,
  broker_not_supported: UnsupportedBrokerError,
  rate_limited: RateLimitError,
  upstream_error: UpstreamError,
  dependency_unavailable: DependencyUnavailableError,
  internal_error: InternalError,
};

const BY_STATUS: Readonly<Record<number, ApiErrorClass>> = {
  400: ValidationError,
  401: AuthError,
  402: PaymentRequiredError,
  403: ForbiddenError,
  404: NotFoundError,
  409: ConflictError,
  422: ValidationError,
  429: RateLimitError,
  500: InternalError,
  502: EdgeError,
  503: UpstreamError,
  504: EdgeError,
};

/** The typed error for a failure the platform described, on a call's answer or the stream. */
export function errorFor(
  code: string,
  message: string,
  status: number,
  details: Readonly<Record<string, unknown>> = {},
  retryAfterS: number | null = null,
): MfxApiError {
  const Kind = BY_CODE[code] ?? BY_STATUS[status] ?? MfxApiError;
  return new Kind(message, status, code, details, retryAfterS);
}

/**
 * Seconds from a Retry-After header, or null when there is none or it is not a number of seconds.
 * The API writes whole seconds only; an HTTP date is not read.
 */
export function retryAfterSeconds(header: string | null): number | null {
  if (header === null || header.trim() === "") return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? Math.max(0, seconds) : null;
}
