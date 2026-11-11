/** Rows → spec objects (`WebhookEndpoint`, `Event`, `WebhookDelivery`). */

import { fromUuid } from "@nearpay-internal/ids";
import {
  API_VERSION,
  type WebhookDelivery as Delivery,
  type WebhookEndpoint as Endpoint,
  type Event,
  type WebhookType,
} from "@nearpay-money/spec";
import type { Selectable } from "kysely";
import type { z } from "zod";
import { previousExpiry, type SecretState } from "../domain/endpoint/secrets.js";
import { renderFor } from "../domain/event/render.js";
import type { DeliveriesTable, EventsTable, WebhookEndpointsTable } from "../infra/db/schema.js";

export type EndpointRow = Selectable<WebhookEndpointsTable>;
export type EventRow = Selectable<EventsTable>;
type WebhookEndpoint = z.infer<typeof Endpoint>;
type WebhookDelivery = z.infer<typeof Delivery>;

/** A delivery row with what the view needs from its event. */
export type DeliveryRow = Omit<Selectable<DeliveriesTable>, "resend_no"> & { event_type: string; livemode: boolean };

const unix = (d: Date) => Math.floor(d.getTime() / 1000);

/** The stored (encrypted) secrets of an endpoint row as a rotation state. */
export function secretState(
  row: Pick<EndpointRow, "secret_enc" | "secondary_secret_enc" | "secondary_expires_at">,
): SecretState<Buffer> {
  return {
    current: row.secret_enc,
    previous: row.secondary_secret_enc,
    previousExpiresAt: row.secondary_expires_at?.getTime() ?? null,
  };
}

/**
 * The endpoint object at `now`; `secret` only in the create and rotate responses.
 * `previous_secret_expires_at` is set while a rotated-out secret still signs (Stage 2), null otherwise.
 */
export function endpointView(row: EndpointRow, now: number, secret?: string): WebhookEndpoint {
  const expiry = previousExpiry(secretState(row), now);
  return {
    id: fromUuid("we", row.id),
    object: "webhook_endpoint",
    created: unix(row.created_at),
    livemode: row.livemode,
    url: row.url,
    enabled_events: row.enabled_events,
    api_version: row.api_version as WebhookEndpoint["api_version"],
    description: row.description,
    status: row.status,
    disabled_reason: row.disabled_reason,
    ...(secret ? { secret } : {}),
    previous_secret_expires_at: expiry === null ? null : unix(new Date(expiry)),
  };
}

/** The event as the events API serves it (latest API version). */
export function eventView(row: EventRow, version: string = API_VERSION): Event {
  return renderFor(row, version, API_VERSION);
}

/**
 * The delivery summary (`listWebhookEndpointDeliveries`). Stored statuses are the spec's: `pending`
 * (no attempt yet), `failed` (last attempt failed, retry scheduled), `succeeded`, `abandoned` (72 h
 * passed or the endpoint was deleted). `next_attempt_at` is only shown while another attempt is due;
 * a status code outside 100–599 (never stored by the dispatcher) is shown as no response.
 */
export function deliveryView(row: DeliveryRow): WebhookDelivery {
  const due = row.status === "pending" || row.status === "failed";
  const code = row.last_status_code;
  return {
    id: fromUuid("whd", row.id),
    object: "webhook_delivery",
    created: unix(row.created_at),
    livemode: row.livemode,
    webhook_endpoint: fromUuid("we", row.endpoint_id),
    event: fromUuid("evt", row.event_id),
    event_type: row.event_type as WebhookType,
    status: row.status,
    attempts: row.attempts,
    last_status_code: code !== null && code >= 100 && code <= 599 ? code : null,
    last_error: row.last_error,
    next_attempt_at: due && row.next_attempt_at ? unix(row.next_attempt_at) : null,
    succeeded_at: row.succeeded_at ? unix(row.succeeded_at) : null,
  };
}
