/**
 * Jobs (lld/webhooks.md §3, §6), run by `webhooks-ingest` (leases, backoff, dead letters):
 *
 * | kind                | when           | what                                                          |
 * |---------------------|----------------|---------------------------------------------------------------|
 * | deliveries.abandon  | every 10 min   | undelivered deliveries older than 72 h → abandoned (covers disabled endpoints the dispatcher skips) |
 * | secrets.expire      | every 10 min   | rotated-out secrets past their overlap are erased (Stage 2)   |
 * | events.purge        | daily 03:00 UTC| events, deliveries and attempts older than 30 days            |
 * | kit.purge           | hourly         | published outbox, old inbox, expired idempotency keys         |
 */
import { type JobHandler, purgeKitTables, type RecurringJob, sql } from "@nearpay-internal/db";
import type { Webhooks } from "../app/context.js";
import { RETENTION_DAYS } from "../app/events.js";
import { GIVE_UP_AFTER_MS } from "../domain/delivery/schedule.js";

export const ABANDON_JOB = "deliveries.abandon";
export const PURGE_JOB = "events.purge";
export const SECRETS_JOB = "secrets.expire";

const HOUR = 3_600_000;
const BATCH = 5_000;

export const RECURRING: readonly RecurringJob[] = [
  { kind: ABANDON_JOB, everyMs: 10 * 60_000 },
  { kind: SECRETS_JOB, everyMs: 10 * 60_000 },
  { kind: PURGE_JOB, everyMs: 24 * HOUR, offsetMs: 3 * HOUR },
  { kind: "kit.purge", everyMs: HOUR },
];

/** Marks undelivered deliveries created more than 72 h ago as abandoned. Returns how many. */
export async function abandonExpired(w: Webhooks): Promise<number> {
  const r = await w.db
    .updateTable("deliveries")
    .set({
      status: "abandoned",
      next_attempt_at: null,
      last_error: sql`coalesce(last_error, 'not delivered within 72 h')`,
    })
    .where("status", "in", ["pending", "failed"])
    .where("created_at", "<", new Date(w.now() - GIVE_UP_AFTER_MS))
    .executeTakeFirst();
  return Number(r.numUpdatedRows);
}

/**
 * Erases previous secrets whose overlap has ended (they no longer sign: the dispatcher and the API
 * already ignore them; this only stops keeping them, encrypted, longer than needed). Returns how many.
 */
export async function expireSecrets(w: Webhooks): Promise<number> {
  const r = await w.db
    .updateTable("webhook_endpoints")
    .set({ secondary_secret_enc: null, secondary_expires_at: null })
    .where("secondary_expires_at", "<=", new Date(w.now()))
    .executeTakeFirst();
  return Number(r.numUpdatedRows);
}

/** Deletes events older than the retention window with their deliveries and attempts. */
export async function purgeEvents(w: Webhooks): Promise<{ events: number; deliveries: number; attempts: number }> {
  const cutoff = new Date(w.now() - RETENTION_DAYS * 86_400_000);
  const total = { events: 0, deliveries: 0, attempts: 0 };
  for (;;) {
    const r = await w.db.transaction().execute(async (tx) => {
      const ids = (
        await tx.selectFrom("events").select("id").where("created_at", "<", cutoff).limit(BATCH).execute()
      ).map((e) => e.id);
      if (ids.length === 0) return { events: 0, deliveries: 0, attempts: 0 };
      const a =
        await sql`delete from delivery_attempts where delivery_id in (select id from deliveries where event_id = any(${ids}::uuid[]))`.execute(
          tx,
        );
      const d = await tx.deleteFrom("deliveries").where("event_id", "in", ids).executeTakeFirst();
      const e = await tx.deleteFrom("events").where("id", "in", ids).executeTakeFirst();
      return {
        events: Number(e.numDeletedRows),
        deliveries: Number(d.numDeletedRows),
        attempts: Number(a.numAffectedRows ?? 0n),
      };
    });
    total.events += r.events;
    total.deliveries += r.deliveries;
    total.attempts += r.attempts;
    if (r.events < BATCH) return total;
  }
}

export function jobHandlers(w: Webhooks): Record<string, JobHandler> {
  return {
    [ABANDON_JOB]: async () => {
      const n = await abandonExpired(w);
      if (n) w.log.info({ abandoned: n }, "undelivered deliveries abandoned after 72 h");
    },
    [SECRETS_JOB]: async () => {
      const n = await expireSecrets(w);
      if (n) w.log.info({ erased: n }, "rotated-out endpoint secrets erased after their overlap");
    },
    [PURGE_JOB]: async () => {
      w.log.info(await purgeEvents(w), "events past retention purged");
    },
    "kit.purge": async () => {
      w.log.info(await purgeKitTables(w.db), "kit tables purged");
    },
  };
}
