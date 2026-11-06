/**
 * Delivery outcomes (lld/webhooks.md §6, api-conventions §9): success is any 2xx; a failure is retried
 * after 1 m, 5 m, 30 m, 2 h, 5 h, 10 h, then every 12 h (± 10 % jitter); a delivery is abandoned once
 * 72 h have passed since it was created; an endpoint whose deliveries have failed continuously for
 * more than 72 h (no success since the first failure) is disabled.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Base delay before retry n (index = attempts made so far − 1); the last entry repeats. */
export const RETRY_SCHEDULE_MS: readonly number[] = [
  MINUTE,
  5 * MINUTE,
  30 * MINUTE,
  2 * HOUR,
  5 * HOUR,
  10 * HOUR,
  12 * HOUR,
];
export const JITTER = 0.1;
/** Deliveries are abandoned and endpoints disabled after this long. */
export const GIVE_UP_AFTER_MS = 72 * HOUR;

/** Delay before the next try after `attempts` failed tries (≥ 1); `rand` ∈ [0, 1). */
export function retryDelayMs(attempts: number, rand: number): number {
  const i = Math.min(Math.max(attempts, 1), RETRY_SCHEDULE_MS.length) - 1;
  const base = RETRY_SCHEDULE_MS[i] as number;
  return Math.round(base * (1 - JITTER + 2 * JITTER * rand));
}

/** A 2xx response. */
export const isSuccess = (status: number | null): boolean => status !== null && status >= 200 && status <= 299;

export interface DeliveryState {
  readonly status: "pending" | "succeeded" | "failed" | "abandoned";
  readonly attempts: number;
  /** Epoch ms. */
  readonly createdAt: number;
}

export interface EndpointState {
  readonly status: "enabled" | "disabled";
  /** Epoch ms of the first failure of the current streak. */
  readonly failingSince: number | null;
  readonly lastSuccessAt: number | null;
}

export interface AttemptOutcome {
  readonly delivery: {
    readonly status: "succeeded" | "failed" | "abandoned";
    readonly attempts: number;
    readonly nextAttemptAt: number | null;
    readonly succeededAt: number | null;
  };
  readonly endpoint: {
    readonly failingSince: number | null;
    readonly lastSuccessAt: number | null;
    /** The endpoint must be disabled now (reason `failing`). */
    readonly disable: boolean;
  };
}

/** True when a delivery is in a terminal state (no further tries). */
export const isTerminal = (s: DeliveryState["status"]): boolean => s === "succeeded" || s === "abandoned";

/**
 * Applies one attempt's result (`status`: HTTP status, or null for a network error/timeout) at
 * `now` (epoch ms) to the delivery and its endpoint.
 */
export function afterAttempt(
  d: DeliveryState,
  e: EndpointState,
  status: number | null,
  now: number,
  rand: number,
): AttemptOutcome {
  const attempts = d.attempts + 1;
  if (isSuccess(status)) {
    return {
      delivery: { status: "succeeded", attempts, nextAttemptAt: null, succeededAt: now },
      endpoint: { failingSince: null, lastSuccessAt: now, disable: false },
    };
  }
  const failingSince = e.failingSince ?? now;
  const disable = e.status === "enabled" && now - failingSince > GIVE_UP_AFTER_MS;
  const expired = now - d.createdAt >= GIVE_UP_AFTER_MS;
  return {
    delivery: expired
      ? { status: "abandoned", attempts, nextAttemptAt: null, succeededAt: null }
      : { status: "failed", attempts, nextAttemptAt: now + retryDelayMs(attempts, rand), succeededAt: null },
    endpoint: { failingSince, lastSuccessAt: e.lastSuccessAt, disable },
  };
}

/** HTTP status class for metrics: `2xx`…`5xx`, or `none` (no response). */
export function codeClass(status: number | null): string {
  if (status === null || status < 100 || status > 599) return "none";
  return `${Math.floor(status / 100)}xx`;
}
