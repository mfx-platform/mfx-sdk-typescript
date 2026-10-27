/**
 * The four headers every MFX Hub request carries, and the key that makes them.
 *
 * A request is signed, not carrying a token: `X-MFX-Key` names the key, `X-MFX-Timestamp` and
 * `X-MFX-Nonce` make each request usable once, and `X-MFX-Signature` is an Ed25519 signature over
 *
 *     timestamp_ms \n nonce \n METHOD \n path_with_query \n sha256_hex(body)
 *
 * base64-encoded. The timestamp is epoch milliseconds and must be within 30 s of the server's
 * clock; the nonce is unique per key for five minutes, so a retry is always signed again.
 *
 * The private key is shown once when the key is issued and the platform never stores it. A
 * {@link SigningKey} prints as `***` everywhere it could be printed, so it cannot reach a log.
 */
import { createHash, createPrivateKey, randomBytes, sign, type KeyObject } from "node:crypto";
import { inspect } from "node:util";

export const KEY_HEADER = "X-MFX-Key";
export const TIMESTAMP_HEADER = "X-MFX-Timestamp";
export const NONCE_HEADER = "X-MFX-Nonce";
export const SIGNATURE_HEADER = "X-MFX-Signature";

/** What the platform accepts as a nonce: it is a line of the signed message. */
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
/** PKCS#8 wrapping for a raw 32-byte Ed25519 private key. */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SEED_BYTES = 32;

function load(material: string | Uint8Array): KeyObject {
  const text = typeof material === "string" ? material.trim() : null;
  if (text?.startsWith("-----BEGIN")) {
    const key = createPrivateKey(text);
    if (key.asymmetricKeyType !== "ed25519") {
      throw new TypeError(`an MFX Hub key is Ed25519, not ${String(key.asymmetricKeyType)}`);
    }
    return key;
  }
  const raw = text === null ? Buffer.from(material as Uint8Array) : Buffer.from(text, "base64");
  if (raw.length !== SEED_BYTES || (text !== null && raw.toString("base64") !== text)) {
    throw new TypeError(
      "a signing key is a PEM private key, or the base64 of its 32 raw bytes, or those bytes",
    );
  }
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, raw]),
    format: "der",
    type: "pkcs8",
  });
}

/** A tenant's Ed25519 private key, which renders as `***` wherever it could be printed. */
export class SigningKey {
  readonly #key: KeyObject;

  /** Accepts PEM, the base64 of the 32 raw bytes, the bytes themselves, or another SigningKey. */
  constructor(key: string | Uint8Array | SigningKey) {
    this.#key = key instanceof SigningKey ? key.#key : load(key);
  }

  /** The base64 signature of `message`. */
  sign(message: Uint8Array): string {
    return sign(null, message, this.#key).toString("base64");
  }

  toString(): string {
    return "SigningKey(***)";
  }

  toJSON(): string {
    return "***";
  }

  [inspect.custom](): string {
    return "SigningKey(***)";
  }
}

/** The exact bytes a request's signature covers. Refuses a nonce that could move the lines. */
export function signingMessage(
  timestamp: string,
  nonce: string,
  method: string,
  pathWithQuery: string,
  body: Uint8Array,
): Uint8Array {
  if (!NONCE.test(nonce)) {
    throw new RangeError(
      `a nonce is 16-64 characters of A-Z a-z 0-9 _ -; got ${nonce.length} characters`,
    );
  }
  const digest = createHash("sha256").update(body).digest("hex");
  return Buffer.from([timestamp, nonce, method.toUpperCase(), pathWithQuery, digest].join("\n"));
}

/** Makes the four headers for one request, with a fresh timestamp and nonce each time. */
export class RequestSigner {
  /**
   * @param keyId the key's id, safe to log
   * @param key the private key
   * @param clock milliseconds since the epoch; replaceable in tests
   * @param nonce a fresh nonce; replaceable in tests
   */
  constructor(
    readonly keyId: string,
    key: string | Uint8Array | SigningKey,
    private readonly clock: () => number = Date.now,
    private readonly nonce: () => string = () => randomBytes(16).toString("base64url"),
  ) {
    this.#key = new SigningKey(key);
  }

  readonly #key: SigningKey;

  /** The headers for one request: the stream's upgrade is signed through here too. */
  headersFor(
    method: string,
    pathWithQuery: string,
    body: Uint8Array = new Uint8Array(),
  ): Record<string, string> {
    const timestamp = String(Math.trunc(this.clock()));
    const nonce = this.nonce();
    return {
      [KEY_HEADER]: this.keyId,
      [TIMESTAMP_HEADER]: timestamp,
      [NONCE_HEADER]: nonce,
      [SIGNATURE_HEADER]: this.#key.sign(
        signingMessage(timestamp, nonce, method, pathWithQuery, body),
      ),
    };
  }
}
