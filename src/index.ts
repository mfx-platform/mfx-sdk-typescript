/**
 * The MFX Hub TypeScript SDK.
 *
 * ```ts
 * import { MfxClient } from "@mfxhub/sdk";
 * const client = new MfxClient("https://api.dev.mfxhub.com/v1", keyId, privateKey);
 * ```
 */
export { MfxClient, DEFAULT_READ_RETRIES, DEFAULT_TIMEOUT_MS } from "./client.js";
export type { Answer, Budget, ClientOptions, RequestSpec } from "./client.js";
export * from "./errors.js";
export { Page } from "./pages.js";
export { Catalog } from "./catalog.js";
export type { Quote, QuoteOptions } from "./catalog.js";
export { Execution } from "./execution.js";
export {
  CLOSE_LIFETIME,
  CLOSE_REAUTHENTICATE,
  CLOSE_SLOW_CONSUMER,
  Channel,
  ChannelRefused,
  MfxStream,
  Resync,
  StreamClosed,
  StreamMessage,
  wsConnector,
} from "./stream.js";
export type {
  Connector,
  StreamConnection,
  StreamEvent,
  StreamOptions,
  StreamStats,
  Timeframe,
} from "./stream.js";
export type { OrderType, PlaceOrder, Side } from "./execution.js";
export type { CommandState, ExecutionResult, Reason, Tickets } from "./results.js";
export { Terminals, isUsable } from "./terminals.js";
export type {
  CreateTerminal,
  PageOptions,
  Redundancy,
  Terminal,
  TerminalState,
} from "./terminals.js";
export { RequestSigner, SigningKey, signingMessage } from "./signing.js";
export { KEY_HEADER, NONCE_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "./signing.js";
export type { components, operations, paths } from "./generated/api.js";

/** This package's version. */
export const VERSION = "0.1.0";
