/**
 * `NearPay-Signature` (api-conventions §9, lld/webhooks.md §6, spec `webhooks/signature.ts`):
 *
 *   t=<unix>,v1=<hex HMAC-SHA256(secret, t.body)>[,v1=<secondary>],v1a=<base64url Ed25519(t.body)>,kid=<kid>
 *
 * The HMAC key is the UTF-8 bytes of the whole secret including `whsec_`; both signatures cover the
 * UTF-8 bytes of `<t>.<raw body>` (spec test vector `webhook-signatures.json`).
 */
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  randomBytes,
  sign,
} from "node:crypto";
import { formatSignatureHeader, signedPayload } from "@nearpay/spec";

export interface WebhookSigningKey {
  readonly kid: string;
  readonly privateKey: KeyObject;
  /** Raw 32-byte public key. */
  readonly publicKey: Buffer;
}

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** Raw public key of an Ed25519 private key. */
function rawPublic(privateKey: KeyObject): Buffer {
  const jwk = createPublicKey(privateKey).export({ format: "jwk" }) as { x?: string };
  return Buffer.from(jwk.x as string, "base64url");
}

/** Default key id: `wh-` + 12 hex of SHA-256(raw public key) (stable across restarts and replicas). */
export function defaultKid(publicKey: Buffer): string {
  return `wh-${createHash("sha256").update(publicKey).digest("hex").slice(0, 12)}`;
}

function fromPrivate(privateKey: KeyObject, kid: string | undefined): WebhookSigningKey {
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("the webhook signing key must be Ed25519");
  const publicKey = rawPublic(privateKey);
  return { kid: kid ?? defaultKid(publicKey), privateKey, publicKey };
}

/** Loads the platform key from its PKCS#8 PEM (`NP_WEBHOOK_SIGNING_KEY_FILE`). */
export function loadSigningKey(pem: string, kid?: string): WebhookSigningKey {
  return fromPrivate(createPrivateKey(pem), kid);
}

/** Key from a raw 32-byte seed (hex); used for the spec test vectors. */
export function signingKeyFromSeed(seedHex: string, kid?: string): WebhookSigningKey {
  const seed = Buffer.from(seedHex, "hex");
  if (seed.length !== 32) throw new Error("an Ed25519 seed is 32 bytes");
  return fromPrivate(
    createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" }),
    kid,
  );
}

/** `v1`: hex HMAC-SHA256 keyed with the UTF-8 bytes of the full secret. */
export function hmacV1(secret: string, payload: string): string {
  return createHmac("sha256", Buffer.from(secret, "utf8")).update(Buffer.from(payload, "utf8")).digest("hex");
}

/** `v1a`: base64url Ed25519 signature. */
export function ed25519V1a(key: WebhookSigningKey, payload: string): string {
  return sign(null, Buffer.from(payload, "utf8"), key.privateKey).toString("base64url");
}

/** The header value for one delivery; `secrets` lists the current secret first, then a secondary one. */
export function signatureHeader(o: {
  timestamp: number;
  body: string;
  secrets: readonly string[];
  key: WebhookSigningKey;
}): string {
  const payload = signedPayload(o.timestamp, o.body);
  return formatSignatureHeader({
    timestamp: o.timestamp,
    v1: o.secrets.map((s) => hmacV1(s, payload)),
    v1a: ed25519V1a(o.key, payload),
    kid: o.key.kid,
  });
}

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A new endpoint secret: `whsec_` + 48 base62 characters (≈ 285 bits). */
export function newEndpointSecret(): string {
  let out = "";
  while (out.length < 48) {
    for (const b of randomBytes(64)) {
      if (b < 248 && out.length < 48) out += ALPHABET[b % 62];
    }
  }
  return `whsec_${out}`;
}

/** JWK of the public key (`GET /v1/webhook_signing_keys`). */
export function publicJwk(key: WebhookSigningKey) {
  return {
    kty: "OKP" as const,
    crv: "Ed25519" as const,
    x: key.publicKey.toString("base64url"),
    kid: key.kid,
    alg: "EdDSA" as const,
    use: "sig" as const,
  };
}
