/** Rows → spec objects (`WebhookEndpoint`, `Event`). */
import { API_VERSION, type WebhookEndpoint as Endpoint, type Event } from "@nearpay/spec";
import { fromUuid } from "@nearpay-internal/ids";
import type { Selectable } from "kysely";
import type { z } from "zod";
import { renderFor } from "../domain/event/render.js";
import type { EventsTable, WebhookEndpointsTable } from "../infra/db/schema.js";

export type EndpointRow = Selectable<WebhookEndpointsTable>;
export type EventRow = Selectable<EventsTable>;
type WebhookEndpoint = z.infer<typeof Endpoint>;

const unix = (d: Date) => Math.floor(d.getTime() / 1000);

/** The endpoint object; `secret` only in the create response. */
export function endpointView(row: EndpointRow, secret?: string): WebhookEndpoint {
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
  };
}

/** The event as the events API serves it (latest API version). */
export function eventView(row: EventRow, version: string = API_VERSION): Event {
  return renderFor(row, version, API_VERSION);
}
