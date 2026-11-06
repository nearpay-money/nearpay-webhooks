/**
 * The public event log (lld/webhooks.md §5–§6): ingest of domain events (one `events` row per domain
 * event, deduplicated by `source_event_id`, fanned out to every enabled endpoint subscribed to its
 * type) and the events API (last 30 days, filters `type` and `created[gte/lte]`).
 */
import { WEBHOOK_TYPES } from "@nearpay/spec";
import type { Envelope } from "@nearpay-internal/bus";
import { recordDeadLetter, sql } from "@nearpay-internal/db";
import { isId, toUuid, uuidv7 } from "@nearpay-internal/ids";
import { ApiError } from "@nearpay-internal/service";
import { publicType } from "../domain/event/render.js";
import type { Merchant, Tx, Webhooks } from "./context.js";
import { type Page, type PageQuery, pageOf } from "./pages.js";
import { type EventRow, eventView } from "./views.js";

/** Events (and their deliveries) are kept this long (§3). */
export const RETENTION_DAYS = 30;

export interface IngestResult {
  /** Public event created (false: duplicate domain event, or a subject that is never exposed). */
  readonly created: boolean;
  readonly deliveries: number;
}

/** Turns one domain event into a public event and its deliveries, inside the consumer's transaction. */
export async function ingest(w: Webhooks, tx: Tx, e: Envelope): Promise<IngestResult> {
  const type = publicType(e.subject);
  if (!type) return { created: false, deliveries: 0 };
  const reject = async (error: string) => {
    w.log.error({ subject: e.subject, event: e.id, error }, "domain event cannot become a public event");
    await recordDeadLetter(tx, { source: "consumer:webhooks", subject: e.subject, payload: e, error });
    return { created: false, deliveries: 0 };
  };
  if (!e.account_id || e.livemode === null) return reject("merchant event without account_id/livemode");
  const parsed = WEBHOOK_TYPES[type].object.safeParse(e.data.object);
  if (!parsed.success) return reject(`data.object is not a valid ${type} object: ${parsed.error.issues[0]?.message}`);

  const inserted = await tx
    .insertInto("events")
    .values({
      id: uuidv7(),
      account_id: e.account_id,
      livemode: e.livemode,
      type,
      source_event_id: e.id,
      object_type: e.aggregate.type,
      object_id: e.aggregate.id,
      object_sequence: e.aggregate.version,
      data: JSON.stringify(e.data.object),
      previous: e.data.previous ? JSON.stringify(e.data.previous) : null,
      request: e.request ? JSON.stringify(e.request) : null,
      created_at: e.occurred_at,
    })
    .onConflict((oc) => oc.column("source_event_id").doNothing())
    .returning(["id"])
    .executeTakeFirst();
  if (!inserted) return { created: false, deliveries: 0 };

  const r = await sql<{ n: string }>`
    with ins as (
      insert into deliveries (id, event_id, endpoint_id, status, next_attempt_at)
      select gen_random_uuid(), ${inserted.id}::uuid, ep.id, 'pending', now()
      from webhook_endpoints ep
      where ep.account_id = ${e.account_id}::uuid and ep.livemode = ${e.livemode}
        and ep.status = 'enabled' and ep.deleted_at is null
        and ('*' = any(ep.enabled_events) or ${type} = any(ep.enabled_events))
      on conflict (event_id, endpoint_id) do nothing
      returning 1)
    select count(*)::text as n from ins`.execute(tx);
  w.metrics.ingested(type);
  return { created: true, deliveries: Number(r.rows[0]?.n ?? 0) };
}

function eventUuid(id: string): string {
  if (!isId("evt", id)) throw ApiError.missing("event", id, "id");
  return toUuid(id, "evt");
}

const since = (w: Webhooks) => new Date(w.now() - RETENTION_DAYS * 86_400_000);

export async function getEvent(w: Webhooks, m: Merchant, id: string) {
  const row = await w.db
    .selectFrom("events")
    .selectAll()
    .where("id", "=", eventUuid(id))
    .where("account_id", "=", m.account)
    .where("livemode", "=", m.livemode)
    .where("created_at", ">=", since(w))
    .executeTakeFirst();
  if (!row) throw ApiError.missing("event", id, "id");
  return eventView(row);
}

export async function listEvents(w: Webhooks, m: Merchant, q: PageQuery & { type?: string | undefined }) {
  let base = w.db
    .selectFrom("events")
    .selectAll()
    .where("account_id", "=", m.account)
    .where("livemode", "=", m.livemode)
    .where("created_at", ">=", since(w));
  if (q.type) base = base.where("type", "=", q.type);
  const page: Page<EventRow> = await pageOf(base, q, "evt", "events");
  return {
    object: "list" as const,
    data: page.rows.map((r) => eventView(r)),
    has_more: page.hasMore,
    url: "/v1/events",
  };
}
