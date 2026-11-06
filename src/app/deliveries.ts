/**
 * The delivery log of an endpoint (`GET /v1/webhook_endpoints/{id}/deliveries`, spec 0.1.5): one
 * summary per event delivered (or to be delivered) to the endpoint, newest first, last 30 days only
 * (like the events API, hidden even before the daily purge). The endpoint must belong to the caller's
 * account and mode and not be deleted (404 otherwise), exactly as for reading the endpoint.
 */

import type { Merchant, Webhooks } from "./context.js";
import { own } from "./endpoints.js";
import { RETENTION_DAYS } from "./events.js";
import { type Page, type PageQuery, pageByCreated } from "./pages.js";
import { type DeliveryRow, deliveryView } from "./views.js";

export async function listDeliveries(
  w: Webhooks,
  m: Merchant,
  endpointId: string,
  q: Pick<PageQuery, "limit" | "starting_after" | "ending_before">,
) {
  const ep = await own(w.db, m, endpointId);
  const since = new Date(w.now() - RETENTION_DAYS * 86_400_000);
  const base = w.db
    .selectFrom("deliveries")
    .innerJoin("events", "events.id", "deliveries.event_id")
    .select([
      "deliveries.id",
      "deliveries.event_id",
      "deliveries.endpoint_id",
      "deliveries.status",
      "deliveries.attempts",
      "deliveries.next_attempt_at",
      "deliveries.last_status_code",
      "deliveries.last_error",
      "deliveries.created_at",
      "deliveries.succeeded_at",
      "events.type as event_type",
      "events.livemode",
    ])
    .where("deliveries.endpoint_id", "=", ep.id)
    .where("deliveries.created_at", ">=", since);
  const exists = async (uuid: string) =>
    (await w.db
      .selectFrom("deliveries")
      .select("id")
      .where("id", "=", uuid)
      .where("endpoint_id", "=", ep.id)
      .executeTakeFirst()) !== undefined;
  const page: Page<DeliveryRow> = await pageByCreated(base, q, "whd", "deliveries", exists);
  return {
    object: "list" as const,
    data: page.rows.map(deliveryView),
    has_more: page.hasMore,
    url: `/v1/webhook_endpoints/${endpointId}/deliveries`,
  };
}
