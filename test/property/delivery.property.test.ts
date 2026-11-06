/**
 * Property tests (foundations §16): random sequences of delivery attempts and random URLs never
 * violate the delivery rules (lld/webhooks.md §6, §8).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  afterAttempt,
  type DeliveryState,
  type EndpointState,
  GIVE_UP_AFTER_MS,
  JITTER,
  RETRY_SCHEDULE_MS,
} from "../../src/domain/delivery/schedule.js";
import { endpointUrlProblem } from "../../src/domain/endpoint/url.js";

const status = fc.oneof(
  fc.constant(null),
  fc.integer({ min: 200, max: 299 }),
  fc.integer({ min: 300, max: 599 }),
  fc.integer({ min: 100, max: 199 }),
);

describe("delivery attempts", () => {
  it("follow the schedule, succeed only on 2xx, abandon only after 72 h, disable only after a > 72 h failure streak", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            status,
            rand: fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
            lag: fc.nat(3 * 3_600_000),
          }),
          {
            minLength: 1,
            maxLength: 60,
          },
        ),
        (steps) => {
          const t0 = 1_800_000_000_000;
          let d: DeliveryState = { status: "pending", attempts: 0, createdAt: t0 };
          let e: EndpointState = { status: "enabled", failingSince: null, lastSuccessAt: null };
          let now = t0;
          for (const s of steps) {
            if (d.status === "succeeded" || d.status === "abandoned") break;
            const o = afterAttempt(d, e, s.status, now, s.rand);
            expect(o.delivery.attempts).toBe(d.attempts + 1);
            const ok = s.status !== null && s.status >= 200 && s.status <= 299;
            if (ok) {
              expect(o.delivery.status).toBe("succeeded");
              expect(o.endpoint.failingSince).toBeNull();
              expect(o.endpoint.disable).toBe(false);
            } else {
              expect(o.endpoint.failingSince).not.toBeNull();
              expect(o.endpoint.failingSince as number).toBeLessThanOrEqual(now);
              if (o.delivery.status === "abandoned") {
                expect(now - d.createdAt).toBeGreaterThanOrEqual(GIVE_UP_AFTER_MS);
                expect(o.delivery.nextAttemptAt).toBeNull();
              } else {
                expect(o.delivery.status).toBe("failed");
                expect(now - d.createdAt).toBeLessThan(GIVE_UP_AFTER_MS);
                const base = RETRY_SCHEDULE_MS[Math.min(o.delivery.attempts, RETRY_SCHEDULE_MS.length) - 1] as number;
                const delay = (o.delivery.nextAttemptAt as number) - now;
                expect(delay).toBeGreaterThanOrEqual(Math.floor(base * (1 - JITTER)));
                expect(delay).toBeLessThanOrEqual(Math.ceil(base * (1 + JITTER)));
              }
              if (o.endpoint.disable) {
                expect(e.status).toBe("enabled");
                expect(now - (o.endpoint.failingSince as number)).toBeGreaterThan(GIVE_UP_AFTER_MS);
              }
            }
            d = { ...d, status: o.delivery.status, attempts: o.delivery.attempts };
            e = {
              status: o.endpoint.disable ? "disabled" : e.status,
              failingSince: o.endpoint.failingSince,
              lastSuccessAt: o.endpoint.lastSuccessAt,
            };
            now = (o.delivery.nextAttemptAt ?? now) + s.lag;
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});

const octet = fc.integer({ min: 0, max: 255 });

describe("SSRF", () => {
  it("never accepts a private, loopback, link-local or CGNAT IPv4 literal on the server stage", () => {
    const privateIp = fc.oneof(
      fc.tuple(fc.constant(10), octet, octet, octet),
      fc.tuple(fc.constant(127), octet, octet, octet),
      fc.tuple(fc.constant(169), fc.constant(254), octet, octet),
      fc.tuple(fc.constant(172), fc.integer({ min: 16, max: 31 }), octet, octet),
      fc.tuple(fc.constant(192), fc.constant(168), octet, octet),
      fc.tuple(fc.constant(100), fc.integer({ min: 64, max: 127 }), octet, octet),
      fc.tuple(fc.integer({ min: 224, max: 255 }), octet, octet, octet),
    );
    fc.assert(
      fc.property(privateIp, fc.boolean(), fc.constantFrom("", ":443", ":80"), (ip, livemode, port) => {
        expect(endpointUrlProblem(`https://${ip.join(".")}${port}/hook`, { env: "server", livemode })).not.toBeNull();
        expect(endpointUrlProblem(`https://[::ffff:${ip.join(".")}]/hook`, { env: "server", livemode })).not.toBeNull();
      }),
      { numRuns: 500 },
    );
  });

  it("never accepts a port other than 80/443 for a public host", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 65_535 }).filter((p) => p !== 80 && p !== 443),
        (port) => {
          expect(
            endpointUrlProblem(`https://shop.example.com:${port}/`, { env: "server", livemode: true }),
          ).not.toBeNull();
        },
      ),
    );
  });
});
