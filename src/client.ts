/**
 * `MfxClient`: one signed connection to the MFX Hub API.
 *
 * Every request is signed with the tenant's Ed25519 key. Reads that are rate limited are retried
 * after the platform's own `Retry-After`; writes are never retried, because a retried write is a
 * second order. Failures become typed errors from `errors.ts`.
 */
import {
  MfxApiError,
  MfxTimeout,
  MfxTransportError,
  errorFor,
  retryAfterSeconds,
} from "./errors.js";
import { RequestSigner, type SigningKey } from "./signing.js";
import { Catalog } from "./catalog.js";
import { Execution } from "./execution.js";
import { MfxStream, type StreamOptions } from "./stream.js";
import { Terminals } from "./terminals.js";

/** Default time a single request may take. */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** How many times a rate-limited read is tried again. */
export const DEFAULT_READ_RETRIES = 3;
/** The longest the client waits between attempts when the platform names no delay. */
const BACKOFF_CAP_MS = 30_000;

/** Connection-phase failures: the request was never sent. */
const NOT_SENT = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** What the key had left when MFX Hub last answered. */
export interface Budget {
  readonly remaining: number;
  readonly source: string;
}

/** Options for {@link MfxClient}. */
export interface ClientOptions {
  /** Time one request may take, in milliseconds. */
  readonly timeoutMs?: number;
  /** How many times a rate-limited read is tried again. */
  readonly readRetries?: number;
  /** How the client waits between attempts; replaceable in tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** The fetch implementation; the runtime's own by default. */
  readonly fetch?: typeof fetch;
  /** The signer's clock, in epoch milliseconds; replaceable in tests. */
  readonly clock?: () => number;
  /** A number in [0, 1) for the backoff's jitter; replaceable in tests. */
  readonly random?: () => number;
}

/** One request, as the resource modules describe it. */
export interface RequestSpec {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** The path after the version, such as `/terminals/{id}`, with ids already filled in. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean | null | undefined>>;
  readonly body?: unknown;
  /** Required on every write; sent as the Idempotency-Key header. */
  readonly idempotencyKey?: string;
}

/** The status and parsed body of an answer. */
export interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** A tenant's connection to MFX Hub. */
export class MfxClient {
  readonly #signer: RequestSigner;
  readonly #base: URL;
  readonly #timeoutMs: number;
  readonly #readRetries: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #fetch: typeof fetch;
  readonly #random: () => number;
  #budget: Budget | null = null;

  /** The terminals this key's tenant owns. */
  readonly terminals: Terminals;
  /** Order entry. Every call resolves to a result; none rejects. */
  readonly execution: Execution;
  /** Brokers, symbols and quotes. */
  readonly catalog: Catalog;

  /**
   * @param baseUrl the API's base, including the version: `https://api.mfxhub.com/v1`, or
   *   `https://api.dev.mfxhub.com/v1` for development
   * @param keyId the API key's id
   * @param privateKey its private key: PEM, the base64 of its 32 bytes, or a SigningKey
   */
  constructor(
    baseUrl: string,
    keyId: string,
    privateKey: string | Uint8Array | SigningKey,
    options: ClientOptions = {},
  ) {
    this.#base = new URL(baseUrl.replace(/\/+$/, "") + "/");
    this.#signer = new RequestSigner(keyId, privateKey, options.clock);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#readRetries = options.readRetries ?? DEFAULT_READ_RETRIES;
    this.#sleep = options.sleep ?? wait;
    this.#fetch = options.fetch ?? fetch;
    this.#random = options.random ?? Math.random;
    this.terminals = new Terminals(this);
    this.execution = new Execution(this);
    this.catalog = new Catalog(this);
  }

  /** The id of the key this client signs with. Safe to log, unlike the private key. */
  get keyId(): string {
    return this.#signer.keyId;
  }

  /** The REST base this client was pointed at. The stream's address is derived from it. */
  get baseUrl(): string {
    return this.#base.href.replace(/\/$/, "");
  }

  /** What the key had left when MFX Hub last answered; null before the first answer. */
  get budget(): Budget | null {
    return this.#budget;
  }

  /** The signer, for the stream's upgrade. Not part of the public surface. */
  get signer(): RequestSigner {
    return this.#signer;
  }

  /**
   * Jittered exponential backoff for an attempt, when the platform gave no delay: up to 1 s, 2 s,
   * 4 s ... capped at 30 s. The reads and the stream's reconnects share it, so they lean on this
   * tenant's quota at the same rate.
   */
  backoffMs(attempt: number): number {
    return Math.round(this.#random() * Math.min(1000 * 2 ** attempt, BACKOFF_CAP_MS));
  }

  /**
   * The multiplexed event stream, opened: subscribe, then iterate. Close it when done.
   * Reconnects underneath, resuming what replays; see {@link MfxStream}.
   */
  stream(options: StreamOptions = {}): Promise<MfxStream> {
    return new MfxStream(this, options).open();
  }

  /** How the client waits; the stream uses it between reconnects. */
  pause(ms: number): Promise<void> {
    return this.#sleep(ms);
  }

  /** A read: retried after a 429 with the platform's own delay; a failure throws its typed error. */
  async read(spec: RequestSpec): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const answer = await this.send(spec);
      if (answer.status === 429 && attempt < this.#readRetries) {
        const told = retryAfterSeconds(answer.headers.get("Retry-After"));
        await this.#sleep(told === null ? this.backoffMs(attempt) : 1000 * told);
        continue;
      }
      throwFor(answer, spec);
      return answer.body;
    }
  }

  /** A write: sent once, never retried; a failure throws its typed error. */
  async write(spec: RequestSpec): Promise<unknown> {
    const answer = await this.send(spec);
    throwFor(answer, spec);
    return answer.body;
  }

  /** One attempt, signed afresh. Transport faults become MfxTransportError or MfxTimeout. */
  async send(spec: RequestSpec): Promise<Answer> {
    const url = new URL(spec.path.replace(/^\//, ""), this.#base);
    for (const [name, value] of Object.entries(spec.query ?? {})) {
      if (value !== null && value !== undefined) url.searchParams.set(name, String(value));
    }
    const body =
      spec.body === undefined ? new Uint8Array() : Buffer.from(JSON.stringify(spec.body));
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...this.#signer.headersFor(spec.method, url.pathname + url.search, body),
    };
    if (spec.body !== undefined) headers["Content-Type"] = "application/json";
    if (spec.idempotencyKey !== undefined) headers["Idempotency-Key"] = spec.idempotencyKey;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: spec.method,
        headers,
        ...(spec.body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw transportError(error, spec);
    }
    const text = await response.text();
    this.#noteBudget(response.headers);
    let parsed: unknown = null;
    if (text !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: response.status, headers: response.headers, body: parsed };
  }

  #noteBudget(headers: Headers): void {
    const remaining = headers.get("X-MFX-Budget-Remaining");
    if (remaining !== null && Number.isFinite(Number(remaining))) {
      this.#budget = {
        remaining: Number(remaining),
        source: headers.get("X-MFX-Budget-Source") ?? "",
      };
    }
  }

  toString(): string {
    return `MfxClient(${this.baseUrl}, ${this.keyId})`;
  }
}

/** The typed error a failed answer means, or nothing for a success. */
export function throwFor(answer: Answer, spec: RequestSpec): void {
  if (answer.status < 400) return;
  const body: unknown = answer.body;
  const error =
    typeof body === "object" && body !== null
      ? (body as { error?: { code?: unknown; message?: unknown; details?: unknown } }).error
      : undefined;
  const code = typeof error?.code === "string" ? error.code : "";
  const message =
    typeof error?.message === "string" ? error.message : `${spec.method} ${spec.path} failed`;
  const details =
    typeof error?.details === "object" && error.details !== null
      ? (error.details as Record<string, unknown>)
      : {};
  throw errorFor(
    code,
    message,
    answer.status,
    details,
    retryAfterSeconds(answer.headers.get("Retry-After")),
  );
}

function transportError(error: unknown, spec: RequestSpec): MfxTransportError {
  const what = `${spec.method} ${spec.path}`;
  if (
    error instanceof DOMException &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  ) {
    return new MfxTimeout(`${what}: no answer in time`);
  }
  const cause = (error as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
  const code = typeof cause?.code === "string" ? cause.code : "";
  const text = error instanceof Error ? error.message : String(error);
  return new MfxTransportError(`${what}: ${text}${code ? ` (${code})` : ""}`, !NOT_SENT.has(code));
}

export { MfxApiError };
