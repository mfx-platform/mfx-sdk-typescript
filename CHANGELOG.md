# Changelog

Every release of `@mfxhub/sdk`, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## Unreleased

## 0.1.0

The first release. It passes all 72 cases of the shared SDK test suite 0.2.0.

- The foundation: request signing (Ed25519, the published test vector), the client core with
  rate-limited reads retried and writes never retried, and a typed error for every error code.
- The shared SDK test suite 0.2.0 runs against this SDK on every change.
- `client.terminals`: `get`, `page`, `list` (follows the cursor; there is no total) and `create`
  (an idempotency key is required, and a write is never retried); `isUsable`; the `Page` type.
- `client.execution.placeOrder`: resolves to an `ExecutionResult` for every outcome and never
  rejects for what the platform or the network does. A connection that drops after the order was
  sent reads `UNKNOWN`, not retryable; a timeout is never retryable. Prices and volumes are decimal
  strings, written as plain digits (`1E+3` is sent as `"1000"`); a number is refused.
- `client.catalog.quote`: one symbol's quote with its age; prices are the API's decimal strings.
- `client.stream()`: one signed WebSocket for every channel. `Channel` builds the keys from
  ids. After a 4008 or 4009 close it reconnects and resumes events, results, account and expert
  channels from the last `seq`; ticks and candles are subscribed again. 4001 stops with an
  `AuthError`. A resync and a refused channel arrive as events, not errors, and gaps are counted
  in `stats`. The socket pauses while frames wait, so a slow reader meets real backpressure.
- Reads and stream reconnects share one jittered backoff (`backoffMs`).
- All 72 cases of the shared SDK test suite 0.2.0 pass.
- CONTRIBUTING.md: how to set up, test, sign off and propose a change.
