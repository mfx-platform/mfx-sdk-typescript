// `client.execution`: placing orders, changing and cancelling them, and changing and closing
// positions.
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

/** Every command on an existing order or position takes its key; nothing else is required. */
export interface Keyed {
  /** Required: the same key sent again returns the original command, not a second one. */
  readonly idempotencyKey: string;
}

/** What {@link Execution.modifyOrder} takes: only what changes; at least one field. */
export interface ModifyOrder extends Keyed {
  readonly price?: string;
  readonly stopLimitPrice?: string;
  readonly sl?: string;
  readonly tp?: string;
  /** A new expiry; `null` removes it and the order stays until cancelled. */
  readonly expiresAt?: Date | string | null;
}

/** What {@link Execution.modifyPosition} takes: a stop loss, a take profit, or both. */
export interface ModifyPosition extends Keyed {
  readonly sl?: string;
  readonly tp?: string;
}

/** What {@link Execution.closePosition} takes. */
export interface ClosePosition extends Keyed {
  /** How far from the price the close may fill, in points; the platform's default is 20. */
  readonly deviationPoints?: number;
  /** The closing deal's comment, up to 31 characters; absent, it takes the position's own. */
  readonly comment?: string;
}

/** What {@link Execution.closePositionPartial} takes. */
export interface ClosePositionPartial extends ClosePosition {
  /** The volume to close, in lots, as a decimal string, inside the symbol's step. */
  readonly volume: string;
}

/** What {@link Execution.closePositionBy} takes. */
export interface ClosePositionBy extends Keyed {
  /** The opposite position, in the same symbol, that this one is closed against. */
  readonly byTicket: number;
}

/** What {@link Execution.setTrailingStop} takes. */
export interface SetTrailingStop extends Keyed {
  /** How far behind the best price the stop loss follows, as a price distance: `"0.0020"`. */
  readonly distance: string;
}

/** What {@link Execution.waitFor} takes. */
export interface WaitFor {
  /** How long to keep reading, 1 ms to 10 minutes; 30 s unless given. */
  readonly timeoutMs?: number;
  /** Carried into the result only, so a retry can reuse it. */
  readonly idempotencyKey?: string;
}

/** The first pause between reads of a command, doubled each time up to {@link POLL_CAP_MS}. */
export const POLL_FROM_MS = 200;
/** The longest pause between two reads of a command. */
export const POLL_CAP_MS = 2000;

function ticketOf(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} is a positive whole number, the ticket MT5 gave`);
  }
  return value;
}

function commentOf(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError("comment is a string");
  if (value.length > 31) {
    throw new RangeError("comment is at most 31 characters; MT5 would cut a longer one");
  }
  return value;
}

function present(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

function maybe(name: string, value: string | undefined): string | undefined {
  return value === undefined ? undefined : decimal(name, value);
}

function closing(options: ClosePosition): Record<string, unknown> {
  return present({
    deviation_points: whole("deviationPoints", options.deviationPoints, 0, 2 ** 31 - 1),
    comment: commentOf(options.comment),
  });
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
   * Amend a pending order's price, stops or expiry; at least one must change. Its volume, side,
   * type and symbol cannot be amended: cancel it and place another.
   */
  async modifyOrder(
    terminalId: string,
    ticket: number,
    change: ModifyOrder,
  ): Promise<ExecutionResult> {
    const expiresAt =
      change.expiresAt instanceof Date ? change.expiresAt.toISOString() : change.expiresAt;
    const body = present({
      price: maybe("price", change.price),
      stop_limit_price: maybe("stopLimitPrice", change.stopLimitPrice),
      sl: maybe("sl", change.sl),
      tp: maybe("tp", change.tp),
      expires_at: expiresAt,
    });
    if (Object.keys(body).length === 0) {
      throw new TypeError("modifyOrder changes nothing: give a price, stops or an expiry");
    }
    return this.#on(terminalId, ticket, "orders", "modify", change, body);
  }

  /** Cancel a pending order. First class, not a modify with a special case. */
  async cancelOrder(terminalId: string, ticket: number, options: Keyed): Promise<ExecutionResult> {
    return this.#on(terminalId, ticket, "orders", "cancel", options);
  }

  /** Move a position's stop loss, take profit, or both. At least one is required. */
  async modifyPosition(
    terminalId: string,
    ticket: number,
    change: ModifyPosition,
  ): Promise<ExecutionResult> {
    const body = present({ sl: maybe("sl", change.sl), tp: maybe("tp", change.tp) });
    if (Object.keys(body).length === 0) {
      throw new TypeError("modifyPosition changes nothing: give sl, tp or both");
    }
    return this.#on(terminalId, ticket, "positions", "modify", change, body);
  }

  /** Close a position in full. */
  async closePosition(
    terminalId: string,
    ticket: number,
    options: ClosePosition,
  ): Promise<ExecutionResult> {
    return this.#on(terminalId, ticket, "positions", "close", options, closing(options));
  }

  /** Close part of a position: the volume to close, inside the symbol's step. The rest stays. */
  async closePositionPartial(
    terminalId: string,
    ticket: number,
    options: ClosePositionPartial,
  ): Promise<ExecutionResult> {
    const body = { volume: decimal("volume", options.volume), ...closing(options) };
    return this.#on(terminalId, ticket, "positions", "close-partial", options, body);
  }

  /**
   * Close a position against an opposite one in the same symbol (hedging accounts): the smaller
   * disappears and the larger is reduced by its volume.
   */
  async closePositionBy(
    terminalId: string,
    ticket: number,
    options: ClosePositionBy,
  ): Promise<ExecutionResult> {
    const by = ticketOf("byTicket", options.byTicket);
    if (by === ticket) throw new RangeError("a position cannot be closed by itself");
    return this.#on(terminalId, ticket, "positions", "close-by", options, { by_ticket: by });
  }

  /**
   * Keep the position's stop loss `distance` behind the best price it reaches, only ever tighter.
   * Setting it again replaces the distance and keeps what the stop has reached.
   */
  async setTrailingStop(
    terminalId: string,
    ticket: number,
    options: SetTrailingStop,
  ): Promise<ExecutionResult> {
    const body = { distance: decimal("distance", options.distance) };
    return this.#on(terminalId, ticket, "positions", "trailing-stop", options, body, "PUT");
  }

  /** Remove the position's trailing stop. The stop loss stays where the trail left it. */
  async clearTrailingStop(
    terminalId: string,
    ticket: number,
    options: Keyed,
  ): Promise<ExecutionResult> {
    return this.#on(terminalId, ticket, "positions", "trailing-stop", options, undefined, "DELETE");
  }

  /**
   * Read the command until it is final, or until `timeoutMs` (30 s unless given), pausing 200 ms
   * and doubling up to 2 s between reads. Returns the last answer either way: a command still
   * EXECUTING when the time runs out is reported as it is, not guessed at. **A result that is not
   * final is never a reason to send again**: an UNKNOWN command may already be a position.
   */
  async waitFor(commandId: string, options: WaitFor = {}): Promise<ExecutionResult> {
    const timeout = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 600_000) {
      throw new RangeError("timeoutMs is 1 to 600,000");
    }
    const key = options.idempotencyKey ?? "";
    let result = await this.getCommand(commandId, key);
    // DECISION: the time is counted in the pauses the client takes, not on a wall clock, so a
    // scripted sleep in a test gives the same schedule a caller gets.
    let waited = 0;
    let pause = POLL_FROM_MS;
    while (!result.final && waited < timeout) {
      const step = Math.min(pause, POLL_CAP_MS, timeout - waited);
      await this.#client.pause(step);
      waited += step;
      pause *= 2;
      result = await this.getCommand(commandId, key);
    }
    return result;
  }

  /** One command on an existing order or position: checked, then sent once. */
  async #on(
    terminalId: string,
    ticket: unknown,
    kind: "orders" | "positions",
    action: string,
    options: Keyed,
    body?: Record<string, unknown>,
    method: "POST" | "PUT" | "DELETE" = "POST",
  ): Promise<ExecutionResult> {
    const id = uuid("terminalId", terminalId);
    const number = ticketOf("ticket", ticket);
    const key = idempotencyKey((options as Partial<Keyed> | undefined)?.idempotencyKey);
    const path = `/terminals/${id}/${kind}/${String(number)}/${action}`;
    return this.#command(
      { method, path, ...(body === undefined ? {} : { body }), idempotencyKey: key },
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
