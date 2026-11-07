/**
 * The public event log (lld/webhooks.md §4–§6): ingest of domain events (one `events` row per domain
 * event and mode, deduplicated by `(source_event_id, livemode)`, fanned out to every enabled endpoint of
 * that mode subscribed to its type; reviews rendered as `PublicReview`; `account.updated` in both modes),
 * the events API (last 30 days, filters `type` and `created[gte/lte]`) and resend (Stage 2).
 */
import type { Envelope } from "@nearpay-internal/bus";
import { recordDeadLetter, sql } from "@nearpay-internal/db";
import { isId, toUuid, uuidv7 } from "@nearpay-internal/ids";
import { ApiError } from "@nearpay-internal/service";
import { ingestModes, publicObjectOf } from "../domain/event/public.js";
import { publicType } from "../domain/event/render.js";
import type { Merchant, Tx, Webhooks } from "./context.js";
import { type Page, type PageQuery, pageOf } from "./pages.js";
import { type EventRow, eventView } from "./views.js";

/** Events (and their deliveries) are kept this long (§3). */
export const RETENTION_DAYS = 30;

export interface IngestResult {
  /** Public event created (false: duplicate domain event, a subject or review that is never exposed, or a dead letter). */
  readonly created: boolean;
  /** Public events created (2 for a mode-less object such as `account.updated`). */
  readonly events: number;
  readonly deliveries: number;
}

/**
 * The object's own `sequence` when the producer sends it (spec 0.1.5: CheckoutSession and AgentPayment
 * carry it too), otherwise the aggregate version of the domain event (producers older than 0.1.5).
 */
export function objectSequence(object: unknown, aggregateVersion: number): number {
  const s = (object as { sequence?: unknown } | null)?.sequence;
  return typeof s === "number" && Number.isInteger(s) && s >= 0 ? s : aggregateVersion;
}

/**
 * Turns one domain event into public events (one, or one per mode for mode-less objects) and their
 * deliveries, inside the consumer's transaction. Every mode is rendered and validated before anything
 * is written, so a domain event is either fully ingested, skipped or dead-lettered.
 */
export async function ingest(w: Webhooks, tx: Tx, e: Envelope): Promise<IngestResult> {
  const none = { created: false, events: 0, deliveries: 0 };
  const type = publicType(e.subject);
  if (!type) return none;
  const reject = async (error: string) => {
    w.log.error({ subject: e.subject, event: e.id, error }, "domain event cannot become a public event");
    await recordDeadLetter(tx, { source: "consumer:webhooks", subject: e.subject, payload: e, error });
    return none;
  };
  if (!e.account_id) return reject("merchant event without account_id");
  const modes = ingestModes(type, e.livemode);
  if (!modes) return reject("merchant event without livemode");
  const plans: { livemode: boolean; object: Record<string, unknown> }[] = [];
  for (const livemode of modes) {
    const p = publicObjectOf(type, e.data.object, livemode);
    if ("invalid" in p) return reject(p.invalid);
    if ("skip" in p) {
      w.log.info({ subject: e.subject, event: e.id, reason: p.skip }, "domain event is not public");
      return none;
    }
    plans.push({ livemode, object: p.ok });
  }

  let events = 0;
  let deliveries = 0;
  for (const { livemode, object } of plans) {
    const inserted = await tx
      .insertInto("events")
      .values({
        id: uuidv7(),
        account_id: e.account_id,
        livemode,
        type,
        source_event_id: e.id,
        object_type: e.aggregate.type,
        object_id: e.aggregate.id,
        object_sequence: objectSequence(object, e.aggregate.version),
        data: JSON.stringify(object),
        previous: e.data.previous ? JSON.stringify(e.data.previous) : null,
        request: e.request ? JSON.stringify(e.request) : null,
        created_at: e.occurred_at,
      })
      .onConflict((oc) => oc.columns(["source_event_id", "livemode"]).doNothing())
      .returning(["id"])
      .executeTakeFirst();
    if (!inserted) continue;
    events++;

    // Delivery ids are UUIDv7 generated here (prefixed `whd_` in the API), one per subscribed endpoint.
    const targets = await tx
      .selectFrom("webhook_endpoints")
      .select("id")
      .where("account_id", "=", e.account_id)
      .where("livemode", "=", livemode)
      .where("status", "=", "enabled")
      .where("deleted_at", "is", null)
      .where(sql<boolean>`('*' = any(enabled_events) or ${type} = any(enabled_events))`)
      .orderBy("id")
      .execute();
    const created = targets.length
      ? await tx
          .insertInto("deliveries")
          .values(
            targets.map((ep) => ({
              id: uuidv7(),
              event_id: inserted.id,
              endpoint_id: ep.id,
              resend_no: 0,
              status: "pending" as const,
              next_attempt_at: sql<Date>`now()`,
            })),
          )
          .onConflict((oc) => oc.columns(["event_id", "endpoint_id", "resend_no"]).doNothing())
          .returning("id")
          .execute()
      : [];
    deliveries += created.length;
    w.metrics.ingested(type);
  }
  return { created: events > 0, events, deliveries };
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
