// `client.stream()`: the multiplexed WebSocket.
//
// One connection carries every channel a tenant is watching: ticks, closed candles, platform
// events and execution results. The caller writes one loop:
//
//     const stream = await client.stream();
//     await stream.subscribe(Channel.md(serverId, "EURUSD.sd"));
//     await stream.subscribe(Channel.results(terminalId));
//     for await (const event of stream) { ... }
//
// What this module is opinionated about, each because the alternative loses data quietly:
// - Channels are keyed by id, never by display name. `Channel` builds the keys and refuses one
//   the platform would.
// - A reconnect resumes what can be resumed and says so about the rest. Events, results, account
//   and expert channels carry a per-channel `seq` and are resumed from the last one seen. Ticks and
//   candles are not replayed, by design (a stale tick is worse than none), so they subscribe again.
// - Almost nothing is buffered on the caller's behalf. When the caller falls behind, the socket is
//   paused, so a slow consumer meets real backpressure and is eventually dropped by the server
//   with 4008, which this reports, instead of reading minutes-old prices believing they are live.
// - Gaps are counted, not hidden. `seq` increases per channel; anything missing is arithmetic, and
//   `stats.dropped` carries the total.
//
// The upgrade is signed exactly as a REST request is, over `GET /v1/stream`.

import WebSocket from "ws";

import type { MfxClient } from "./client.js";
import { AuthError, MfxError, MfxTransportError, errorFor } from "./errors.js";

/** The server says why it hung up. 4001 is the one reconnecting cannot fix. */
export const CLOSE_REAUTHENTICATE = 4001;
export const CLOSE_SLOW_CONSUMER = 4008;
export const CLOSE_LIFETIME = 4009;

/** The timeframes closed candles are published for. */
export type Timeframe = "M1" | "M5" | "M15" | "M30" | "H1" | "H4" | "D1" | "W1" | "MN1";

/** Exactly the platform's own pattern for a channel key (`StreamChannel`). */
const CHANNEL =
  /^(md:[0-9a-f-]{36}:[^:]+|candles:[0-9a-f-]{36}:[^:]+:(M1|M5|M15|M30|H1|H4|D1|W1|MN1)|events|results:[0-9a-f-]{36}|account:[0-9a-f-]{36}|ea:[0-9a-f-]{36}|book:[0-9a-f-]{36}:[^:]+)$/;

/**
 * These resume from the last seq after a reconnect. `account:` answers a resume with a fresh
 * snapshot rather than a replay, which is still what it needs. `book:` is a state the platform
 * sends whole on every subscribe, so subscribing again loses nothing.
 */
const REPLAYABLE = ["events", "results:", "account:", "ea:"];

function checked(channel: string): string {
  if (!CHANNEL.test(channel)) {
    throw new RangeError(
      `${JSON.stringify(channel)} is not a channel key the platform accepts. Ids are uuids and ` +
        "a symbol carries no colon; see StreamChannel in the API description.",
    );
  }
  return channel;
}

const replayable = (channel: string): boolean => REPLAYABLE.some((p) => channel.startsWith(p));

/** Builds the channel keys the platform accepts, from ids rather than names. */
export const Channel = {
  /** Every platform event for this tenant. */
  events: "events",
  /** Ticks for one symbol on one server, in the broker's own name for it. */
  md: (serverId: string, symbol: string): string => checked(`md:${serverId}:${symbol}`),
  /** Closed candles. Only closed ones are published; a forming candle is not a fact yet. */
  candles: (serverId: string, symbol: string, timeframe: Timeframe): string =>
    checked(`candles:${serverId}:${symbol}:${timeframe}`),
  /** Execution results for one terminal: where a command id is finally answered. */
  results: (terminalId: string): string => checked(`results:${terminalId}`),
  /** One terminal's live account: a snapshot, then marks. */
  account: (terminalId: string): string => checked(`account:${terminalId}`),
  /** What the tenant's own expert advisor on this terminal writes. Needs `ea:read`. */
  ea: (terminalId: string): string => checked(`ea:${terminalId}`),
  /** The symbol's order book, whole, each time it changes. */
  book: (serverId: string, symbol: string): string => checked(`book:${serverId}:${symbol}`),
} as const;

/** The connection ended. `code` is the WebSocket close code, `reason` the server's words. */
export class StreamClosed extends MfxError {
  override name = "StreamClosed";

  constructor(
    readonly code: number,
    readonly reason = "",
  ) {
    super(reason === "" ? `stream closed ${code}` : `stream closed ${code}: ${reason}`);
  }
}

/** One message on one channel. */
export class StreamMessage {
  constructor(
    readonly channel: string,
    /** Increases per channel; a jump is counted in `stats.dropped`. */
    readonly seq: number | null,
    /** The event type on `events` and `results` (`command.completed`); null on a tick or candle. */
    readonly type: string | null,
    readonly data: Readonly<Record<string, unknown>>,
    /** `account:` only: the seq of the snapshot this message applies to. */
    readonly base: number | null = null,
  ) {}
}

/** The position asked for is older than the replay window: read the current state over REST. */
export class Resync {
  constructor(readonly channel: string) {}
}

/**
 * The platform refused one channel; every other channel carries on. The subscription is dropped,
 * so a reconnect does not ask for it again and collect the same refusal for ever.
 */
export class ChannelRefused {
  constructor(
    readonly channel: string,
    /** The platform's own code: `not_found`, `forbidden`, `not_subscribed`. */
    readonly code: string,
    readonly message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {}
}

/** What the stream delivers. Resync and ChannelRefused are delivered, not thrown. */
export type StreamEvent = StreamMessage | Resync | ChannelRefused;

/** What the stream missed and how often it had to come back. */
export interface StreamStats {
  /** Connections opened after the first one. */
  readonly reconnects: number;
  /** Messages the sequence numbers prove were not delivered, over every channel. */
  readonly dropped: number;
  /** Channels told to resync because the replay window had passed. */
  readonly resyncs: number;
  /** Times the server closed the stream for falling behind (4008). */
  readonly slowConsumerDrops: number;
  /** Times the 24-hour connection lifetime was reached (4009). Expected, not a fault. */
  readonly lifetimeReconnects: number;
  /** Channels the platform refused. Each cost its own channel and nothing else. */
  readonly refused: number;
}

/** What this module needs of a WebSocket, and nothing more. */
export interface StreamConnection {
  send(text: string): Promise<void>;
  /** The next frame; rejects with StreamClosed once the connection has ended. */
  recv(): Promise<string>;
  close(): Promise<void>;
}

/** Opens one connection with the signed upgrade headers. */
export type Connector = (
  url: string,
  headers: Readonly<Record<string, string>>,
) => Promise<StreamConnection>;

/** What {@link MfxClient.stream} takes. */
export interface StreamOptions {
  /** Replaces the transport; a test drives reconnects with it. */
  readonly connect?: Connector;
  /** The stream's address; derived from the client's base URL by default. */
  readonly url?: string;
  /** Stop after this many reconnects; unlimited by default. */
  readonly maxReconnects?: number;
}

/** How many frames may wait for the caller before the socket is paused. */
const HIGH_WATER = 64;

/** The default transport, over `ws`, with backpressure: the socket pauses while frames wait. */
export const wsConnector: Connector = (url, headers) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { ...headers } });
    const frames: string[] = [];
    const waiting: { resolve: (text: string) => void; reject: (error: Error) => void }[] = [];
    let ended: StreamClosed | null = null;

    socket.on("message", (data: WebSocket.RawData) => {
      // binaryType is ws's default, "nodebuffer": every frame arrives as one Buffer.
      const text = (data as Buffer).toString("utf8");
      const next = waiting.shift();
      if (next !== undefined) {
        next.resolve(text);
        return;
      }
      frames.push(text);
      if (frames.length >= HIGH_WATER) socket.pause();
    });
    socket.on("close", (code: number, reason: Buffer) => {
      ended = new StreamClosed(code, reason.toString("utf8"));
      for (const next of waiting.splice(0)) next.reject(ended);
    });
    // Once the connection is open this reject does nothing: a later error is followed by "close".
    socket.on("error", (error: Error) => {
      reject(new MfxTransportError(`the stream could not be opened: ${error.message}`, false));
    });
    socket.once("open", () => {
      resolve({
        send: (text) =>
          new Promise((done, fail) => {
            // ws calls back with null, not undefined, once the frame is written.
            socket.send(text, (error?: Error | null) => {
              if (error instanceof Error) fail(ended ?? new StreamClosed(1006, error.message));
              else done();
            });
          }),
        recv: () => {
          const frame = frames.shift();
          if (frame !== undefined) {
            if (frames.length < HIGH_WATER / 2) socket.resume();
            return Promise.resolve(frame);
          }
          if (ended !== null) return Promise.reject(ended);
          return new Promise((done, fail) => waiting.push({ resolve: done, reject: fail }));
        },
        close: () =>
          new Promise((done) => {
            if (socket.readyState === WebSocket.CLOSED) {
              done();
              return;
            }
            socket.once("close", () => {
              done();
            });
            socket.close(1000);
          }),
      });
    });
  });

/** The stream's address beside the REST base: `api.dev.mfxhub.com/v1` is `ws.dev.mfxhub.com/v1/stream`. */
export function streamUrl(baseUrl: string): string {
  const url = baseUrl
    .replace(/\/+$/, "")
    .replace(/^https:\/\//, "wss://")
    .replace(/^http:\/\//, "ws://")
    .replace("://api.", "://ws.");
  return url.endsWith("/stream") ? url : `${url}/stream`;
}

type Counter = keyof StreamStats;

/** The multiplexed stream. Opened by `await client.stream()`; closed by `close()`. */
export class MfxStream implements AsyncIterable<StreamEvent> {
  readonly #client: MfxClient;
  readonly #connect: Connector;
  readonly #url: string;
  readonly #maxReconnects: number | null;
  /** Each subscribed channel, in the order asked for, with the last seq seen on it. */
  readonly #channels = new Map<string, number | null>();
  #stats: StreamStats = {
    reconnects: 0,
    dropped: 0,
    resyncs: 0,
    slowConsumerDrops: 0,
    lifetimeReconnects: 0,
    refused: 0,
  };
  #connection: StreamConnection | null = null;

  /** Use {@link MfxClient.stream}. */
  constructor(client: MfxClient, options: StreamOptions = {}) {
    this.#client = client;
    this.#connect = options.connect ?? wsConnector;
    this.#url = options.url ?? streamUrl(client.baseUrl);
    this.#maxReconnects = options.maxReconnects ?? null;
  }

  /** What has been missed so far. A snapshot; it never changes under the caller. */
  get stats(): StreamStats {
    return { ...this.#stats };
  }

  /** The channels currently subscribed, in the order they were asked for. */
  get channels(): readonly string[] {
    return [...this.#channels.keys()];
  }

  /** Opens the connection. {@link MfxClient.stream} does this for you. */
  async open(): Promise<this> {
    const path = new URL(this.#url).pathname;
    this.#connection = await this.#connect(this.#url, this.#client.signer.headersFor("GET", path));
    return this;
  }

  /** Subscribe to one channel. Subscribing twice is not an error. */
  async subscribe(channel: string): Promise<void> {
    checked(channel);
    if (!this.#channels.has(channel)) this.#channels.set(channel, null);
    await this.#send({ op: "subscribe", ch: channel });
  }

  /**
   * Bring one channel back up to date from the last seq seen, when the caller has noticed from
   * the data itself that it is behind. On a channel that does not replay, or one with no seq yet,
   * this subscribes instead: there is no position to resume from.
   */
  async resume(channel: string): Promise<void> {
    checked(channel);
    const last = this.#channels.get(channel);
    if (last === undefined || last === null || !replayable(channel)) {
      await this.subscribe(channel);
      return;
    }
    await this.#send({ op: "resume", ch: channel, after_seq: last });
  }

  /** Stop watching a channel, and stop subscribing to it again after a reconnect. */
  async unsubscribe(channel: string): Promise<void> {
    this.#channels.delete(channel);
    await this.#send({ op: "unsubscribe", ch: channel });
  }

  /** Close the connection, if one is open. */
  async close(): Promise<void> {
    const connection = this.#connection;
    this.#connection = null;
    if (connection !== null) await connection.close();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent, void, undefined> {
    for (;;) {
      const event = await this.next();
      if (event === null) return;
      yield event;
    }
  }

  /**
   * The next event, reconnecting underneath as needed; null once the stream is over. Throws an
   * AuthError on 4001, and the platform's typed error for an error that names no channel.
   */
  async next(): Promise<StreamEvent | null> {
    for (;;) {
      const connection = this.#connection;
      if (connection === null) return null;
      let raw: string;
      try {
        raw = await connection.recv();
      } catch (error) {
        if (!(error instanceof StreamClosed)) throw error;
        if (!(await this.#reopen(error))) return null;
        continue;
      }
      const event = this.#interpret(raw);
      if (event !== null) return event;
    }
  }

  #interpret(raw: string): StreamEvent | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null; // not a frame of this protocol; nothing a caller can act on
    }
    const message = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<
      string,
      unknown
    >;
    const channel = typeof message.ch === "string" ? message.ch : "";
    if (message.op === "error") {
      const body = (
        typeof message.error === "object" && message.error !== null ? message.error : {}
      ) as Record<string, unknown>;
      const code = typeof body.code === "string" ? body.code : "stream_error";
      const text =
        typeof body.message === "string"
          ? body.message
          : `stream error on ${channel === "" ? "the connection" : channel}`;
      const details = (
        typeof body.details === "object" && body.details !== null ? body.details : {}
      ) as Record<string, unknown>;
      if (channel !== "") {
        this.#channels.delete(channel);
        this.#bump("refused");
        return new ChannelRefused(channel, code, text, details);
      }
      // About the connection itself: typed by the platform's code, with no HTTP status.
      throw errorFor(code, text, 0, details);
    }
    if (message.op === "resync") {
      this.#bump("resyncs");
      // The replay window has passed: forget the position so the next reconnect does not ask
      // for the same dead seq, and so the jump to the new seq is not counted as a gap.
      if (this.#channels.has(channel)) this.#channels.set(channel, null);
      return new Resync(channel);
    }
    if (message.op !== "msg") return null; // an ack, or an op added after this SDK shipped
    const seq = Number.isInteger(message.seq) ? (message.seq as number) : null;
    const last = this.#channels.get(channel);
    if (last !== undefined && seq !== null) {
      if (last !== null && seq > last + 1) this.#bump("dropped", seq - last - 1);
      this.#channels.set(channel, seq);
    }
    const data = message.data;
    return new StreamMessage(
      channel,
      seq,
      typeof message.type === "string" ? message.type : null,
      typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {},
      Number.isInteger(message.base) ? (message.base as number) : null,
    );
  }

  /** Come back after a close, or say the stream is over. 4001 throws: reconnecting cannot help. */
  async #reopen(closed: StreamClosed): Promise<boolean> {
    if (closed.code === CLOSE_REAUTHENTICATE) {
      this.#connection = null;
      throw new AuthError(
        closed.reason === ""
          ? "the stream's credentials were rotated, expired or revoked"
          : closed.reason,
        401,
        "auth_error",
      );
    }
    if (closed.code === CLOSE_SLOW_CONSUMER) this.#bump("slowConsumerDrops");
    if (closed.code === CLOSE_LIFETIME) this.#bump("lifetimeReconnects");
    if (this.#maxReconnects !== null && this.#stats.reconnects >= this.#maxReconnects) {
      this.#connection = null;
      return false;
    }
    this.#bump("reconnects");
    // The client's own backoff, so the stream and the reads lean on this tenant's quota alike.
    await this.#client.pause(this.#client.backoffMs(this.#stats.reconnects));
    await this.open();
    for (const [channel, last] of [...this.#channels]) {
      if (replayable(channel) && last !== null) {
        await this.#send({ op: "resume", ch: channel, after_seq: last });
      } else {
        // Ticks and candles are never replayed, so their position means nothing across a
        // reconnect; forgetting it stops the next seq being counted as a gap.
        this.#channels.set(channel, null);
        await this.#send({ op: "subscribe", ch: channel });
      }
    }
    return true;
  }

  async #send(message: Readonly<Record<string, unknown>>): Promise<void> {
    const connection = this.#connection;
    if (connection === null) throw new StreamClosed(1006, "the stream is not open");
    await connection.send(JSON.stringify(message));
  }

  #bump(counter: Counter, by = 1): void {
    this.#stats = { ...this.#stats, [counter]: this.#stats[counter] + by };
  }

  toString(): string {
    return `MfxStream(${this.#url}, channels=${this.#channels.size})`;
  }
}
