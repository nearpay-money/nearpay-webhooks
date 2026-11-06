/** Retry schedule, abandonment at 72 h and endpoint disable (lld/webhooks.md §6, §11) on a fake clock. */
import { fakeClock } from "@nearpay-internal/testing";
import { describe, expect, it } from "vitest";
import {
  afterAttempt,
  codeClass,
  type DeliveryState,
  type EndpointState,
  GIVE_UP_AFTER_MS,
  isSuccess,
  isTerminal,
  RETRY_SCHEDULE_MS,
  retryDelayMs,
} from "../../src/domain/delivery/schedule.js";

const M = 60_000;
const H = 60 * M;

describe("retry schedule", () => {
  it("is 1 m, 5 m, 30 m, 2 h, 5 h, 10 h, then every 12 h", () => {
    expect(RETRY_SCHEDULE_MS).toEqual([M, 5 * M, 30 * M, 2 * H, 5 * H, 10 * H, 12 * H]);
    expect([1, 2, 3, 4, 5, 6, 7, 8, 20].map((n) => retryDelayMs(n, 0.5))).toEqual([
      M,
      5 * M,
      30 * M,
      2 * H,
      5 * H,
      10 * H,
      12 * H,
      12 * H,
      12 * H,
    ]);
  });

  it("jitters ±10 %", () => {
    expect(retryDelayMs(1, 0)).toBe(54_000);
    expect(retryDelayMs(1, 0.999999)).toBe(66_000);
    expect(retryDelayMs(0, 0.5)).toBe(M); // clamped to the first step
  });

  it("classifies responses", () => {
    expect([200, 204, 299].every(isSuccess)).toBe(true);
    expect([null, 199, 300, 301, 404, 500].some(isSuccess)).toBe(false);
    expect([null, 99, 200, 302, 404, 503, 600].map(codeClass)).toEqual([
      "none",
      "none",
      "2xx",
      "3xx",
      "4xx",
      "5xx",
      "none",
    ]);
    expect(isTerminal("succeeded") && isTerminal("abandoned")).toBe(true);
    expect(isTerminal("pending") || isTerminal("failed")).toBe(false);
  });
});

describe("delivery outcomes", () => {
  const clock = fakeClock();
  const t0 = clock.now();
  const fresh: DeliveryState = { status: "pending", attempts: 0, createdAt: t0 };
  const healthy: EndpointState = { status: "enabled", failingSince: null, lastSuccessAt: null };

  it("a 2xx succeeds the delivery and clears the endpoint's failure streak", () => {
    const o = afterAttempt(fresh, { ...healthy, failingSince: t0 - H }, 204, t0, 0.5);
    expect(o.delivery).toEqual({ status: "succeeded", attempts: 1, nextAttemptAt: null, succeededAt: t0 });
    expect(o.endpoint).toEqual({ failingSince: null, lastSuccessAt: t0, disable: false });
  });

  it("a failure schedules the next try and starts the streak", () => {
    const o = afterAttempt(fresh, healthy, 500, t0, 0.5);
    expect(o.delivery).toEqual({ status: "failed", attempts: 1, nextAttemptAt: t0 + M, succeededAt: null });
    expect(o.endpoint).toEqual({ failingSince: t0, lastSuccessAt: null, disable: false });
    const network = afterAttempt(
      { ...fresh, status: "failed", attempts: 3 },
      { ...healthy, failingSince: t0 },
      null,
      t0 + H,
      0.5,
    );
    expect(network.delivery.nextAttemptAt).toBe(t0 + H + 2 * H);
    expect(network.endpoint.failingSince).toBe(t0);
  });

  it("walks the schedule until 72 h after creation, then abandons", () => {
    let d: DeliveryState = fresh;
    let e: EndpointState = { ...healthy, lastSuccessAt: t0 - 1 };
    let now = t0;
    const tries: number[] = [];
    for (;;) {
      const o = afterAttempt(d, e, 503, now, 0.5);
      tries.push(now - t0);
      d = { ...d, status: o.delivery.status, attempts: o.delivery.attempts };
      e = { ...e, failingSince: o.endpoint.failingSince };
      if (o.delivery.status === "abandoned") break;
      now = o.delivery.nextAttemptAt as number;
    }
    expect(tries.slice(0, 4)).toEqual([0, M, 6 * M, 36 * M]);
    expect(d.attempts).toBe(tries.length);
    expect(tries.at(-1) as number).toBeGreaterThanOrEqual(GIVE_UP_AFTER_MS);
    expect(tries.at(-2) as number).toBeLessThan(GIVE_UP_AFTER_MS);
  });

  it("abandons exactly at 72 h after creation", () => {
    expect(afterAttempt(fresh, healthy, 500, t0 + GIVE_UP_AFTER_MS - 1, 0.5).delivery.status).toBe("failed");
    expect(afterAttempt(fresh, healthy, 500, t0 + GIVE_UP_AFTER_MS, 0.5).delivery).toMatchObject({
      status: "abandoned",
      nextAttemptAt: null,
    });
  });

  it("disables an enabled endpoint after more than 72 h of continuous failure", () => {
    const failing = { ...healthy, failingSince: t0 };
    expect(afterAttempt(fresh, failing, 500, t0 + GIVE_UP_AFTER_MS, 0.5).endpoint.disable).toBe(false);
    expect(afterAttempt(fresh, failing, 500, t0 + GIVE_UP_AFTER_MS + 1, 0.5).endpoint.disable).toBe(true);
    // already disabled (merchant) → no second disable
    expect(
      afterAttempt(fresh, { ...failing, status: "disabled" }, 500, t0 + GIVE_UP_AFTER_MS + 1, 0.5).endpoint.disable,
    ).toBe(false);
    // a success in between resets the streak
    const ok = afterAttempt(fresh, failing, 200, t0 + 71 * H, 0.5);
    const later = afterAttempt(fresh, { ...failing, failingSince: ok.endpoint.failingSince }, 500, t0 + 80 * H, 0.5);
    expect(later.endpoint).toMatchObject({ failingSince: t0 + 80 * H, disable: false });
  });
});
