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
