/**
 * Property tests for resend (lld/webhooks.md §5 `resendEvent`): over any sequence of resends (random
 * target lists with repeats, endpoints with or without an original delivery), no `(event, endpoint,
 * resend_no)` is ever planned twice, every resend number is ≥ 1, numbers per pair stay contiguous, and
 * targets without `endpoint` are exactly the enabled endpoints subscribed to the type.
 */
import { WEBHOOK_TYPE_NAMES } from "@nearpay/spec";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_RESEND_NO, planResend, type ResendTarget, resendTargets } from "../../src/domain/delivery/resend.js";

const ENDPOINTS = ["e0", "e1", "e2", "e3", "e4"];
const key = (endpoint: string, n: number) => `${endpoint}#${n}`;

describe("resend allocation", () => {
  it("never duplicates (event, endpoint, resend_no)", () => {
    fc.assert(
      fc.property(
        fc.subarray(ENDPOINTS), // endpoints that got the original delivery (resend_no 0)
        fc.array(fc.array(fc.constantFrom(...ENDPOINTS), { maxLength: 8 }), { minLength: 1, maxLength: 25 }),
        (originals, resends) => {
          const stored = new Set<string>(originals.map((e) => key(e, 0)));
          for (const targets of resends) {
            const highest = new Map<string, number>();
            for (const k of stored) {
              const [e, n] = k.split("#") as [string, string];
              highest.set(e, Math.max(highest.get(e) ?? -1, Number(n)));
            }
            const plan = planResend(targets, highest);
            expect(plan).not.toBeNull();
            const keys = (plan ?? []).map((p) => key(p.endpoint, p.resendNo));
            expect(new Set(keys).size).toBe(keys.length); // once per endpoint per resend
            expect(new Set((plan ?? []).map((p) => p.endpoint))).toEqual(new Set(targets));
            for (const p of plan ?? []) {
              expect(p.resendNo).toBeGreaterThanOrEqual(1);
              expect(stored.has(key(p.endpoint, p.resendNo))).toBe(false);
            }
            for (const k of keys) stored.add(k);
          }
          // per endpoint: an optional original (0), then 1…k without gaps
          for (const e of ENDPOINTS) {
            const ns = [...stored]
              .filter((k) => k.startsWith(`${e}#`))
              .map((k) => Number(k.split("#")[1]))
              .filter((n) => n > 0)
              .sort((a, b) => a - b);
            expect(ns).toEqual(ns.map((_, i) => i + 1));
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it("refuses a resend once a pair has used every smallint number", () => {
    expect(planResend(["e0"], new Map([["e0", MAX_RESEND_NO]]))).toBeNull();
    expect(planResend(["e0"], new Map([["e0", MAX_RESEND_NO - 1]]))).toEqual([
      { endpoint: "e0", resendNo: MAX_RESEND_NO },
    ]);
  });
});

const types = WEBHOOK_TYPE_NAMES.filter((t) => t !== "ping");
const endpoint: fc.Arbitrary<ResendTarget> = fc.record({
  id: fc.constantFrom(...ENDPOINTS),
  status: fc.constantFrom("enabled" as const, "disabled" as const),
  enabled_events: fc.oneof(fc.constant(["*"]), fc.subarray(types, { minLength: 1 })),
});

describe("resend targets", () => {
  it("are the enabled endpoints subscribed to the type; a ping only goes to the endpoint it tested", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(endpoint, { selector: (e) => e.id }),
        fc.constantFrom(...WEBHOOK_TYPE_NAMES),
        fc.option(fc.constantFrom(...ENDPOINTS), { nil: null }),
        (eps, type, pinged) => {
          const got = resendTargets(type, eps, pinged);
          for (const e of eps) {
            const want =
              e.status === "enabled" &&
              (type === "ping" ? e.id === pinged : e.enabled_events.includes("*") || e.enabled_events.includes(type));
            expect(got.includes(e.id), `${e.id} ${type}`).toBe(want);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
