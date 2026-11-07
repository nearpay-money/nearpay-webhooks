/**
 * Resend planning (lld/webhooks.md §5 `resendEvent`). Pure.
 *
 * A resend creates one new delivery per target endpoint, keyed `(event, endpoint, resend_no)`:
 * `resend_no` 0 is the delivery made at ingest (or by `…/test`), every resend takes the next number
 * above the highest one the pair already has (so ≥ 1, even when the endpoint never got the original).
 * The caller holds a lock on the event row while it plans and inserts, so plans never race.
 */
import { subscribes } from "../endpoint/events.js";

/** `resend_no` is a smallint. */
export const MAX_RESEND_NO = 32_767;

export interface ResendTarget {
  readonly id: string;
  readonly status: "enabled" | "disabled";
  readonly enabled_events: readonly string[];
}

/**
 * Endpoints a resend without `endpoint` goes to: every enabled endpoint subscribed to the type. A
 * `ping` belongs to the endpoint it tested (`pingEndpoint`), never to `*` subscribers.
 */
export function resendTargets(
  type: string,
  endpoints: readonly ResendTarget[],
  pingEndpoint: string | null = null,
): string[] {
  return endpoints
    .filter((e) => e.status === "enabled")
    .filter((e) => (type === "ping" ? e.id === pingEndpoint : subscribes(e.enabled_events, type)))
    .map((e) => e.id);
}

export interface PlannedDelivery {
  readonly endpoint: string;
  readonly resendNo: number;
}

/**
 * Next `(endpoint, resend_no)` for each target. `highest` maps an endpoint to the highest `resend_no`
 * it already has for this event (absent: none). Duplicate targets are planned once. Returns null when
 * a pair has used every number (the resend is refused).
 */
export function planResend(targets: readonly string[], highest: ReadonlyMap<string, number>): PlannedDelivery[] | null {
  const out: PlannedDelivery[] = [];
  for (const endpoint of new Set(targets)) {
    const next = Math.max(highest.get(endpoint) ?? 0, 0) + 1;
    if (next > MAX_RESEND_NO) return null;
    out.push({ endpoint, resendNo: next });
  }
  return out;
}
