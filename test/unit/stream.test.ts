import type { AddressInfo } from "node:net";
import { describe, afterEach, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";

import {
  AuthError,
  Channel,
  ChannelRefused,
  MfxClient,
  MfxStream,
  MfxTransportError,
  Resync,
  StreamClosed,
  StreamMessage,
  TenantDisabledError,
  wsConnector,
  type StreamConnection,
} from "../../src/index.js";
import { streamUrl } from "../../src/stream.js";
import { BASE, SEED } from "./net.js";

const SERVER = "3c2d3e4f-5a6b-7c8d-9e0f-102030405060";
const TERMINAL = "0191f0c2-aaaa-7bbb-8ccc-000000000001";
const RESULTS = `results:${TERMINAL}`;
const MD = `md:${SERVER}:EURUSD`;

type Frame = Record<string, unknown> | string | StreamClosed;
const msg = (ch: string, seq: number | null, extra: Record<string, unknown> = {}) => ({
  op: "msg",
  ch,
  seq,
  type: "terminal.state_changed",
  data: {},
  ...extra,
});
const closed = (code: number, reason = "") => new StreamClosed(code, reason);

/** One scripted connection: delivers its frames in order, then reports a normal close. */
class Scripted implements StreamConnection {
  readonly sent: unknown[] = [];
  closes = 0;
  constructor(private readonly frames: Frame[]) {}
  send(text: string): Promise<void> {
    this.sent.push(JSON.parse(text));
    return Promise.resolve();
  }
  recv(): Promise<string> {
    const frame = this.frames.shift() ?? closed(1000);
    if (frame instanceof StreamClosed) return Promise.reject(frame);
    return Promise.resolve(typeof frame === "string" ? frame : JSON.stringify(frame));
  }
  close(): Promise<void> {
    this.closes++;
    return Promise.resolve();
  }
}

function scripted(...connections: Scripted[]) {
  const opened: { url: string; headers: Readonly<Record<string, string>> }[] = [];
  const queue = [...connections];
  return {
    opened,
    connections,
    connect: (url: string, headers: Readonly<Record<string, string>>) => {
      opened.push({ url, headers });
      const next = queue.shift();
      if (next === undefined) throw new Error("no connection scripted");
      return Promise.resolve(next);
    },
  };
}

const waits: number[] = [];
const client = () =>
  new MfxClient("https://api.dev.mfxhub.com/v1", "mfxk_TEST", SEED, {
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
  });

async function drain(stream: MfxStream, limit = 50): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of stream) {
    events.push(event);
    if (events.length >= limit) break;
  }
  return events;
}

describe("stream channel keys are built from ids and refused when the platform would refuse them", () => {
  it("builds every channel key from ids, and refuses one the platform would", () => {
    expect(Channel.events).toBe("events");
    expect(Channel.md(SERVER, "EURUSD.sd")).toBe(`md:${SERVER}:EURUSD.sd`);
    expect(Channel.candles(SERVER, "EURUSD", "H1")).toBe(`candles:${SERVER}:EURUSD:H1`);
    expect(Channel.results(TERMINAL)).toBe(RESULTS);
    expect(Channel.account(TERMINAL)).toBe(`account:${TERMINAL}`);
    expect(Channel.ea(TERMINAL)).toBe(`ea:${TERMINAL}`);
    expect(Channel.book(SERVER, "EURUSD")).toBe(`book:${SERVER}:EURUSD`);
    expect(() => Channel.md("Test Server", "EURUSD")).toThrow(RangeError);
    expect(() => Channel.md(SERVER, "EUR:USD")).toThrow(RangeError);
  });
});

describe("the stream's address is derived from the client's base URL", () => {
  it("sits beside the REST base, so a client pointed at dev cannot stream from production", () => {
    expect(streamUrl("https://api.dev.mfxhub.com/v1/")).toBe("wss://ws.dev.mfxhub.com/v1/stream");
    expect(streamUrl("http://127.0.0.1:9/v1")).toBe("ws://127.0.0.1:9/v1/stream");
    expect(streamUrl("wss://ws.mfxhub.com/v1/stream")).toBe("wss://ws.mfxhub.com/v1/stream");
  });
});

describe("the stream resumes after a reconnect, stops on re-authenticate, and counts what it missed", () => {
  it("signs the upgrade over the stream's path and delivers a channel's messages in order", async () => {
    const net = scripted(
      new Scripted([{ op: "ack", ch: "events" }, msg("events", 1), msg("events", 2, { base: 1 })]),
    );
    const stream = await client().stream({ connect: net.connect, maxReconnects: 0 });
    await stream.subscribe(Channel.events);
    await stream.subscribe(Channel.events);
    expect(stream.channels).toEqual(["events"]);
    const events = await drain(stream);
    expect(events.map((e) => (e as StreamMessage).seq)).toEqual([1, 2]);
    expect(events[1]).toMatchObject({ type: "terminal.state_changed", base: 1, data: {} });
    expect(net.opened[0]?.url).toBe("wss://ws.dev.mfxhub.com/v1/stream");
    expect(net.opened[0]?.headers["X-MFX-Key"]).toBe("mfxk_TEST");
    expect(net.opened[0]?.headers["X-MFX-Signature"]).toBeTruthy();
    expect(net.connections[0]?.sent).toEqual([
      { op: "subscribe", ch: "events" },
      { op: "subscribe", ch: "events" },
    ]);
    expect(String(stream)).toBe("MfxStream(wss://ws.dev.mfxhub.com/v1/stream, channels=1)");
  });

  it("counts the messages a channel's seq proves were not delivered", async () => {
    const net = scripted(new Scripted([msg("events", 1), msg("events", 4)]));
    const stream = await client().stream({ connect: net.connect, maxReconnects: 0 });
    await stream.subscribe("events");
    await drain(stream);
    expect(stream.stats.dropped).toBe(2);
  });

  it("reads what it can of a message, and counts nothing on a channel it never asked for", async () => {
    const net = scripted(
      new Scripted([
        "not json",
        "5",
        { op: "later-op" },
        { op: "msg", ch: "events", seq: "7", type: 3, data: "x", base: "2" },
        msg(RESULTS, 9),
      ]),
    );
    const stream = await client().stream({ connect: net.connect, maxReconnects: 0 });
    await stream.subscribe("events");
    const events = await drain(stream);
    expect(events).toEqual([
      new StreamMessage("events", null, null, {}, null),
      new StreamMessage(RESULTS, 9, "terminal.state_changed", {}, null),
    ]);
    expect(stream.stats.dropped).toBe(0);
  });

  it("after the lifetime ends (4009), reconnects and resumes events from the last seq", async () => {
    waits.length = 0;
    const net = scripted(
      new Scripted([msg("events", 5), msg(MD, 40), closed(4009, "lifetime reached")]),
      new Scripted([msg("events", 6), msg(MD, 900)]),
    );
    const stream = await client().stream({ connect: net.connect, maxReconnects: 1 });
    await stream.subscribe("events");
    await stream.subscribe(MD);
    await stream.subscribe(RESULTS);
    const events = await drain(stream);
    expect(events).toHaveLength(4);
    expect(net.connections[1]?.sent).toEqual([
      { op: "resume", ch: "events", after_seq: 5 },
      { op: "subscribe", ch: MD },
      { op: "subscribe", ch: RESULTS },
    ]);
    expect(stream.stats).toEqual({
      reconnects: 1,
      dropped: 0,
      resyncs: 0,
      slowConsumerDrops: 0,
      lifetimeReconnects: 1,
      refused: 0,
    });
    expect(waits).toEqual([1000]);
    expect(net.opened).toHaveLength(2);
  });

  it("counts a slow-consumer drop (4008) and a plain close, and stops at the reconnect limit", async () => {
    const net = scripted(new Scripted([closed(4008, "slow consumer")]), new Scripted([]));
    const stream = await client().stream({ connect: net.connect, maxReconnects: 1 });
    await stream.subscribe(RESULTS);
    expect(await drain(stream)).toEqual([]);
    expect(stream.stats).toMatchObject({ reconnects: 1, slowConsumerDrops: 1 });
    expect(await stream.next()).toBeNull();
  });

  it("stops with an AuthError on 4001, without reconnecting", async () => {
    for (const reason of ["the key was revoked", ""]) {
      const net = scripted(new Scripted([closed(4001, reason)]));
      const stream = await client().stream({ connect: net.connect });
      await expect(stream.next()).rejects.toBeInstanceOf(AuthError);
      expect(net.opened).toHaveLength(1);
      expect(await stream.next()).toBeNull();
    }
  });

  it("delivers a resync, forgets the position, and does not count the jump as a gap", async () => {
    const net = scripted(
      new Scripted([msg("events", 3), closed(4009)]),
      new Scripted([
        { op: "resync", ch: "events" },
        { op: "resync", ch: "other" },
        msg("events", 100),
      ]),
      new Scripted([]),
    );
    const stream = await client().stream({ connect: net.connect, maxReconnects: 2 });
    await stream.subscribe("events");
    const events = await drain(stream);
    expect(events[1]).toEqual(new Resync("events"));
    expect(stream.stats).toMatchObject({ dropped: 0, resyncs: 2, reconnects: 2 });
    expect(net.connections[2]?.sent).toEqual([{ op: "resume", ch: "events", after_seq: 100 }]);
  });

  it("delivers a refused channel as an event, drops it, and carries on with the rest", async () => {
    const net = scripted(
      new Scripted([
        {
          op: "error",
          ch: RESULTS,
          error: { code: "forbidden", message: "no exec:read", details: { scope: "exec:read" } },
        },
        { op: "error", ch: "events", error: "?" },
        msg("events", 1),
      ]),
    );
    const stream = await client().stream({ connect: net.connect, maxReconnects: 0 });
    await stream.subscribe("events");
    await stream.subscribe(RESULTS);
    const events = await drain(stream);
    expect(events[0]).toEqual(
      new ChannelRefused(RESULTS, "forbidden", "no exec:read", { scope: "exec:read" }),
    );
    expect(events[1]).toEqual(
      new ChannelRefused("events", "stream_error", "stream error on events", {}),
    );
    expect(stream.stats.refused).toBe(2);
    expect(stream.channels).toEqual([]);
  });

  it("throws the platform's typed error for an error about the connection itself", async () => {
    const net = scripted(
      new Scripted([{ op: "error", error: { code: "tenant_disabled", message: "disabled" } }]),
      new Scripted([{ op: "error" }]),
    );
    const disabled = await client().stream({ connect: net.connect });
    await expect(disabled.next()).rejects.toBeInstanceOf(TenantDisabledError);
    const unnamed = await client().stream({ connect: net.connect });
    await expect(unnamed.next()).rejects.toMatchObject({
      code: "stream_error",
      status: 0,
      message: "stream error on the connection",
    });
  });

  it("resumes on request from the last seq, and subscribes where there is nothing to resume", async () => {
    const net = scripted(new Scripted([msg("events", 8)]));
    const stream = await client().stream({ connect: net.connect, maxReconnects: 0 });
    await stream.subscribe("events");
    await stream.resume("events"); // no seq yet: subscribes
    await stream.next();
    await stream.resume("events");
    await stream.resume(MD); // never subscribed: subscribes
    await stream.subscribe(MD);
    await stream.unsubscribe(MD);
    await stream.resume(MD);
    expect(net.connections[0]?.sent).toEqual([
      { op: "subscribe", ch: "events" },
      { op: "subscribe", ch: "events" },
      { op: "resume", ch: "events", after_seq: 8 },
      { op: "subscribe", ch: MD },
      { op: "subscribe", ch: MD },
      { op: "unsubscribe", ch: MD },
      { op: "subscribe", ch: MD },
    ]);
    await expect(stream.resume("nope")).rejects.toBeInstanceOf(RangeError);
  });

  it("closes once, and refuses to send on a stream that is not open", async () => {
    const connection = new Scripted([]);
    const stream = await client().stream({ connect: scripted(connection).connect });
    await stream.close();
    await stream.close();
    expect(connection.closes).toBe(1);
    expect(await stream.next()).toBeNull();
    await expect(stream.subscribe("events")).rejects.toBeInstanceOf(StreamClosed);
  });

  it("passes on a fault that is not a close", async () => {
    const broken: StreamConnection = {
      send: () => Promise.resolve(),
      recv: () => Promise.reject(new Error("bug")),
      close: () => Promise.resolve(),
    };
    const stream = await client().stream({ connect: () => Promise.resolve(broken) });
    await expect(stream.next()).rejects.toThrow("bug");
  });

  it("names the close code, and the server's reason when it gave one", () => {
    expect(closed(4009, "lifetime").message).toBe("stream closed 4009: lifetime");
    expect(closed(1006).message).toBe("stream closed 1006");
  });
});

describe("the WebSocket transport carries frames, applies backpressure and reports closes", () => {
  let server: WebSocketServer | undefined;
  afterEach(async () => {
    await new Promise((done) => {
      if (server === undefined) done(undefined);
      else server.close(done);
    });
    server = undefined;
  });

  async function serve(
    onConnection: (socket: ServerSocket, headers: Record<string, unknown>) => void,
  ): Promise<string> {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    server = wss;
    wss.on("connection", (socket, request) => {
      onConnection(socket, request.headers);
    });
    await new Promise((done) => wss.once("listening", done));
    return `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/v1/stream`;
  }

  it("carries frames both ways with the upgrade's headers, then reports the server's close", async () => {
    let seen: Record<string, unknown> = {};
    const url = await serve((socket, headers) => {
      seen = headers;
      socket.on("message", (data) => {
        socket.send(`echo ${(data as Buffer).toString()}`);
        socket.close(4009, "lifetime reached");
      });
    });
    const connection = await wsConnector(url, { "X-MFX-Key": "mfxk_TEST" });
    expect(seen["x-mfx-key"]).toBe("mfxk_TEST");
    const pending = connection.recv();
    await connection.send("hello");
    expect(await pending).toBe("echo hello");
    await expect(connection.recv()).rejects.toMatchObject({
      code: 4009,
      reason: "lifetime reached",
    });
    await expect(connection.recv()).rejects.toBeInstanceOf(StreamClosed);
    await expect(connection.send("late")).rejects.toBeInstanceOf(StreamClosed);
    await connection.close();
  });

  it("pauses the socket while frames wait for the caller, and loses none of them", async () => {
    const url = await serve((socket) => {
      for (let i = 0; i < 100; i++) socket.send(String(i));
    });
    const connection = await wsConnector(url, {});
    await new Promise((done) => setTimeout(done, 100));
    const got: string[] = [];
    for (let i = 0; i < 100; i++) got.push(await connection.recv());
    expect(got).toEqual(Array.from({ length: 100 }, (_, i) => String(i)));
    await connection.close();
  });

  it("refuses to send once the caller has started closing", async () => {
    const url = await serve(() => undefined);
    const connection = await wsConnector(url, {});
    const closing = connection.close();
    await expect(connection.send("x")).rejects.toMatchObject({ code: 1006 });
    await closing;
  });

  it("fails to open with a transport error that says nothing was sent", async () => {
    const url = await serve(() => undefined);
    const dead = url.replace(/:\d+\//, ":1/");
    await expect(wsConnector(dead, {})).rejects.toMatchObject({
      name: "MfxTransportError",
      mayHaveReached: false,
    });
    await expect(wsConnector(dead, {})).rejects.toBeInstanceOf(MfxTransportError);
  });

  it("is what a client's stream opens by default, against the stream beside its base", async () => {
    const url = await serve((socket) => {
      socket.send(JSON.stringify(msg("events", 1)));
    });
    const base = url.replace(/^ws:/, "http:").replace(/\/stream$/, "");
    const stream = await new MfxClient(base, "mfxk_TEST", SEED).stream();
    expect(await stream.next()).toBeInstanceOf(StreamMessage);
    await stream.close();
  });
});

describe("reads and reconnects share one jittered backoff", () => {
  it("doubles from one second to a 30 s cap, jittered", () => {
    const fixed = new MfxClient(BASE, "k", SEED, { random: () => 1 });
    expect([0, 1, 2, 5, 9].map((n) => fixed.backoffMs(n))).toEqual([
      1000, 2000, 4000, 30000, 30000,
    ]);
    const low = new MfxClient(BASE, "k", SEED, { random: () => 0 });
    expect(low.backoffMs(3)).toBe(0);
  });
});
