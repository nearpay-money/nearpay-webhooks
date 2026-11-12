/**
 * Dispatch (lld/webhooks.md §6), run by `webhooks-dispatcher` (2 replicas):
 *
 * 1. claim due deliveries (`pending`/`failed`, `next_attempt_at <= now`, endpoint enabled) with
 *    `FOR UPDATE SKIP LOCKED`, pushing `next_attempt_at` out by a lease so a crashed dispatcher's
 *    claims come back on their own and replicas never send the same attempt twice;
 * 2. per endpoint at most N in flight (Valkey semaphore; else 1 per replica);
 * 3. render the event in the endpoint's API version, sign it (HMAC per active secret + Ed25519) and
 *    POST it through the egress proxy (timeout 10 s, no redirects);
 * 4. in one transaction: the attempt row, the delivery's new state (2xx → succeeded; else retry per
 *    schedule or abandon after 72 h) and the endpoint's streak (success clears it; > 72 h of failures
 *    → disabled + `evt.webhooks.endpoint.disabled` in the outbox, which notify turns into an email).
 */

import { emit, sql } from "@nearpay-internal/db";
import { fromUuid, uuidv7 } from "@nearpay-internal/ids";
import type { BackgroundTask, Heartbeat } from "@nearpay-internal/service";
import { API_VERSION, HEADERS } from "@nearpay-money/spec";
import { need, secretAad, type Webhooks } from "../app/context.js";
import { transition } from "../app/endpoints.js";
import { secretState } from "../app/views.js";
import { afterAttempt, codeClass, isTerminal } from "../domain/delivery/schedule.js";
import { activeSecrets } from "../domain/endpoint/secrets.js";
import { renderFor } from "../domain/event/render.js";
import type { Egress } from "../infra/egress.js";
import type { Semaphore } from "../infra/semaphore.js";
import { signatureHeader } from "../signing/signer.js";

export const USER_AGENT = "NearPay-Webhooks/1.0";

export interface DispatchSettings {
  readonly timeoutMs: number;
  /** Deliveries in flight in this replica. */
  readonly concurrency: number;
  /** How long a claim keeps other dispatchers away (must exceed the timeout). */
  readonly leaseMs: number;
  readonly pollMs: number;
}

export interface Dispatcher {
  readonly w: Webhooks;
  readonly egress: Egress;
  readonly semaphore: Semaphore;
  readonly settings: DispatchSettings;
}

export interface Claimed {
  readonly id: string;
  readonly endpoint_id: string;
}

/** Claims up to `limit` due deliveries (lease = settings.leaseMs). */
export async function claimDue(d: Dispatcher, limit: number): Promise<Claimed[]> {
  if (limit <= 0) return [];
  const now = new Date(d.w.now());
  const lease = new Date(d.w.now() + d.settings.leaseMs);
  const r = await sql<Claimed>`
    with due as (
      select dl.id from deliveries dl
      join webhook_endpoints ep on ep.id = dl.endpoint_id
      where dl.status in ('pending', 'failed') and dl.next_attempt_at <= ${now}
        and ep.status = 'enabled' and ep.deleted_at is null
      order by dl.next_attempt_at
      limit ${limit}
      for update of dl skip locked)
    update deliveries set next_attempt_at = ${lease}
    from due where deliveries.id = due.id
    returning deliveries.id, deliveries.endpoint_id`.execute(d.w.db);
  return r.rows;
}

/** Number of deliveries waiting to be sent (`due_backlog`). */
export async function dueBacklog(w: Webhooks): Promise<number> {
  const r = await sql<{ n: string }>`
    select count(*)::text as n from deliveries
    where status in ('pending', 'failed') and next_attempt_at <= ${new Date(w.now())}`.execute(w.db);
  return Number(r.rows[0]?.n ?? 0);
}

/** Puts a claimed delivery back (endpoint at its concurrency limit) without counting an attempt. */
async function postpone(d: Dispatcher, id: string): Promise<void> {
  const at = new Date(d.w.now() + 500 + Math.floor(d.w.random() * 1_500));
  await d.w.db
    .updateTable("deliveries")
    .set({ next_attempt_at: at })
    .where("id", "=", id)
    .where("status", "in", ["pending", "failed"])
    .execute();
}

/** Sends one claimed delivery and records the outcome. */
export async function deliverOne(d: Dispatcher, c: Claimed): Promise<void> {
  const release = await d.semaphore.acquire(c.endpoint_id);
  if (!release) return postpone(d, c.id);
  try {
    await attempt(d, c.id);
  } finally {
    await release();
  }
}

async function attempt(d: Dispatcher, deliveryId: string): Promise<void> {
  const { w } = d;
  const row = await w.db
    .selectFrom("deliveries as dl")
    .innerJoin("events as ev", "ev.id", "dl.event_id")
    .innerJoin("webhook_endpoints as ep", "ep.id", "dl.endpoint_id")
    .select([
      "dl.id",
      "dl.status",
      "dl.attempts",
      "ev.id as event_id",
      "ev.type",
      "ev.livemode",
      "ev.object_sequence",
      "ev.data",
      "ev.previous",
      "ev.request",
      "ev.created_at as event_created_at",
      "ep.id as endpoint_id",
      "ep.url",
      "ep.api_version",
      "ep.status as endpoint_status",
      "ep.deleted_at",
      "ep.secret_enc",
      "ep.secondary_secret_enc",
      "ep.secondary_expires_at",
    ])
    .where("dl.id", "=", deliveryId)
    .executeTakeFirst();
  if (!row || isTerminal(row.status) || row.endpoint_status !== "enabled" || row.deleted_at) return;

  const cipher = need(w.cipher, "the endpoint secret KEK");
  const key = need(w.signingKey, "the webhook signing key");
  // One instant for the timestamp `t=` and the choice of secrets: during a rotation overlap the
  // delivery carries a `v1=` for the current and the previous secret, current first (§5, §6).
  const startedAt = new Date(w.now());
  const secrets = activeSecrets(secretState(row), startedAt.getTime()).map((enc) =>
    cipher.decrypt(enc, secretAad(row.endpoint_id)).toString("utf8"),
  );

  const event = renderFor(
    {
      id: row.event_id,
      type: row.type,
      livemode: row.livemode,
      object_sequence: row.object_sequence,
      data: row.data,
      previous: row.previous,
      request: row.request,
      created_at: row.event_created_at,
    },
    row.api_version,
    API_VERSION,
  );
  const body = JSON.stringify(event);
  const timestamp = Math.floor(startedAt.getTime() / 1000);
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "user-agent": USER_AGENT,
    [HEADERS.webhookSignature]: signatureHeader({ timestamp, body, secrets, key }),
    [HEADERS.webhookEventId]: fromUuid("evt", row.event_id),
    [HEADERS.webhookEventType]: row.type,
  };
  if (row.attempts === 0)
    w.metrics.firstAttemptLatency(Math.max(0, (startedAt.getTime() - row.event_created_at.getTime()) / 1000));
  const res = await d.egress.post(row.url, body, headers, d.settings.timeoutMs);

  await w.db.transaction().execute(async (tx) => {
    const dl = await tx
      .selectFrom("deliveries")
      .selectAll()
      .where("id", "=", deliveryId)
      .forUpdate()
      .executeTakeFirst();
    if (!dl || isTerminal(dl.status)) return;
    const ep = await tx
      .selectFrom("webhook_endpoints")
      .selectAll()
      .where("id", "=", row.endpoint_id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const now = w.now();
    const out = afterAttempt(
      { status: dl.status, attempts: dl.attempts, createdAt: dl.created_at.getTime() },
      {
        status: ep.status,
        failingSince: ep.failing_since?.getTime() ?? null,
        lastSuccessAt: ep.last_success_at?.getTime() ?? null,
      },
      res.status,
      now,
      w.random(),
    );
    const error = res.error ?? (out.delivery.status === "succeeded" ? null : `HTTP ${res.status}`);
    await tx
      .insertInto("delivery_attempts")
      .values({
        id: uuidv7(),
        delivery_id: dl.id,
        attempt_no: out.delivery.attempts,
        started_at: startedAt,
        duration_ms: res.durationMs,
        status_code: res.status,
        error,
        response_excerpt: res.excerpt,
      })
      .execute();
    await tx
      .updateTable("deliveries")
      .set({
        status: out.delivery.status,
        attempts: out.delivery.attempts,
        next_attempt_at: out.delivery.nextAttemptAt === null ? null : new Date(out.delivery.nextAttemptAt),
        last_status_code: res.status,
        last_error: error,
        succeeded_at: out.delivery.succeededAt === null ? null : new Date(out.delivery.succeededAt),
      })
      .where("id", "=", dl.id)
      .execute();

    const failingSince = out.endpoint.failingSince === null ? null : new Date(out.endpoint.failingSince);
    const lastSuccess = out.endpoint.lastSuccessAt === null ? null : new Date(out.endpoint.lastSuccessAt);
    if (out.endpoint.disable) {
      const version = ep.version + 1;
      await tx
        .updateTable("webhook_endpoints")
        .set({
          status: "disabled",
          disabled_reason: "failing",
          failing_since: failingSince,
          updated_at: new Date(now),
          version,
        })
        .where("id", "=", ep.id)
        .execute();
      await transition(tx, ep.id, "enabled", "disabled", "failing_72h", "webhooks-dispatcher", {
        failing_since: failingSince?.toISOString(),
        last_error: error,
      });
      await emit(tx, {
        subject: "evt.webhooks.endpoint.disabled",
        aggregate: { type: "webhook_endpoint", id: fromUuid("we", ep.id), version },
        accountId: ep.account_id,
        livemode: ep.livemode,
        data: {
          object: {
            endpoint_id: fromUuid("we", ep.id),
            account_id: fromUuid("acct", ep.account_id),
            url: ep.url,
            reason: "failing",
            failing_since: (failingSince as Date).toISOString(),
          },
          previous: { status: "enabled" },
        },
      });
      w.metrics.endpointDisabled();
      w.log.warn({ endpoint: fromUuid("we", ep.id) }, "endpoint disabled after 72 h of failed deliveries");
    } else if (
      (ep.failing_since?.getTime() ?? null) !== out.endpoint.failingSince ||
      (ep.last_success_at?.getTime() ?? null) !== out.endpoint.lastSuccessAt
    ) {
      await tx
        .updateTable("webhook_endpoints")
        .set({ failing_since: failingSince, last_success_at: lastSuccess })
        .where("id", "=", ep.id)
        .execute();
    }
    w.metrics.delivery(out.delivery.status, codeClass(res.status));
  });
}

/** Liveness budget of the dispatch loop (kit 0.6.0, KIT-4): it beats on every iteration, failed claims included. */
export const DISPATCHER_MAX_SILENCE_MS = 120_000;

/** The dispatch loop as a background task: keeps up to `concurrency` deliveries in flight. */
export function dispatcherTask(d: Dispatcher, o: { maxSilenceMs?: number } = {}): BackgroundTask {
  return {
    name: "dispatcher",
    maxSilenceMs: o.maxSilenceMs ?? DISPATCHER_MAX_SILENCE_MS,
    start(heartbeat?: Heartbeat) {
      let stopped = false;
      let wake: (() => void) | null = null;
      const inFlight = new Set<Promise<void>>();
      const sleep = (ms: number) =>
        new Promise<void>((r) => {
          const t = setTimeout(r, ms);
          wake = () => {
            clearTimeout(t);
            r();
          };
        });
      const loop = (async () => {
        while (!stopped) {
          const free = d.settings.concurrency - inFlight.size;
          let claimed: Claimed[] = [];
          if (free > 0) {
            try {
              claimed = await claimDue(d, free);
            } catch (e) {
              d.w.log.error({ err: e }, "claiming deliveries failed");
            }
            for (const c of claimed) {
              const p: Promise<void> = deliverOne(d, c)
                .catch((e) => d.w.log.error({ err: e, delivery: c.id }, "delivery failed unexpectedly"))
                .finally(() => {
                  inFlight.delete(p);
                  if (inFlight.size === d.settings.concurrency - 1) wake?.();
                });
              inFlight.add(p);
            }
          }
          // a hung claim stops the beats; slow deliveries do not (each has its own timeout and runs beside the loop)
          heartbeat?.beat();
          if (stopped) break;
          if (free > 0 && claimed.length === free) continue;
          await sleep(d.settings.pollMs);
        }
      })();
      return {
        async stop() {
          stopped = true;
          (wake as (() => void) | null)?.();
          await loop;
          await Promise.allSettled([...inFlight]);
        },
      };
    },
  };
}
