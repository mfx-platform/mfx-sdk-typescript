# MFX Hub TypeScript SDK

The typed TypeScript client for the [MFX Hub](https://mfxhub.com) API: hosted trading terminals for
your own broker accounts, with market data, execution and a live event stream behind one signed REST
and WebSocket API.

```bash
npm install @mfxhub/sdk
```

Node.js 22 or later, ESM. Every release passes the same shared test suite as the Python SDK.

## First calls

You need an API key: its id, and the private key shown once when it was issued. Keep the private
key out of your code; the SDK never prints it.

```ts
import { Channel, MfxClient, StreamMessage, isUsable } from "@mfxhub/sdk";

const client = new MfxClient(
  "https://api.dev.mfxhub.com/v1", // https://api.mfxhub.com/v1 for production
  process.env.MFX_KEY_ID!,
  process.env.MFX_PRIVATE_KEY!, // PEM, or the base64 of the 32-byte key
);

// Your terminals, following the cursor: there is no total.
for await (const terminal of client.terminals.list()) {
  console.log(terminal.id, terminal.state, isUsable(terminal));
}

// A quote always says how old it is. Prices are decimal strings, every digit kept.
const quote = await client.catalog.quote(brokerId, "EURUSD");
console.log(quote.bid, quote.ask, quote.age_s);

// Placing an order never throws for anything the platform or the network does: read the result.
const result = await client.execution.placeOrder(terminalId, {
  symbol: "EURUSD",
  side: "buy",
  volume: "0.01", // a decimal string; a number is refused
  idempotencyKey: `order-${Date.now()}`, // the same key again returns the same order, never a second
});
if (!result.ok && result.state === "UNKNOWN") {
  // The order may have reached the broker. Never send it again under a new key.
}

// One WebSocket for every channel, resumed after a reconnect.
const stream = await client.stream();
await stream.subscribe(Channel.results(terminalId));
for await (const event of stream) {
  if (event instanceof StreamMessage) console.log(event.channel, event.seq, event.type);
}
```

Use a **demo** account while you try it: an order is real on whatever account the terminal is
logged in to.

## What 0.1 covers

| Area      | In this release                                                                       |
| --------- | ------------------------------------------------------------------------------------- |
| Signing   | every request and the stream's upgrade, Ed25519                                       |
| Errors    | one typed error per error code the API names                                          |
| Terminals | `get`, `page`, `list`, `create`                                                       |
| Execution | `placeOrder` and `getCommand`, with `ExecutionResult` for every outcome               |
| Catalogue | `quote`                                                                               |
| Stream    | `client.stream()`: events, results, account, ticks, candles, book and expert channels |

Submitting a terminal's login, farms, account reads, market-data subscriptions and the rest of
order management are next. Until then the [Python SDK](https://github.com/mfx-platform/mfx-sdk-python)
and the API itself cover them. The full API is described at [docs.mfxhub.com](https://docs.mfxhub.com).

## Three rules the SDK keeps

- **Every write takes an idempotency key**, and the SDK never invents one.
- **Execution never throws** for what the platform or the network does. A connection that dropped
  after the order was sent reads `UNKNOWN` and `retryable: false`.
- **Prices, volumes and money are decimal strings.** A JavaScript number is refused before anything
  is sent, because `0.07 * 3` is `0.21000000000000002`.

## Developing

```bash
npm ci
npm test            # vitest, 100% coverage required
npm run lint && npm run format && npm run typecheck
npm run gen         # after spec/openapi.yaml changes; CI fails when the generated types drift
```

### The shared SDK test suite

Every MFX Hub SDK passes the same cases: a fake MFX Hub plays each one back and judges what the SDK
sent. The suite is vendored in `test/conformance/suite` at the version in
`test/conformance/suite-version.txt`; its fake hub is a Python 3.12 program.

```bash
uv venv --python 3.12 .hub
uv pip install --python .hub --require-hashes -r test/conformance/hub-requirements.txt
MFX_SUITE_PYTHON=.hub/bin/python npm run test:conformance   # .hub\Scripts\python.exe on Windows
```

A case this SDK does not pass yet is listed in `test/conformance/not-yet.json` with the reason, and
must fail until it is removed. To move to a new suite release:
`node tools/update-suite.mjs <checkout of mfx-sdk-conformance at the tag>`.

See [CONTRIBUTING.md](CONTRIBUTING.md) to propose a change, and [SECURITY.md](SECURITY.md) to report a
security problem.
