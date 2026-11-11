/**
 * Webhook endpoints (lld/webhooks.md §5): create (secret returned once, stored envelope-encrypted),
 * list, get, update (URL changes re-validated; merchant disable/re-enable), delete, `test` (a `ping`
 * event delivered to this endpoint only) and, from Stage 2, `rotate_secret` (overlap window during which
 * deliveries carry both `v1=` signatures). Every status change, and every rotation, writes a transition row.
 */

import { emit } from "@nearpay-internal/db";
import { fromUuid, isId, toUuid, uuidv7 } from "@nearpay-internal/ids";
import { ApiError } from "@nearpay-internal/service";
import { API_VERSION, type Event } from "@nearpay-money/spec";
import { normalizeEnabledEvents } from "../domain/endpoint/events.js";
import { DEFAULT_OVERLAP_SECONDS, previousExpiry, rotateSecret } from "../domain/endpoint/secrets.js";
import { endpointUrlProblem } from "../domain/endpoint/url.js";
import { pingObject } from "../domain/event/render.js";
import type { EndpointStatus } from "../infra/db/schema.js";
import { newEndpointSecret } from "../signing/signer.js";
import { type Merchant, need, secretAad, type Tx, type Webhooks } from "./context.js";
import { notifyEvents } from "./events.js";
import { type Page, type PageQuery, pageOf } from "./pages.js";
import { type EndpointRow, endpointView, eventView, secretState } from "./views.js";

export interface EndpointCreate {
  url: string;
  enabled_events: string[];
  api_version?: string | undefined;
  description?: string | undefined;
}

export interface EndpointUpdate {
  url?: string | undefined;
  enabled_events?: string[] | undefined;
  description?: string | null | undefined;
  disabled?: boolean | undefined;
}

function checkUrl(w: Webhooks, m: Merchant, url: string): void {
  const problem = endpointUrlProblem(url, { env: w.env, livemode: m.livemode });
  if (problem) throw new ApiError("url_invalid", { params: { reason: problem }, param: "url" });
}

function checkEvents(list: readonly string[]): string[] {
  const r = normalizeEnabledEvents(list);
  if ("unknown" in r)
    throw new ApiError("event_type_unknown", { params: { type: r.unknown }, param: `enabled_events[${r.index}]` });
  return r.ok;
}

export async function transition(
  tx: Tx,
  endpointId: string,
  from: EndpointStatus | null,
  to: EndpointStatus,
  cause: string,
  actor: string,
  evidence?: Record<string, unknown>,
): Promise<void> {
  await tx
    .insertInto("webhook_endpoint_transitions")
    .values({
      id: uuidv7(),
      webhook_endpoint_id: endpointId,
      from_state: from,
      to_state: to,
      cause,
      actor,
      evidence: evidence ? JSON.stringify(evidence) : null,
    })
    .execute();
}

/** `POST /v1/webhook_endpoints`. */
export async function createEndpoint(w: Webhooks, m: Merchant, body: EndpointCreate) {
  checkUrl(w, m, body.url);
  const events = checkEvents(body.enabled_events);
  const cipher = need(w.cipher, "the endpoint secret KEK");
  const id = uuidv7();
  const secret = newEndpointSecret();
  const row = await w.db.transaction().execute(async (tx) => {
    const r = await tx
      .insertInto("webhook_endpoints")
      .values({
        id,
        account_id: m.account,
        livemode: m.livemode,
        url: body.url,
        enabled_events: events,
        api_version: body.api_version ?? API_VERSION,
        description: body.description ?? null,
        secret_enc: cipher.encrypt(secret, secretAad(id)),
        status: "enabled",
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await transition(tx, id, null, "enabled", "created", m.actor);
    return r;
  });
  return endpointView(row, w.now(), secret);
}

function endpointUuid(id: string, param: string): string {
  if (!isId("we", id)) throw ApiError.missing("webhook_endpoint", id, param);
  return toUuid(id, "we");
}

/** An endpoint of this account and mode (deleted ones are gone); `lock` for updates. */
export async function own(
  db: Webhooks["db"] | Tx,
  m: Merchant,
  id: string,
  lock = false,
  param = "id",
): Promise<EndpointRow> {
  let q = db
    .selectFrom("webhook_endpoints")
    .selectAll()
    .where("id", "=", endpointUuid(id, param))
    .where("account_id", "=", m.account)
    .where("livemode", "=", m.livemode)
    .where("deleted_at", "is", null);
  if (lock) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  if (!row) throw ApiError.missing("webhook_endpoint", id, param);
  return row;
}

export async function getEndpoint(w: Webhooks, m: Merchant, id: string) {
  return endpointView(await own(w.db, m, id), w.now());
}

export async function listEndpoints(w: Webhooks, m: Merchant, q: PageQuery) {
  const base = w.db
    .selectFrom("webhook_endpoints")
    .selectAll()
    .where("account_id", "=", m.account)
    .where("livemode", "=", m.livemode)
    .where("deleted_at", "is", null);
  const page: Page<EndpointRow> = await pageOf(base, q, "we", "webhook_endpoints");
  return {
    object: "list" as const,
    data: page.rows.map((r) => endpointView(r, w.now())),
    has_more: page.hasMore,
    url: "/v1/webhook_endpoints",
  };
}

/** `PATCH /v1/webhook_endpoints/{id}`. */
export async function updateEndpoint(w: Webhooks, m: Merchant, id: string, body: EndpointUpdate) {
  if (body.url !== undefined) checkUrl(w, m, body.url);
  const events = body.enabled_events !== undefined ? checkEvents(body.enabled_events) : undefined;
  const row = await w.db.transaction().execute(async (tx) => {
    const cur = await own(tx, m, id, true);
    let status = cur.status;
    let reason = cur.disabled_reason;
    let failingSince = cur.failing_since;
    if (body.disabled === true && cur.status === "enabled") {
      status = "disabled";
      reason = "merchant";
    } else if (body.disabled === false && cur.status === "disabled") {
      status = "enabled";
      reason = null;
      failingSince = null; // a new failure streak starts after a re-enable
    }
    const updated = await tx
      .updateTable("webhook_endpoints")
      .set({
        ...(body.url !== undefined ? { url: body.url } : {}),
        ...(events ? { enabled_events: events } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        status,
        disabled_reason: reason,
        failing_since: failingSince,
        updated_at: new Date(w.now()),
        version: cur.version + 1,
      })
      .where("id", "=", cur.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    if (status !== cur.status)
      await transition(
        tx,
        cur.id,
        cur.status,
        status,
        status === "disabled" ? "merchant_disabled" : "merchant_enabled",
        m.actor,
      );
    return updated;
  });
  return endpointView(row, w.now());
}

/** `DELETE /v1/webhook_endpoints/{id}`: soft delete; undelivered events for it are abandoned. */
export async function deleteEndpoint(w: Webhooks, m: Merchant, id: string): Promise<void> {
  await w.db.transaction().execute(async (tx) => {
    const cur = await own(tx, m, id, true);
    await tx
      .updateTable("webhook_endpoints")
      .set({
        deleted_at: new Date(w.now()),
        status: "disabled",
        disabled_reason: cur.disabled_reason ?? "merchant",
        updated_at: new Date(w.now()),
        version: cur.version + 1,
      })
      .where("id", "=", cur.id)
      .execute();
    await tx
      .updateTable("deliveries")
      .set({ status: "abandoned", next_attempt_at: null, last_error: "endpoint deleted" })
      .where("endpoint_id", "=", cur.id)
      .where("status", "in", ["pending", "failed"])
      .execute();
    await transition(tx, cur.id, cur.status, "disabled", "deleted", m.actor);
  });
}

/** `POST /v1/webhook_endpoints/{id}/test`: a `ping` event, delivered to this endpoint only. */
export async function testEndpoint(
  w: Webhooks,
  m: Merchant,
  id: string,
  request: { id: string | null; idempotency_key: string | null },
): Promise<Event> {
  return w.db.transaction().execute(async (tx) => {
    const ep = await own(tx, m, id, true);
    if (ep.status !== "enabled")
      throw new ApiError("state_conflict", { params: { object: "webhook_endpoint", state: ep.status } });
    const now = new Date(w.now());
    const ev = await tx
      .insertInto("events")
      .values({
        id: uuidv7(),
        account_id: m.account,
        livemode: m.livemode,
        type: "ping",
        source_event_id: uuidv7(),
        object_type: "ping",
        object_id: id,
        object_sequence: 0,
        data: JSON.stringify(pingObject(ep.id)),
        previous: null,
        request: JSON.stringify(request),
        created_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await tx
      .insertInto("deliveries")
      .values({ id: uuidv7(), event_id: ev.id, endpoint_id: ep.id, status: "pending", next_attempt_at: now })
      .execute();
    await notifyEvents(tx, m.account, m.livemode); // `nearpay listen` shows pings (§5.1)
    return eventView(ev);
  });
}

/**
 * `POST /v1/webhook_endpoints/{id}/rotate_secret`: a new secret (returned once); the current one keeps
 * signing for `expire_previous_in_seconds` (0 drops it at once; a rotation during an overlap replaces
 * the previous secret). Allowed on a disabled endpoint (a leaked secret must be replaceable). The
 * idempotent response, which carries the secret, is stored encrypted by the service bootstrap.
 */
export async function rotateEndpointSecret(
  w: Webhooks,
  m: Merchant,
  id: string,
  body: { expire_previous_in_seconds?: number | undefined },
) {
  const cipher = need(w.cipher, "the endpoint secret KEK");
  const secret = newEndpointSecret();
  const { row, now } = await w.db.transaction().execute(async (tx) => {
    const cur = await own(tx, m, id, true);
    const now = w.now();
    const next = rotateSecret(
      secretState(cur),
      cipher.encrypt(secret, secretAad(cur.id)),
      body.expire_previous_in_seconds ?? DEFAULT_OVERLAP_SECONDS,
      now,
    );
    const updated = await tx
      .updateTable("webhook_endpoints")
      .set({
        secret_enc: next.current,
        secondary_secret_enc: next.previous,
        secondary_expires_at: next.previousExpiresAt === null ? null : new Date(next.previousExpiresAt),
        updated_at: new Date(now),
        version: cur.version + 1,
      })
      .where("id", "=", cur.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    const expiry = previousExpiry(next, now);
    const expiresAt = expiry === null ? null : new Date(expiry).toISOString();
    await transition(tx, cur.id, cur.status, cur.status, "secret_rotated", m.actor, {
      previous_secret_expires_at: expiresAt,
    });
    // spec 0.2.1: notify tells developers/owners; same transaction as the rotation, never the secret
    await emit(tx, {
      subject: "evt.webhooks.endpoint.secret_rotated",
      aggregate: { type: "webhook_endpoint", id: fromUuid("we", cur.id), version: updated.version },
      accountId: cur.account_id,
      livemode: cur.livemode,
      data: {
        object: {
          endpoint_id: fromUuid("we", cur.id),
          account_id: fromUuid("acct", cur.account_id),
          url: cur.url,
          previous_secret_expires_at: expiresAt,
          actor_user_id: m.userId,
        },
      },
    });
    return { row: updated, now };
  });
  return endpointView(row, now, secret);
}
