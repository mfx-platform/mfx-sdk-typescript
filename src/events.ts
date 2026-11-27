// The `data` of the platform events a tenant receives on the `events` channel and as webhooks,
// typed from the contract. The stream delivers every event type the platform sends, including
// ones this version has not heard of, with `type` as the platform wrote it; these types describe
// the payloads that are known. On the stream every value is text, as on every event.

import type { components } from "./generated/api.js";

/** `terminal.condition_changed`: a condition's status moved; carries `broker_words` and `refusal_kind`. */
export type TerminalConditionChanged = components["schemas"]["TerminalConditionChanged"];
/** `maintenance.window_changed`: a window was announced, started, moved, ended or cancelled. */
export type MaintenanceWindowChanged = components["schemas"]["MaintenanceWindowChanged"];
/** `symbol.spec_changed`: a symbol on a catalogue of yours changed. */
export type SymbolSpecChanged = components["schemas"]["SymbolSpecChanged"];
/**
 * What changed on a symbol: `spec`, `trading`, `sessions`, `removed`, `added`, `came_back`,
 * `description` or `identity`. `before` is null for `added` and `after` is null for `removed`; for
 * `came_back` and `description` both are specs. The platform does not send `identity` yet.
 */
export type SymbolSpecChange = SymbolSpecChanged["change"];

/** `copy.copied`: one follower's copy filled, with the stage timings. */
export type CopyCopied = components["schemas"]["CopyCopied"];
/** `copy.refused`: one follower's copy did not fill; `reason` is one of `REFUSAL_REASONS`. */
export type CopyRefused = components["schemas"]["CopyRefused"];
/** `copy.stopout`: a follower reached a copy limit and is stopped out. */
export type CopyStopoutEvent = components["schemas"]["CopyStopoutEvent"];
/** `copy.drift`: the follower's copied positions differ from what they should be. */
export type CopyDrift = components["schemas"]["CopyDrift"];
/** `copy.state_changed`: a follower's state changed. */
export type CopyStateChanged = components["schemas"]["CopyStateChanged"];
/**
 * `copy.closed`: a requested close of copied positions stopped being pending (`done`,
 * `incomplete` or `superseded`), with what it closed and what it did not. Sent once.
 */
export type CopyClosedEvent = components["schemas"]["CopyClosedEvent"];

/**
 * A copy event, by its type. Every payload names the follower account by `account_id` with its
 * `venue`, never a terminal or a ticket, and is the contract's shape: nested objects (`deal`,
 * `as`, `stages`, a refusal's `risk`) are objects, `latency_ms` and each stage's milliseconds are
 * numbers, decimals (volumes, prices, money) are strings, and an absent value is null. A
 * `copy.refused` that Risk Management caused carries `risk`: the rule, the policy or challenge
 * with its version, and the figures as text.
 */
export type CopyEvent =
  | { readonly type: "copy.copied"; readonly data: CopyCopied }
  | { readonly type: "copy.refused"; readonly data: CopyRefused }
  | { readonly type: "copy.stopout"; readonly data: CopyStopoutEvent }
  | { readonly type: "copy.drift"; readonly data: CopyDrift }
  | { readonly type: "copy.state_changed"; readonly data: CopyStateChanged }
  | { readonly type: "copy.closed"; readonly data: CopyClosedEvent };

/** The copy event types, as the platform names them. */
export const COPY_EVENT_TYPES: readonly CopyEvent["type"][] = [
  "copy.copied",
  "copy.refused",
  "copy.stopout",
  "copy.drift",
  "copy.state_changed",
  "copy.closed",
];

/**
 * A stream message (or a webhook's body: `type` and the event's fields) as the copy event it is,
 * or null for any other type. Narrow on `type` to read its payload:
 *
 * ```ts
 * const event = copyEventOf(message);
 * if (event?.type === "copy.refused") console.log(event.data.reason, event.data.venue_code);
 * ```
 */
export function copyEventOf(message: {
  readonly type: string | null;
  readonly data: Readonly<Record<string, unknown>>;
}): CopyEvent | null {
  const { type, data } = message;
  if (type === null || !(COPY_EVENT_TYPES as readonly string[]).includes(type)) return null;
  const raw: unknown = data;
  if (
    typeof raw !== "object" ||
    raw === null ||
    typeof (raw as { account_id?: unknown }).account_id !== "string"
  ) {
    throw new TypeError(`${type} carries no account_id`);
  }
  return { type, data } as unknown as CopyEvent;
}
