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
/** The request is not signed by a key the platform knows. */
export class AuthError extends MfxApiError {
  override name = "AuthError";
}
/** The key may not do this. */
export class ForbiddenError extends MfxApiError {
  override name = "ForbiddenError";
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
  not_found: NotFoundError,
  conflict: ConflictError,
  state_error: StateError,
  placement_error: PlacementError,
  broker_not_supported: UnsupportedBrokerError,
  rate_limited: RateLimitError,
  upstream_error: UpstreamError,
  dependency_unavailable: DependencyUnavailableError,
  internal_error: InternalError,
};

const BY_STATUS: Readonly<Record<number, ApiErrorClass>> = {
  400: ValidationError,
  401: AuthError,
  403: ForbiddenError,
  404: NotFoundError,
  409: ConflictError,
  413: ValidationError,
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

/** Seconds from a Retry-After header, or null when there is none or it cannot be read. */
export function retryAfterSeconds(header: string | null): number | null {
  if (header === null || header.trim() === "") return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, (at - Date.now()) / 1000);
}
