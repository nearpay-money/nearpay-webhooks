/** Signature vectors shared with `@nearpay-money/node`'s verify helper (spec test-vectors/webhook-signatures.json). */
import { createPublicKey, verify as edVerify, generateKeyPairSync, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parseSignatureHeader, signedPayload, WEBHOOK_TOLERANCE_SECONDS } from "@nearpay-money/spec";
import { describe, expect, it } from "vitest";
import {
  defaultKid,
  ed25519V1a,
  hmacV1,
  loadSigningKey,
  newEndpointSecret,
  publicJwk,
  signatureHeader,
  signingKeyFromSeed,
} from "../../src/signing/signer.js";

const require = createRequire(import.meta.url);
const V = JSON.parse(
  readFileSync(require.resolve("@nearpay-money/spec/test-vectors/webhook-signatures.json"), "utf8"),
) as {
  secret: string;
  secondary_secret: string;
  ed25519: { kid: string; seed_hex: string; public_key_base64url: string };
  timestamp: number;
  raw_body: string;
  signed_payload: string;
  header: string;
  header_during_rotation: string;
  negative: { reason: string; raw_body: string; header: string; now: number }[];
  verify_at: number;
};

const key = signingKeyFromSeed(V.ed25519.seed_hex, V.ed25519.kid);

/** A receiver-side verifier (the algorithm SDK helpers implement). */
function verifies(header: string, body: string, secret: string, now: number): boolean {
  const h = parseSignatureHeader(header);
  if (!h || Math.abs(now - h.timestamp) > WEBHOOK_TOLERANCE_SECONDS) return false;
  const payload = signedPayload(h.timestamp, body);
  const expected = Buffer.from(hmacV1(secret, payload), "hex");
  const hmacOk = h.v1.some((s) => timingSafeEqual(Buffer.from(s, "hex"), expected));
  if (!hmacOk) return false;
  if (!h.v1a) return true;
  const pub = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: V.ed25519.public_key_base64url },
    format: "jwk",
  });
  return edVerify(null, Buffer.from(payload, "utf8"), pub, Buffer.from(h.v1a, "base64url"));
}

describe("webhook signature vectors", () => {
  it("derives the vector's public key and JWK", () => {
    expect(key.publicKey.toString("base64url")).toBe(V.ed25519.public_key_base64url);
    expect(publicJwk(key)).toEqual({
      kty: "OKP",
      crv: "Ed25519",
      x: V.ed25519.public_key_base64url,
      kid: "wh-test-1",
      alg: "EdDSA",
      use: "sig",
    });
  });

  it("produces the exact header of the vector, and the rotation header with two secrets", () => {
    expect(signedPayload(V.timestamp, V.raw_body)).toBe(V.signed_payload);
    expect(signatureHeader({ timestamp: V.timestamp, body: V.raw_body, secrets: [V.secret], key })).toBe(V.header);
    expect(
      signatureHeader({ timestamp: V.timestamp, body: V.raw_body, secrets: [V.secret, V.secondary_secret], key }),
    ).toBe(V.header_during_rotation);
    expect(ed25519V1a(key, V.signed_payload)).toBe(parseSignatureHeader(V.header)?.v1a);
  });

  it("verifies with either secret during a rotation and rejects every negative vector", () => {
    expect(verifies(V.header, V.raw_body, V.secret, V.verify_at)).toBe(true);
    expect(verifies(V.header_during_rotation, V.raw_body, V.secondary_secret, V.verify_at)).toBe(true);
    for (const n of V.negative) expect(verifies(n.header, n.raw_body, V.secret, n.now), n.reason).toBe(false);
  });
});

describe("keys and secrets", () => {
  it("loads a PEM key with a stable default kid", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const a = loadSigningKey(pem);
    const b = loadSigningKey(pem);
    expect(a.kid).toMatch(/^wh-[0-9a-f]{12}$/);
    expect(a.kid).toBe(b.kid);
    expect(a.kid).toBe(defaultKid(a.publicKey));
    expect(loadSigningKey(pem, "wh-custom").kid).toBe("wh-custom");
  });

  it("refuses non-Ed25519 keys and bad seeds", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    expect(() => loadSigningKey(privateKey.export({ type: "pkcs8", format: "pem" }).toString())).toThrow(/Ed25519/);
    expect(() => signingKeyFromSeed("00")).toThrow(/32 bytes/);
  });

  it("generates whsec_ secrets in the spec format, never twice the same", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const s = newEndpointSecret();
      expect(s).toMatch(/^whsec_[0-9A-Za-z]{48}$/);
      seen.add(s);
    }
    expect(seen.size).toBe(200);
  });
});
