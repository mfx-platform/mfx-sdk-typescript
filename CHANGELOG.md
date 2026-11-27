# Changelog

Every release of `@mfxhub/sdk`, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## Unreleased

## 0.9.0

### Added

- `docs/sdkref.json`, the SDK reference in format `mfx-sdkref/1`, generated from the public
  exports by `node tools/sdkref.mjs` (TypeDoc reads the source). The docs site renders it one page
  per area with the other languages. CI regenerates it and fails on any difference, and validates
  it with the shared suite's checker. A free function carries its parameters and return, and every
  default value is written in full.
- A type in `docs/sdkref.json` that is one object of the API carries `schema`, the name of that
  object in the API description, so the docs site links it to the object's reference. It is read
  from the source for an alias of a generated contract type and listed by hand for the few
  hand-written ones; a client, an error or a function never carries one.

- `client.risk.archiveChallenge(challengeId, { idempotencyKey })` archives a challenge
  (`POST /risk/challenges/{id}/archive`, `risk:write`). It is refused with `StateError`
  (`state_error`) while any account is in progress, and `details.accounts` names them. Archiving
  it again answers it unchanged. `RiskChallenge` gains `archived_at`, and the planner's check and
  preview rows (`RiskRuleCheck`) gain `challenge_id`.
- Billing, as `client.billing`, reads every `billing` route of the API (scope `billing:read`):
  `priceList()` (the public price list, which needs no key and is signed like every request),
  `summary()` (`GET /billing`: every profile with its standing), `profile(id)`,
  `forecast(profileId, { month })`, `prices()`, `invoice(id)`, and the invoices as
  `invoicesPage({ billingProfileId, state, cursor, limit })` or `invoices(...)`, which follows the
  cursor. `state` is one state or several, sent comma-separated and checked here. Each answers the
  API's own model; amounts stay exact decimal strings.
- `PaymentRequiredError`, the class for any 402, and beneath it `BillingPaymentRequiredError` for
  `billing_payment_required`: a payment is missing on the billing profile. Not retryable
  unchanged. Its `tenantId`, `billingProfileId`, `stage` (`reminder` or `suspended`), `billingCause`,
  `since`, `suspendsAt`, `payBy` (as `Date`s) and `action` (a `BillingAction`: `kind`,
  `portalPath`, `amountUsd` as the exact decimal string, `invoiceId`) are read from `details`,
  null where absent or unreadable. An execution method refused for billing resolves to a refused
  `ExecutionResult` with the error's message in `detail`, as for every refusal, and never rejects.
- Service Agreements. Each plan has its own Service Agreement, and a plan change
  waits for the new plan's to be accepted. While one is due the platform holds additions only:
  - `ServiceAgreementNotAcceptedError` (a `ConflictError`) for 409 `service_agreement_not_accepted`:
    adding a terminal, attaching an expert advisor, generating or replacing an API key or asking
    for higher limits while a plan change awaits acceptance or a Service Agreement version is past
    its grace period. `planChange` (a `PlanChange`: `id`, `from`, `to`, `state`, `requestedAt`,
    `until` as `Date`s, `requestedByOperator`; null when there is no change), `documents` and
    `acceptUrl` are read from `details`. Python calls it `ServiceAgreementNotAccepted`.
  - `TermsNotAcceptedError` (a `ConflictError`) for 409 `terms_not_accepted`, which arrived as a
    plain `ConflictError` before, with `documents` read from `details`. Python calls it
    `TermsNotAccepted`.
  - Both read `documents` as `DueDocument`s: `document` (an open list of keys), `number`, `plan`
    and `graceEndsAt` as a `Date` (from `grace_ends_at`, when the grace period ends or ended).
    An entry without a document key is skipped; anything missing
    or unreadable is null, never an error of the SDK's own. Not retryable unchanged.
  - `client.tenant.serviceAgreement()` reads `GET /tenant/service-agreement` (any key): `due`,
    `held`, `plan`, `plan_change`, `documents` and `accept_url`, the API's own model.
  - The first answer carrying `MFX-Service-Agreement: due` logs one `console.warn` per client
    (`SERVICE_AGREEMENT_WARNING`); that client never warns again. A console that throws never
    fails the call.

### Changed

- An order's or a close's comment over 31 characters is refused with "comment is at most 31
  characters; the terminal would cut a longer one (N given)".
- The shared test suite is 0.13.0, whose cases answer enum words the API description does not
  list. This SDK already read such a word as the word itself, without failing the call; it is now
  held to that, and the README says so.

### Fixed

- An order's or a close's comment is counted in code points, as the API's limit and the Python SDK
  count it, not in UTF-16 units: a comment of up to 31 characters with emoji in it is sent, no
  longer refused. A longer one is refused with `RangeError`, which now says how many were given.

## 0.8.0

### Added

- Copy Trading, as `client.copy`, over every `/copy` route of the API (scopes `copy:read` and
  `copy:write`). Leaders: `createLeader`, `getLeader`, `leadersPage` / `leaders`, `updateLeader`,
  `pauseLeader`, `resumeLeader`, `retireLeader({ closeCopied, reason })`, and an external
  leader's `sendOpenSignal` (exactly one of `volume` and `units`) and `sendCloseSignal`.
  Followers: `createFollower`, `previewFollower` (a read: no idempotency key), `getFollower`,
  `followersPage` / `followers`, `updateFollower`, `pauseFollower`, `resumeFollower`,
  `resyncFollower` and `unfollow({ closeCopied })`; their stop-outs: `stopoutsPage` / `stopouts`
  and `resetStopouts({ reason })`. Groups: `createGroup`, `getGroup`, `groupsPage` / `groups`,
  `updateGroup`, `addGroupFollowers`, `removeGroupFollowers`, `pauseGroup` and `resumeGroup`. The
  copy log: `logPage` / `log`, with its filters (each list sent comma-separated and checked here),
  its window and its order. Every write takes an `idempotencyKey` and is never retried; a number
  with a fraction anywhere in a body is refused before anything is sent. An open signal's `sl`
  and `tp` may be below zero, as the API's decimals allow; `volume`, `units` and
  `grossExposureCap` may not.
- `options` (a follower's, a preview's and a group template's) takes `when_risk_unchecked`:
  `"refuse"` (the default) or `"copy"`, for a follower account protected by Risk Management whose
  copy host cannot yet check a copy against it. Its type is the API description's, on what is sent
  and on a follower read back; any other word is refused before sending.
- Requested closes and groups' bulk work: `closeGroup(groupId, { reason, pause })` (`pause` has
  no default) closes the copied positions of every live member under one `batch_id`;
  `rolloverGroup(groupId, { dryRun, fields, after, limit })` sets the group's template on its
  members, a dry run with no key and an applied one with its `idempotencyKey` (checked before
  sending); `closesPage` / `closes` (by follower, leader, group, batch, state and window) and
  `getClose` follow each requested close, an unfollow's or a retire's with `closeCopied` among
  them.
- The tenant's reads: `signalsPage` / `signals` (the leaders' signals with each one's outcomes)
  and `tenantStopoutsPage` / `tenantStopouts` (every stop-out of the followers), by their filters
  and a window.
- `followersPage` / `followers` take `sort` (`"newest"` or `"oldest"`) and `outOfStep`;
  `logPage` / `log` take `groupId`. The types carry the contract's final shapes: a follower's
  `drift`, `limits_use`, `today`, `exposure` and requested `close`; a group's `exposure` against
  its cap (USD, an equal share per live member, with `leavers` and `unenforced`); a log row's
  `deal`, `symbol` and Risk `risk`; the log's p95s; a preview row's contract sizes and volume unit.
- `CopyPage`: a list page with its `stats` row, counted over everything the filters match.
- `REFUSAL_REASONS`: the closed list of reasons a copy did not fill.
- The `copy.*` events: `copyEventOf(message)` reads `copy.copied`, `copy.refused`,
  `copy.stopout`, `copy.drift`, `copy.state_changed` and `copy.closed` (`CopyClosedEvent`: a
  requested close is final) as a `CopyEvent` narrowed by its `type`, each payload in the API's own
  shape (`latency_ms` and the stage timings are numbers; a Risk refusal's `risk` an object);
  `COPY_EVENT_TYPES` lists them.
- `client.risk.archivePolicy(policyId, { idempotencyKey })` archives a policy
  (`POST /risk/policies/{id}/archive`, `risk:write`). It is refused with `StateError`
  (`state_error`) while any account holds the policy, and `details.accounts` names those accounts.
  Once archived, a policy can't be activated or versioned, and archiving it again answers it
  unchanged. `RiskPolicy` gains `archived_at`, null while the policy is active.

### Changed

- The conformance suite is pinned at 0.8.0: its Copy Trading cases run.
- `CopyEvent` has a sixth member, `copy.closed`: code that handles the union's last case with a
  bare `else` should name `copy.state_changed` there and handle `copy.closed` apart.
- `createGroup` and `updateGroup` still take `placementPolicy`, which the API now marks
  deprecated: it is stored and returned, and placement never reads it.
- Contract refresh: `spec/openapi.yaml` is the public API description with Copy Trading's final
  shape, and `src/generated/api.ts` is regenerated from it.

## 0.7.1

### Changed

- The errors follow the reference SDK (Python) exactly. A 413 with no MFX Hub code is now an
  `MfxApiError`, not a `ValidationError`: the platform answers no 413 of its own, so one is the
  network's edge. A `Retry-After` given as an HTTP date is not read (`retryAfterS` is null and a
  read retried after it waits the client's backoff): the API writes whole seconds only.

## 0.7.0

### Removed

- `terminals.bulkRetire(...)`. MFX Hub does not serve a tenant's bulk retire and will not: the call
  always answered 404. The API description keeps `POST /terminals:retire` only as deprecated,
  because v1 changes are additive. To retire many terminals, send `DELETE /v1/terminals/{id}` for
  each, signed with `RequestSigner` as every request is. `terminals.bulkRestart`, `getBulkAction` and
  `cancelBulkAction` are unchanged.

### Changed

- The generated types follow the refreshed API description, which adds the advisor
  parameter-definition routes (`/expert-advisors/{id}/parameter-definitions`).

## 0.6.0

### Added

- Risk Management, as `client.risk`, over every `/v1/risk/*` route (scopes `risk:read`,
  `risk:write`, `risk:override`).
  - **Policies:** `createPolicy`, `addPolicyVersion` (a relaxing version needs `risk:override`
    and a `reason`), `activate` (one outcome per account), `policy`, `policyVersion`,
    `policiesPage` and `policies` (`sort: "newest"` or `"oldest"`), and `policyVersions`.
  - **Accounts:** `accountsPage` (one page and its `stats`) and `accounts` (every page), filtered
    by one or several `coverage` and `restriction` values and sorted by a figure; `account`,
    `equity`, `closeScope(accountId, "mfx_positions" | "all_positions")`, `deactivate`, `clear`
    and `coverage`.
  - **The planner:** `preview` (size a trade from a risk budget) and `check` (an order already
    sized, as the pre-trade check would judge it).
  - **Exit plans:** `createPlan`, `plan`, `plansPage` and `plans` (several accounts and states,
    `newest` or `oldest`), `amendPlan`, `pausePlan`, `resumePlan` and `endPlan`.
  - **Challenges:** `createChallenge`, `addChallengeVersion`, `challenge`, `challenges`, `enrol`,
    `challengeAccountsPage` and `challengeAccounts` (several states and rules, sorted by a
    figure), and `challengeAccount` (its periods).
  - **Activity:** `activityPage` and `activity` (several kinds, accounts and outcomes;
    `unresolved_first`, `newest` or `oldest`).
  - Every figure in a body is a decimal string: a number with a fraction is refused before
    anything is sent.
- `RiskRefusedError` (a `ValidationError`, code `risk_refused`): a new entry that breaks a rule in
  force. Its `refusal` names the reason, the rule, the policy or the challenge with its version,
  and the figure used, the limit and what the entry would have made it.
- `RiskOverrideRequiredError` (a `ForbiddenError`, code `risk_override_required`).
- The shared test suite moves to 0.7.0: its six Risk Management cases and the error cases for
  every code the API names.

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
