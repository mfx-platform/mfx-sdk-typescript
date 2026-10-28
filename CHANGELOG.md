# Changelog

Every release of `@mfxhub/sdk`, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## Unreleased

## 0.1.2

### Fixed

- An order sent again with the same idempotency key, after the first had already finished, came
  back with `ok` false and no price, tickets or broker comment, because the platform answers a
  repeat with the command's state only. A filled order read as not filled. The SDK now reads the
  command once and returns the original result in full, marked `duplicate`. A repeat still in
  flight is returned as it is, with no extra read.
- If that read fails, `placeOrder` still resolves with what the platform said (the state, `ok`
  true for a success, `duplicate`) with the price and tickets empty, and `detail` names the
  `getCommand` call that reads the rest. It never rejects.

### Added

- `execution.getCommand(commandId)`: one command and its result, as the platform has it now. Like
  every execution method it resolves to an `ExecutionResult` and never rejects.

### Changed

- The SDK passes the shared SDK test suite 0.3.0, all 74 cases.

## 0.1.1

No change to what the SDK does: the same API and behaviour as 0.1.0, and all 72 cases of the
shared SDK test suite 0.2.0 still pass.

### Changed

- Built and checked with ESLint 10.
- The Node.js type definitions stay on Node.js 22, the oldest version the SDK supports, so code that
  needs a newer Node.js fails the build instead of failing for you on Node.js 22.

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
