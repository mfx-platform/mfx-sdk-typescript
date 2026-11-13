# Changelog

Every release of `@mfxhub/sdk`, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## 0.5.0

### Added

- Market data by a cTrader account, as `client.md`: `subscribeAccount(accountId, symbol, { idempotencyKey })`
  streams one symbol's spots on `md:{accountId}:{symbol}` (scope `md:write`; `pending` until the
  first spot), `accountSubscriptionsPage` and `accountSubscriptions` list them (`md:read`),
  `unsubscribe(subscriptionId, { idempotencyKey })` stops one, and
  `accountCandles(accountId, { symbol, timeframe, from, to, limit })` reads Spotware's bars
  through the account, at most 1000 a call. An MT5 account is a `StateError` with
  `details.reason` `not_on_this_venue`.

## 0.4.0

### Added

- Trade a trading account on any venue: `client.tradingAccounts.placeOrder`, `cancelOrder`,
  `modifyOrder`, `modifyPosition`, `closePosition`, `closePositionBy`, `closePositionPartial`,
  `setTrailingStop` and `clearTrailingStop` take the account's id and send to
  `/v1/accounts/{id}/...` (scope `exec:write`). Same bodies and rules as `client.execution`: a
  required `idempotencyKey`, a result resolved and never rejected, nothing retried. Read the
  outcome with `client.execution.waitFor`.
- Read a trading account on any venue: `funds`, `positions`, `pendingOrders`, `dealsPage` and
  `deals` (with `position` to read one position's deals) and `symbols` (scope `acct:read`).
  `symbols` gives a cTrader account's volume rules in lots and its leverage.
- Connect cTrader accounts: `startCtraderGrant({ environment, scope, returnUrl })` resolves to the
  consent link to send the trader to; `ctraderGrant(id)` lists the accounts they shared;
  `connectCtraderAccounts(id, [...])` makes the chosen ones trading accounts of yours;
  `revokeCtraderGrant(id)` moves them to `REAUTH_NEEDED`.
- `ExecutionResult` reads what a venue adds: `venue`, `venueCode` (the venue's own refusal code
  beside `reason`), `deals` (each a `VenueDeal` with `volumeUnits` and `price`), `volumeUnits`,
  `closeByEmulated` and `protectionNotSet`.
- The reasons `venue_unavailable` (retryable) and `not_on_this_venue`.
- `new Execution(client, "accounts")` sends to a trading account's routes; the default is a
  terminal's, as before.

## 0.3.0

### Added

- A terminal can be `QUEUED`: placed on a cell and waiting for its turn to start. A cell starts
  terminals a few at a time so the ones already running are not slowed. `terminal.queue` says its
  place, when it is expected to start (`expected_start_at`) and why it waits (a coarse `reason`).
  `isUsable` is false for it, as for every state but ACTIVE.
- `terminals.waitUntilActive(id, { timeoutMs })`: reads the terminal until it is no longer on its
  way to ACTIVE. A QUEUED terminal is read again at its expected start (2 s to 1 min away), not on
  a fixed beat.
- `terminals.bulkRestart` and `terminals.bulkRetire` (`POST /v1/terminals:restart`,
  `POST /v1/terminals:retire`): many terminals by farm, broker or ids, answered at once with the
  action, what was refused and the expected finish. `getBulkAction` and `cancelBulkAction` follow
  and cancel it.

### Changed

- The vendored API description is the platform's current public contract, with the queued state,
  the queue fields and the bulk routes; the generated types follow it.

### Fixed

- A request path whose first segment holds a colon (`/terminals:restart`) is sent to the API. The
  URL parser read `terminals:` as a scheme.

## 0.2.4

### Added

- `client.tradingAccounts`: the trading accounts over every venue (`GET /v1/accounts`,
  `GET /v1/accounts/{id}`, scope `acct:read`). `page()` and `list()` narrow by `venue`,
  `environment` and `state` on the platform; `get(id)` takes the account's id or one of its
  terminals' ids. An MT5 account's id is its terminal's id. The state is the venue-neutral word
  (`CONNECTED`, `DEGRADED`, `REAUTH_NEEDED`, ...). `client.accounts` is unchanged: it is still the
  balance, positions and deals of a terminal's account.

### Changed

- The vendored API description is the platform's current public contract, and the generated types
  follow it.

## 0.2.3

### Added

- Every HTTP attempt is timed. `new MfxClient(..., { onCall })` is told each one as a `CallTiming`
  (`what`, `status`, `ms`; `status` is `null` when no answer came), and when the environment
  variable `MFX_CALL_LOG` names a file, one line `{"status": 200, "ms": 12.5}` is appended to it
  for each. A read retried after a 429 is two attempts. Nothing else is written: no path, id,
  header or key. A listener that throws, or a file that cannot be written, never fails a call.
  The platform's checks use it to count and time a sample's calls, as they do for the Python SDK.

## 0.2.2

### Fixed

- `stream.close()` ends the stream for good. A `next()` or a `for await` loop waiting for a message
  ends with nothing, and a reconnect under way is given up. Before, closing while a read waited
  made the stream reconnect and keep delivering, so a script that closed its stream did not end.

## 0.2.1

### Added

- Every request the SDK sends, and the stream's upgrade, carries
  `User-Agent: mfx-sdk-typescript/<version>`, built from the package's own version, so MFX Hub can
  tell which SDK and which version made each call.

## 0.2.0

### Added

- `terminals.journal(terminalId, { lines })`: the terminal's MetaTrader journal, newest first, 1 to
  200 lines. While the terminal runs the lines are read from it (`from: "live"`); after it stops
  they are the last lines it kept, for 24 hours (`from: "last_words"`). A terminal with no lines
  held throws `StateError`; a cell that does not answer throws `UpstreamError`.
- `terminals.page` and `terminals.list` take `labels` (every pair must match) and `state` (one or
  several), applied by the platform before the page is cut.
- `catalog.catalogues(brokerId)`: one row per server and account type you hold a catalogue for,
  with its `catalogue_hash`, to re-read a symbol list only when it changed.
- The API description is re-vendored. New on what comes back: `broker_words` and `refusal_kind` on
  a terminal's conditions and on `terminal.condition_changed`, `server_kind` on a terminal, path,
  ISIN, exchange, category, base currency, basis and calculation mode on a catalogue symbol,
  `source` (`live` or `last_known`) on a page of symbols, and the values `added`, `came_back`,
  `description` and `identity` for the `change` of `symbol.spec_changed`.
- A new event, `maintenance.window_changed`, arrives on the `events` channel like any other. The
  payload types `MaintenanceWindowChanged`, `TerminalConditionChanged`, `SymbolSpecChanged` and
  `SymbolSpecChange` are exported.
- The rest of order entry on `client.execution`: `modifyOrder`, `cancelOrder`, `modifyPosition`,
  `closePosition`, `closePositionPartial`, `closePositionBy`, `setTrailingStop` and
  `clearTrailingStop`. Like `placeOrder`, each takes a required idempotency key, sends only what
  you give, takes decimals as strings, and resolves to an `ExecutionResult` without ever
  rejecting. A wrong argument (a ticket that is not a positive whole number, a modify that
  changes nothing, a comment over 31 characters) throws before anything is sent.
- `execution.waitFor(commandId, { timeoutMs })` reads a command until it is final, pausing 200 ms
  and doubling up to 2 s, and returns the last answer when the time runs out. A result that is
  not final is never a reason to send again.
- `client.accounts`: `account`, `positions` and `pendingOrders` from the terminal's latest
  snapshot, and closed deals inside a required window, a page at a time (`dealsPage`) or every
  page (`deals`).

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
