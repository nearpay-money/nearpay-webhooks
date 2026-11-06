/** The delivery summary served by `GET /v1/webhook_endpoints/{id}/deliveries` (spec 0.1.5). */
import { WebhookDelivery } from "@nearpay/spec";
import { fromUuid, uuidv7 } from "@nearpay-internal/ids";
import { describe, expect, it } from "vitest";
import { type DeliveryRow, deliveryView } from "../../src/app/views.js";

const created = new Date("2026-11-07T10:00:00.400Z");
const later = new Date("2026-11-07T10:01:00.900Z");

const row = (o: Partial<DeliveryRow> = {}): DeliveryRow => ({
  id: uuidv7(),
  event_id: uuidv7(),
  endpoint_id: uuidv7(),
  status: "pending",
  attempts: 0,
  next_attempt_at: created,
  last_status_code: null,
  last_error: null,
  created_at: created,
  succeeded_at: null,
  event_type: "payment_intent.succeeded",
  livemode: false,
  ...o,
});

describe("delivery view", () => {
  it("maps a pending delivery to the spec shape (whd_/we_/evt_ ids, unix seconds)", () => {
    const r = row();
    const v = deliveryView(r);
    expect(v).toEqual({
      id: fromUuid("whd", r.id),
      object: "webhook_delivery",
      created: Math.floor(created.getTime() / 1000),
      livemode: false,
      webhook_endpoint: fromUuid("we", r.endpoint_id),
      event: fromUuid("evt", r.event_id),
      event_type: "payment_intent.succeeded",
      status: "pending",
      attempts: 0,
      last_status_code: null,
      last_error: null,
      next_attempt_at: Math.floor(created.getTime() / 1000),
      succeeded_at: null,
    });
    expect(v.id).toMatch(/^whd_[0-7][0-9a-hjkmnp-tv-z]{25}$/);
    expect(WebhookDelivery.safeParse(v).success).toBe(true);
  });

  it("shows a failed delivery with its scheduled retry", () => {
    const v = deliveryView(
      row({ status: "failed", attempts: 2, last_status_code: 503, last_error: "HTTP 503", next_attempt_at: later }),
    );
    expect(v).toMatchObject({
      status: "failed",
      attempts: 2,
      last_status_code: 503,
      last_error: "HTTP 503",
      next_attempt_at: Math.floor(later.getTime() / 1000),
      succeeded_at: null,
    });
    expect(WebhookDelivery.safeParse(v).success).toBe(true);
    // a timeout or proxy refusal has no status code
    const t = deliveryView(row({ status: "failed", attempts: 1, last_error: "timeout after 10000 ms" }));
    expect(t.last_status_code).toBeNull();
    expect(WebhookDelivery.safeParse(t).success).toBe(true);
  });

  it("succeeded and abandoned deliveries have no next attempt", () => {
    const ok = deliveryView(
      row({ status: "succeeded", attempts: 3, last_status_code: 204, succeeded_at: later, next_attempt_at: later }),
    );
    expect(ok).toMatchObject({
      status: "succeeded",
      next_attempt_at: null,
      succeeded_at: Math.floor(later.getTime() / 1000),
    });
    const gone = deliveryView(
      row({ status: "abandoned", attempts: 0, last_error: "endpoint deleted", next_attempt_at: later }),
    );
    expect(gone).toMatchObject({ status: "abandoned", next_attempt_at: null, last_error: "endpoint deleted" });
    for (const v of [ok, gone]) expect(WebhookDelivery.safeParse(v).success).toBe(true);
  });

  it("hides status codes the spec cannot carry and serves ping deliveries", () => {
    expect(deliveryView(row({ status: "failed", last_status_code: 0 })).last_status_code).toBeNull();
    expect(deliveryView(row({ status: "failed", last_status_code: 600 })).last_status_code).toBeNull();
    expect(deliveryView(row({ status: "failed", last_status_code: 100 })).last_status_code).toBe(100);
    const ping = deliveryView(row({ event_type: "ping", livemode: true }));
    expect(ping).toMatchObject({ event_type: "ping", livemode: true });
    expect(WebhookDelivery.safeParse(ping).success).toBe(true);
  });
});
