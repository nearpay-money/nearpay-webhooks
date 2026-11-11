/**
 * Property tests for endpoint secret rotation (lld/webhooks.md §5 `rotate_secret`, §6 signing;
 * api-conventions §9): after any sequence of rotations (random overlaps 0–86 400 s, random gaps), a
 * delivery signed at any instant verifies under exactly the right secrets — the current one always, the
 * one rotated out by the latest rotation strictly before that rotation's expiry, no other secret ever.
 * The oracle below is written from the spec text, independently of `src/domain/endpoint/secrets.ts`.
 */
import { timingSafeEqual } from "node:crypto";
import { parseSignatureHeader, signedPayload } from "@nearpay-money/spec";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  activeSecrets,
  MAX_OVERLAP_SECONDS,
  previousExpiry,
  rotateSecret,
  type SecretState,
} from "../../src/domain/endpoint/secrets.js";
import { hmacV1, newEndpointSecret, signatureHeader, signingKeyFromSeed } from "../../src/signing/signer.js";

const key = signingKeyFromSeed("22".repeat(32), "wh-prop");
const BODY = '{"id":"evt_x","object":"event"}';

/** Receiver-side HMAC check (what SDK verify helpers do), with one secret. */
function verifiesWith(header: string, secret: string): boolean {
  const h = parseSignatureHeader(header);
  if (!h) return false;
  const want = Buffer.from(hmacV1(secret, signedPayload(h.timestamp, BODY)), "hex");
  return h.v1.some((v) => {
    const got = Buffer.from(v, "hex");
    return got.length === want.length && timingSafeEqual(got, want);
  });
}

type Op =
  | { kind: "rotate"; gapMs: number; expire: number }
  | { kind: "check"; offsetMs: number }
  | { kind: "edge"; delta: -1 | 0 | 1 };

const expire = fc.oneof(
  fc.constant(0),
  fc.constant(MAX_OVERLAP_SECONDS),
  fc.integer({ min: 1, max: 120 }),
  fc.integer({ min: 0, max: MAX_OVERLAP_SECONDS }),
);
const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant("rotate" as const),
    gapMs: fc.oneof(fc.constant(0), fc.nat(5_000), fc.nat(2 * 86_400_000)),
    expire,
  }),
  fc.record({ kind: fc.constant("check" as const), offsetMs: fc.oneof(fc.nat(5_000), fc.nat(3 * 86_400_000)) }),
  fc.record({ kind: fc.constant("edge" as const), delta: fc.constantFrom(-1 as const, 0 as const, 1 as const) }),
);

describe("secret rotation", () => {
  it("signs with exactly the right secrets at every instant", () => {
    fc.assert(
      fc.property(fc.array(op, { minLength: 1, maxLength: 30 }), (ops) => {
        const issued: string[] = [newEndpointSecret()];
        let state: SecretState<string> = { current: issued[0] as string, previous: null, previousExpiresAt: null };
        let clock = 1_800_000_000_000;
        // oracle: the latest rotation (time, overlap, the secret it retired)
        let last: { at: number; expire: number; retired: string } | null = null;

        const check = (t: number) => {
          const secrets = activeSecrets(state, t);
          const header = signatureHeader({ timestamp: Math.floor(t / 1000), body: BODY, secrets, key });
          const inWindow = last !== null && last.expire > 0 && t < last.at + last.expire * 1000;
          const right = new Set([state.current, ...(inWindow && last ? [last.retired] : [])]);
          for (const s of issued) expect(verifiesWith(header, s)).toBe(right.has(s));
          expect(parseSignatureHeader(header)?.v1).toHaveLength(right.size);
          expect(previousExpiry(state, t)).toBe(inWindow && last ? last.at + last.expire * 1000 : null);
          // current secret first: verifiers that only look at the first v1 still work with the new secret
          expect(parseSignatureHeader(header)?.v1[0]).toBe(
            hmacV1(state.current, signedPayload(Math.floor(t / 1000), BODY)),
          );
        };

        for (const o of ops) {
          if (o.kind === "rotate") {
            clock += o.gapMs;
            const next = newEndpointSecret();
            issued.push(next);
            last = { at: clock, expire: o.expire, retired: state.current };
            state = rotateSecret(state, next, o.expire, clock);
            expect(state.current).toBe(next);
            if (state.previousExpiresAt !== null)
              expect(state.previousExpiresAt - clock).toBeLessThanOrEqual(MAX_OVERLAP_SECONDS * 1000);
            check(clock);
          } else if (o.kind === "check") {
            check(clock + o.offsetMs);
          } else if (last && last.expire > 0) {
            const t = last.at + last.expire * 1000 + o.delta;
            if (t >= clock) check(t);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it("refuses overlaps outside 0…86 400 s and fractional ones", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ max: -1 }),
          fc.integer({ min: MAX_OVERLAP_SECONDS + 1 }),
          fc.double({ noNaN: true }).filter((x) => !Number.isInteger(x)),
        ),
        (bad) => {
          const s: SecretState<string> = { current: "a", previous: null, previousExpiresAt: null };
          expect(() => rotateSecret(s, "b", bad, 0)).toThrow(RangeError);
        },
      ),
    );
  });
});
