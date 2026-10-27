// What an execution call answers, and the reasons it can carry.
//
// Execution never throws across this boundary. A transport fault, a timeout, a rate limit and a
// broker rejection are all results, because a trading loop that has to catch exceptions to find
// out whether it has a position is a trading loop that will one day place two.
//
// UNKNOWN is not a failure and must never be sent again under a new key: the order may have
// reached the broker and its outcome could not be read. `retryable` is false while a command is
// UNKNOWN, and that is the flag to act on, never the reason or the state read by hand.

import { decimalOut } from "./decimals.js";
import type { components } from "./generated/api.js";

/** Where a command is. Final: SUCCEEDED, FAILED, EXPIRED, REJECTED. UNKNOWN is not final. */
export type CommandState = components["schemas"]["CommandState"];

const STATES: ReadonlySet<string> = new Set<CommandState>([
  "ACCEPTED",
  "ENQUEUED",
  "DELIVERED",
  "EXECUTING",
  "SUCCEEDED",
  "FAILED",
  "EXPIRED",
  "REJECTED",
  "UNKNOWN",
]);
const FINAL: ReadonlySet<string> = new Set<CommandState>([
  "SUCCEEDED",
  "FAILED",
  "EXPIRED",
  "REJECTED",
]);

/**
 * Why a command ended as it did: the platform's reasons, and four the SDK concludes itself
 * (`transport_error`, `timeout`, `refused`, and `maintenance` when the API refuses outright).
 * A reason the platform adds later arrives in `reasonText` as it was sent, with `reason` null.
 */
export type Reason =
  | "success"
  | "requote"
  | "instrument_disabled"
  | "no_liquidity"
  | "market_closed"
  | "invalid_stops"
  | "invalid_volume"
  | "insufficient_funds"
  | "trade_disabled"
  | "rejected_other"
  | "rate_limited"
  | "expired"
  | "unknown"
  | "maintenance"
  | "transport_error"
  | "timeout"
  | "refused";

const REASONS: ReadonlySet<string> = new Set<Reason>([
  "success",
  "requote",
  "instrument_disabled",
  "no_liquidity",
  "market_closed",
  "invalid_stops",
  "invalid_volume",
  "insufficient_funds",
  "trade_disabled",
  "rejected_other",
  "rate_limited",
  "expired",
  "unknown",
  "maintenance",
  "transport_error",
  "timeout",
  "refused",
]);

/** MT5 relates one order, one deal and one position per fill; null where MT5 has none yet. */
export interface Tickets {
  readonly order: number | null;
  readonly deal: number | null;
  readonly position: number | null;
}

/**
 * The whole answer to one execution call. Never thrown, always returned.
 *
 * Read `state` first: SUCCEEDED is done; FAILED, EXPIRED and REJECTED did not happen; UNKNOWN may
 * already be a position and must never be sent again under a new key.
 */
export interface ExecutionResult {
  /** True when the command succeeded. */
  readonly ok: boolean;
  /** The key this call was made with, so a retry can reuse it without bookkeeping. */
  readonly idempotencyKey: string;
  /** How long the SDK waited, end to end, in milliseconds. Always known. */
  readonly clientRttMs: number;
  /** The platform's id for the command. */
  readonly commandId: string | null;
  readonly state: CommandState | null;
  /** True once the platform will not change this answer again. */
  readonly final: boolean;
  /** Whether sending the same order again under a NEW key can succeed. False while UNKNOWN. */
  readonly retryable: boolean;
  /** The same key with the same body: this is the original command, not a second one. */
  readonly duplicate: boolean;
  /** Why it ended as it did; null when the platform gives none, as on a success. */
  readonly reason: Reason | null;
  /** The reason exactly as it arrived, including one this SDK version does not know. */
  readonly reasonText: string | null;
  /** The trading platform's own return code, and its meaning in words. */
  readonly mt5Retcode: number | null;
  readonly retcodeText: string | null;
  /** The broker's own comment, verbatim. */
  readonly commentRaw: string | null;
  /** The terminal's state when the command was answered. */
  readonly terminalState: string | null;
  readonly tickets: Tickets;
  /** The price and volume the broker filled at, as decimal strings. */
  readonly execPrice: string | null;
  readonly execVolume: string | null;
  readonly brokerLatencyMs: number | null;
  readonly agentLatencyMs: number | null;
  /** How many times the platform sent it to the broker. */
  readonly attempts: number;
  /** The terminal a failover moved this command from, when one did. */
  readonly reroutedFrom: string | null;
  /** What the platform or the SDK said when the request was refused outright. */
  readonly detail: string | null;
  /** When sending it again can work: a maintenance window's end, where the platform said. */
  readonly retryAt: Date | null;
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A result from a Command or a CommandAccepted body, whichever the call answered with. */
export function fromCommand(
  body: unknown,
  idempotencyKey: string,
  clientRttMs: number,
): ExecutionResult {
  const raw = record(body);
  const state = typeof raw.state === "string" && STATES.has(raw.state) ? raw.state : null;
  const result = record(raw.result);
  const reasonText = text(result.reason);
  const tickets = record(result.tickets);
  return {
    ok: result.ok === true,
    idempotencyKey,
    clientRttMs,
    commandId: text(raw.command_id),
    state: state as CommandState | null,
    final: typeof raw.final === "boolean" ? raw.final : state !== null && FINAL.has(state),
    // Never retryable while the outcome is unread: that is how one fill becomes two. A
    // maintenance refusal is, whatever the flag says: it was refused before it ran.
    retryable: (result.retryable === true || reasonText === "maintenance") && state !== "UNKNOWN",
    duplicate: raw.duplicate === true,
    reason: reasonText !== null && REASONS.has(reasonText) ? (reasonText as Reason) : null,
    reasonText,
    mt5Retcode: int(result.mt5_retcode),
    retcodeText: text(result.retcode_text),
    commentRaw: text(result.comment_raw),
    terminalState: text(result.terminal_state),
    tickets: {
      order: int(tickets.order),
      deal: int(tickets.deal),
      position: int(tickets.position),
    },
    execPrice: decimalOut(result.exec_price),
    execVolume: decimalOut(result.exec_volume),
    brokerLatencyMs: int(result.broker_latency_ms),
    agentLatencyMs: int(result.agent_latency_ms),
    attempts: int(result.attempts) ?? 0,
    reroutedFrom: text(result.rerouted_from),
    detail: null,
    retryAt: null,
  };
}

/** Why the SDK itself concluded a result: no answer, no answer in time, or a refusal. */
export type Concluded = "transport_error" | "timeout" | "refused" | "rate_limited" | "maintenance";

/**
 * A result the SDK concluded itself.
 *
 * `mayHaveReached` is for a transport error after the request was sent: the order may be a
 * position, so the result reads UNKNOWN and is not retryable under a new key. Sending it again
 * under the SAME key is safe, and answers with the original if it arrived.
 */
export function concluded(
  reason: Concluded,
  idempotencyKey: string,
  clientRttMs: number,
  detail: string,
  options: { readonly mayHaveReached?: boolean; readonly retryAt?: Date | null } = {},
): ExecutionResult {
  const reached = reason === "transport_error" && options.mayHaveReached === true;
  return {
    ...fromCommand({}, idempotencyKey, clientRttMs),
    reason,
    reasonText: reason,
    // A timeout is never retryable: the order may have been placed. A transport error before
    // the request left is, a rate limit is, and so is a maintenance refusal once the window ends.
    retryable:
      !reached &&
      (reason === "transport_error" || reason === "rate_limited" || reason === "maintenance"),
    state: reached ? "UNKNOWN" : null,
    final: true,
    detail,
    retryAt: options.retryAt ?? null,
  };
}
