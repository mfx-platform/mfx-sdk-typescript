import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import { RequestSigner, SigningKey, signingMessage } from "../../src/index.js";

const SEED = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const VECTOR =
  "OLOeJhRskf6kvodIyvrrpI/Hwlg3MXn//TTc64zpcl0qACk3BOhNfMV8yrVthZUdUXlOCntJAIrfgHTNK6faDg==";

/** A private key as PKCS#8 PEM text. @types/node 22 says string or Buffer, 26 says string. */
function pemOf(key: KeyObject): string {
  // Declared unknown so neither version's type makes one branch impossible.
  const pem: unknown = key.export({ format: "pem", type: "pkcs8" });
  return typeof pem === "string" ? pem : (pem as Buffer).toString("utf8");
}

describe("every request is signed with the tenant's Ed25519 key and the key is never printed", () => {
  it("reproduces the API description's test vector byte for byte", () => {
    const message = signingMessage(
      "1790000000000",
      "3f0c9a4e5b7d4c1e9a2b6d8f0a1c2e3f",
      "post",
      "/v1/terminals?dry_run=false",
      Buffer.from('{"farm_id":"00000000-0000-0000-0000-000000000001"}'),
    );
    expect(new SigningKey(SEED.toString("base64")).sign(message)).toBe(VECTOR);
    expect(new SigningKey(new Uint8Array(SEED)).sign(message)).toBe(VECTOR);
    expect(new SigningKey(new SigningKey(SEED)).sign(message)).toBe(VECTOR);
  });

  it("takes a PEM key, and refuses one that is not Ed25519 or not 32 bytes", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = pemOf(privateKey);
    expect(new SigningKey(pem).sign(Buffer.from("x"))).toHaveLength(88);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey;
    expect(() => new SigningKey(pemOf(rsa))).toThrow(/Ed25519, not rsa/);
    expect(() => new SigningKey("c2hvcnQ=")).toThrow(/32 raw bytes/);
    expect(() => new SigningKey("not base64 at all!")).toThrow(/32 raw bytes/);
  });

  it("never prints the key", () => {
    const key = new SigningKey(SEED);
    expect(String(key)).toBe("SigningKey(***)");
    expect(JSON.stringify({ key })).toBe('{"key":"***"}');
    expect(inspect(key)).toBe("SigningKey(***)");
  });

  it("refuses a nonce that could move the signed lines", () => {
    expect(() => signingMessage("1", "short", "GET", "/", new Uint8Array())).toThrow(RangeError);
    expect(() => signingMessage("1", "a".repeat(15) + "\n", "GET", "/", new Uint8Array())).toThrow(
      RangeError,
    );
  });

  it("signs every request afresh: the timestamp, a new nonce and the four headers", () => {
    const signer = new RequestSigner("mfxk_TEST", SEED, () => 1790000000000.7);
    const first = signer.headersFor("GET", "/v1/terminals");
    const second = signer.headersFor("GET", "/v1/terminals");
    expect(first["X-MFX-Key"]).toBe("mfxk_TEST");
    expect(first["X-MFX-Timestamp"]).toBe("1790000000000");
    expect(first["X-MFX-Nonce"]).not.toBe(second["X-MFX-Nonce"]);
    expect(first["X-MFX-Signature"]).toHaveLength(88);
    const fixed = new RequestSigner(
      "k",
      SEED,
      () => 1790000000000,
      () => "3f0c9a4e5b7d4c1e9a2b6d8f0a1c2e3f",
    );
    const body = Buffer.from('{"farm_id":"00000000-0000-0000-0000-000000000001"}');
    expect(fixed.headersFor("POST", "/v1/terminals?dry_run=false", body)["X-MFX-Signature"]).toBe(
      VECTOR,
    );
  });
});
