/**
 * Public events (api-conventions §9, lld/webhooks.md §4): the stored canonical snapshot becomes the
 * `Event` object served by `GET /v1/events` and delivered to endpoints, rendered per API version by the
 * spec's version transformers. `data.object.sequence` is always present: objects that do not carry
 * their own sequence get the aggregate version of the domain event (`object_sequence`).
 */
import { type Event, renderEvent, SUBJECT_TO_WEBHOOK_TYPE, type WebhookType } from "@nearpay/spec";
import { fromUuid } from "@nearpay-internal/ids";

export interface StoredEvent {
  readonly id: string;
  readonly type: string;
  readonly livemode: boolean;
  readonly object_sequence: number;
  readonly data: Record<string, unknown>;
  readonly previous: Record<string, unknown> | null;
  readonly request: { id: string | null; idempotency_key: string | null } | null;
  readonly created_at: Date;
}

/** Public type of a domain subject, or null when the subject is never exposed. */
export function publicType(subject: string): WebhookType | null {
  return Object.hasOwn(SUBJECT_TO_WEBHOOK_TYPE, subject) ? (SUBJECT_TO_WEBHOOK_TYPE[subject] as WebhookType) : null;
}

/** The canonical (latest API version) event. */
export function canonicalEvent(row: StoredEvent, apiVersion: string): Event {
  const object =
    row.type === "ping" || typeof row.data.sequence === "number"
      ? row.data
      : { ...row.data, sequence: row.object_sequence };
  return {
    id: fromUuid("evt", row.id),
    object: "event",
    type: row.type,
    api_version: apiVersion,
    created: Math.floor(row.created_at.getTime() / 1000),
    livemode: row.livemode,
    data: { object, ...(row.previous ? { previous_attributes: row.previous } : {}) },
    request: { id: row.request?.id ?? null, idempotency_key: row.request?.idempotency_key ?? null },
  } as unknown as Event;
}

/** The event as an endpoint pinned to `version` receives it. */
export function renderFor(row: StoredEvent, version: string, latest: string): Event {
  return renderEvent(canonicalEvent(row, latest), version as Parameters<typeof renderEvent>[1]);
}

/** The `ping` object of `POST /v1/webhook_endpoints/{id}/test`. */
export function pingObject(endpointUuid: string): Record<string, unknown> {
  return { object: "ping", webhook_endpoint: fromUuid("we", endpointUuid) };
}
