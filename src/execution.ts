// `client.execution`: placing orders.
//
// Every method here resolves to an ExecutionResult and never rejects for anything the platform or
// the network does. A transport fault, a timeout, a rate limit, a refusal and a broker rejection
// are all outcomes of trying to trade. Only a wrong argument throws, before anything is sent.
//
// Three rules show up in every signature:
// - The idempotency key is required and has no default. A retry reuses the same key and gets the
//   original command back with `duplicate: true`, never a second order.
// - Nothing is retried automatically: not a timeout (the order may have been placed), not a rate
//   limit, not a 5xx. The SDK reports; the caller decides, from `retryable`.
// - Prices and volumes are decimal strings; a number is refused (see decimals.ts).

import { idempotencyKey, uuid } from "./arguments.js";
import { throwFor, type MfxClient, type RequestSpec } from "./client.js";
import { decimal } from "./decimals.js";
import {
  MaintenanceError,
  MfxApiError,
  MfxTimeout,
  MfxTransportError,
  RateLimitError,
} from "./errors.js";
import type { components } from "./generated/api.js";
import { concluded, fromCommand, type ExecutionResult } from "./results.js";

type OrderPlace = components["schemas"]["OrderPlace"];
export type Side = OrderPlace["side"];
export type OrderType = OrderPlace["order_type"];

/** What {@link Execution.placeOrder} takes. */
export interface PlaceOrder {
  /** The broker's own symbol name (`EURUSD.sd`); MFX never renames an instrument. */
  readonly symbol: string;
  readonly side: Side;
  /** In lots, as a decimal string: `"0.01"`. A number is refused. */
  readonly volume: string;
  /** Required: the same key sent again returns the original command, not a second order. */
  readonly idempotencyKey: string;
  /** `market` unless given. */
  readonly orderType?: OrderType;
  /** A pending order's price; for `stop_limit`, the stop price where the order wakes up. */
  readonly price?: string;
  /** For `stop_limit` only: the limit order placed when the stop price is reached. */
  readonly stopLimitPrice?: string;
  readonly sl?: string;
  readonly tp?: string;
  /** How far from the requested price a market order may fill, in points. */
  readonly deviationPoints?: number;
  /** When a pending order expires. */
  readonly expiresAt?: Date | string;
  /** How long the platform may hold the command before it gives up, 1,000 to 60,000 ms. */
  readonly expiresInMs?: number;
  /** The expert advisor number the order is tagged with. */
  readonly magic?: number;
  /** Up to 31 characters; longer is refused, because MT5 would cut it without saying so. */
  readonly comment?: string;
}

function whole(
  name: string,
  value: number | undefined,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TypeError(`${name} is a whole number`);
  }
  if (value < min || value > max) throw new RangeError(`${name} is ${min} to ${max}; got ${value}`);
  return value;
}

function orderBody(order: PlaceOrder): Partial<OrderPlace> {
  const side: unknown = order.side;
  if (side !== "buy" && side !== "sell") throw new TypeError(`side is "buy" or "sell"`);
  if (typeof order.symbol !== "string" || order.symbol === "") {
    throw new TypeError("symbol is the broker's symbol name");
  }
  if (order.comment !== undefined && order.comment.length > 31) {
    throw new RangeError("comment is at most 31 characters; MT5 would cut a longer one");
  }
  const expiresAt =
    order.expiresAt instanceof Date ? order.expiresAt.toISOString() : order.expiresAt;
  const optional = {
    order_type: order.orderType,
    price: order.price === undefined ? undefined : decimal("price", order.price),
    stop_limit_price:
      order.stopLimitPrice === undefined
        ? undefined
        : decimal("stopLimitPrice", order.stopLimitPrice),
    sl: order.sl === undefined ? undefined : decimal("sl", order.sl),
    tp: order.tp === undefined ? undefined : decimal("tp", order.tp),
    deviation_points: whole("deviationPoints", order.deviationPoints, 0, 2 ** 31 - 1),
    expires_at: expiresAt,
    expires_in_ms: whole("expiresInMs", order.expiresInMs, 1000, 60_000),
    magic: whole("magic", order.magic, 0, Number.MAX_SAFE_INTEGER),
    comment: order.comment,
  };
  return {
    symbol: order.symbol,
    side,
    volume: decimal("volume", order.volume),
    ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined)),
  };
}

/** Order entry for one tenant. Every method resolves to a result; none rejects. */
export class Execution {
  readonly #client: MfxClient;

  constructor(client: MfxClient) {
    this.#client = client;
  }

  /**
   * Place a market or pending order. Resolves once the platform has persisted the command
   * (state ACCEPTED, with its `commandId`); the outcome follows on the stream.
   *
   * Throws only for a wrong argument, before anything is sent: a number where a decimal string
   * belongs, a missing idempotency key, a comment over 31 characters.
   */
  async placeOrder(terminalId: string, order: PlaceOrder): Promise<ExecutionResult> {
    const id = uuid("terminalId", terminalId);
    const key = idempotencyKey(order.idempotencyKey);
    const body = orderBody(order);
    return this.#command(
      { method: "POST", path: `/terminals/${id}/orders`, body, idempotencyKey: key },
      key,
    );
  }

  /**
   * One command and its result, as the platform has it now. A command of another tenant is not
   * found, never forbidden. Like every method here it resolves to a result and never rejects:
   * a caller checking what happened to an order must not have to catch to learn it cannot tell.
   *
   * `idempotencyKey` is only carried into the result, so a retry can reuse it; a read sends none.
   */
  async getCommand(commandId: string, idempotencyKey = ""): Promise<ExecutionResult> {
    const id = uuid("commandId", commandId);
    return this.#command({ method: "GET", path: `/commands/${id}` }, idempotencyKey, false);
  }

  /** Sends one execution call, once, and turns everything it can do into a result. */
  async #command(spec: RequestSpec, key: string, write = true): Promise<ExecutionResult> {
    const started = performance.now();
    const elapsed = (): number => performance.now() - started;
    const what = `${spec.method} ${spec.path}`;
    let answer;
    try {
      answer = await this.#client.send(spec);
    } catch (error) {
      if (error instanceof MfxTimeout) {
        // Never retried, by the SDK or by anyone: the order may have reached the broker.
        return concluded("timeout", key, elapsed(), `${what}: ${error.message}`);
      }
      // A connection that never opened cannot have placed anything; one that dropped after the
      // order was sent may have, and then the result reads UNKNOWN.
      const reached = !(error instanceof MfxTransportError) || error.mayHaveReached;
      return concluded("transport_error", key, elapsed(), `${what}: ${String(error)}`, {
        mayHaveReached: reached,
      });
    }
    try {
      throwFor(answer, spec);
    } catch (error) {
      if (error instanceof MaintenanceError) {
        const ends = error.details.ends_at;
        const retryAt = typeof ends === "string" ? new Date(ends) : null;
        return concluded("maintenance", key, elapsed(), error.message, {
          retryAt: retryAt !== null && Number.isNaN(retryAt.getTime()) ? null : retryAt,
        });
      }
      if (error instanceof RateLimitError) {
        return concluded("rate_limited", key, elapsed(), error.message);
      }
      // throwFor throws only the API's typed errors: every other answer is a refusal.
      return concluded("refused", key, elapsed(), `${what}: ${(error as MfxApiError).message}`);
    }
    const result = fromCommand(answer.body, key, elapsed());
    if (!(write && result.duplicate && result.final && result.commandId !== null)) return result;
    // A repeat of a command that is already final is answered with its state only: read the
    // command once, so the caller gets the original result - price, tickets, reason - and not an
    // empty one. One extra read, only on a final repeat.
    const original = await this.getCommand(result.commandId, key);
    if (original.commandId !== null && original.state !== null) {
      return { ...original, duplicate: true, clientRttMs: elapsed() };
    }
    // DECISION: the read failed. Report what the platform did say - the state, ok
    // from it, duplicate - and how to read the rest. Never UNKNOWN: the outcome is known.
    return {
      ...result,
      clientRttMs: elapsed(),
      detail:
        `the original result could not be read (${original.detail ?? "no answer"}); ` +
        `execution.getCommand('${result.commandId}') reads it`,
    };
  }
}
