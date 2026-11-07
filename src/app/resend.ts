/**
 * `POST /v1/events/{id}/resend` (lld/webhooks.md §5, spec 0.2.0 `resendEvent`): one new delivery
 * (UUIDv7 id, `pending`, fresh retry schedule and 72 h window) per target endpoint —
 *
 * - `endpoint` given: that endpoint, which must be the caller's in the event's mode (404, param
 *   `endpoint`) and enabled (`409 state_conflict`); subscriptions are ignored, like `…/test`;
 * - otherwise every enabled endpoint of the account and mode subscribed to the type (a `ping` goes to the
 *   endpoint it tested only).
 *
 * The event row is locked for the transaction, so concurrent resends of one event are serialised and
 * each `(event, endpoint, resend_no)` is allocated once (the unique constraint backs it up). Events older
 * than the 30-day window are 404, like `GET /v1/events/{id}`. The event keeps its id, so receivers dedupe
 * on `NearPay-Event-Id`.
 */
import type { EventResend as EventResendSchema } from "@nearpay/spec";
import { fromUuid, isId, toUuid, uuidv7 } from "@nearpay-internal/ids";
import { ApiError } from "@nearpay-internal/service";
import type { z } from "zod";
import { planResend, resendTargets } from "../domain/delivery/resend.js";
import type { Merchant, Webhooks } from "./context.js";
import { own } from "./endpoints.js";
import { RETENTION_DAYS } from "./events.js";
import { deliveryView } from "./views.js";

type EventResend = z.infer<typeof EventResendSchema>;

export async function resendEvent(
  w: Webhooks,
  m: Merchant,
  eventId: string,
  body: { endpoint?: string | undefined },
): Promise<EventResend> {
  if (!isId("evt", eventId)) throw ApiError.missing("event", eventId, "id");
  const evUuid = toUuid(eventId, "evt");
  return w.db.transaction().execute(async (tx) => {
    const ev = await tx
      .selectFrom("events")
      .select(["id", "type", "livemode", "data"])
      .where("id", "=", evUuid)
      .where("account_id", "=", m.account)
      .where("livemode", "=", m.livemode)
      .where("created_at", ">=", new Date(w.now() - RETENTION_DAYS * 86_400_000))
      .forUpdate()
      .executeTakeFirst();
    if (!ev) throw ApiError.missing("event", eventId, "id");

    let targets: string[];
    if (body.endpoint !== undefined) {
      const ep = await own(tx, m, body.endpoint, false, "endpoint");
      if (ep.status !== "enabled")
        throw new ApiError("state_conflict", { params: { object: "webhook_endpoint", state: ep.status } });
      targets = [ep.id];
    } else {
      const endpoints = await tx
        .selectFrom("webhook_endpoints")
        .select(["id", "status", "enabled_events"])
        .where("account_id", "=", m.account)
        .where("livemode", "=", m.livemode)
        .where("deleted_at", "is", null)
        .orderBy("id")
        .execute();
      const pinged = ev.type === "ping" ? (ev.data as { webhook_endpoint?: unknown }).webhook_endpoint : null;
      const pingEndpoint = typeof pinged === "string" && isId("we", pinged) ? toUuid(pinged, "we") : null;
      targets = resendTargets(ev.type, endpoints, pingEndpoint);
    }

    const highest = new Map<string, number>();
    if (targets.length) {
      const rows = await tx
        .selectFrom("deliveries")
        .select(["endpoint_id", (eb) => eb.fn.max("resend_no").as("n")])
        .where("event_id", "=", ev.id)
        .where("endpoint_id", "in", targets)
        .groupBy("endpoint_id")
        .execute();
      for (const r of rows) highest.set(r.endpoint_id, Number(r.n));
    }
    const plan = planResend(targets, highest);
    if (!plan)
      throw new ApiError("state_conflict", {
        params: { object: "event", state: "at its resend limit for this endpoint" },
      });

    const now = new Date(w.now());
    const inserted = plan.length
      ? await tx
          .insertInto("deliveries")
          .values(
            plan.map((p) => ({
              id: uuidv7(),
              event_id: ev.id,
              endpoint_id: p.endpoint,
              resend_no: p.resendNo,
              status: "pending" as const,
              next_attempt_at: now,
              created_at: now,
            })),
          )
          .returningAll()
          .execute()
      : [];
    return {
      object: "event_resend" as const,
      event: fromUuid("evt", ev.id),
      deliveries: inserted.map((d) => deliveryView({ ...d, event_type: ev.type, livemode: ev.livemode })),
    };
  });
}
