/**
 * End to end through the real api, ingest and dispatcher (lld/webhooks.md §11 integration): endpoint
 * CRUD with SSRF validation and idempotency; ping; domain events over NATS → public events → signed
 * deliveries through the proxy; retries, abandonment, endpoint disable (+ outbox event); the events
 * API; ingest idempotency; jobs; the Valkey semaphore; the ops CLI.
 */
import { createPublicKey, randomUUID, timingSafeEqual, verify } from "node:crypto";
import { fromUuid, toUuid, uuidv7 } from "@nearpay-internal/ids";
import { agentPayment, checkoutSession, domainEvent, expectEvent, paymentIntent } from "@nearpay-internal/testing";
import { parseSignatureHeader, signedPayload, WebhookDelivery } from "@nearpay-money/spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { webhooksHandlers } from "../../src/consumers/handlers.js";
import { claimDue, deliverOne } from "../../src/dispatcher/dispatcher.js";
import { localSemaphore, valkeySemaphore } from "../../src/infra/semaphore.js";
import { runOps } from "../../src/ops/cli.js";
import { hmacV1 } from "../../src/signing/signer.js";
import { abandonExpired, purgeEvents } from "../../src/workers/jobs.js";
import type { Received } from "../support/net.js";
import { type Merchant, type Stack, startStack, waitFor } from "../support/stack.js";

let st: Stack;

beforeAll(async () => {
  st = await startStack({ valkey: true });
});
afterAll(async () => {
  await st?.stop();
});

async function endpoint(m: Merchant, body: Record<string, unknown> = {}, o: { livemode?: boolean; key?: string } = {}) {
  const token = await st.token(m, { livemode: o.livemode ?? false });
  const r = await st.call("POST", "/v1/webhook_endpoints", {
    token,
    body: { url: `${st.receiver.url}/hooks/${m.account}`, enabled_events: ["*"], ...body },
    ...(o.key ? { headers: { "idempotency-key": o.key } } : {}),
  });
  return { token, r };
}

/** Verifies a delivery as a merchant would (HMAC with the secret + Ed25519 with the JWKS key). */
function verifyDelivery(d: Received, secret: string, jwkX: string): boolean {
  const h = parseSignatureHeader(String(d.headers["nearpay-signature"]));
  if (!h) return false;
  const payload = signedPayload(h.timestamp, d.body);
  const want = Buffer.from(hmacV1(secret, payload), "hex");
  if (!h.v1.some((v) => timingSafeEqual(Buffer.from(v, "hex"), want))) return false;
  const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwkX }, format: "jwk" });
  return verify(null, Buffer.from(payload), pub, Buffer.from(h.v1a as string, "base64url"));
}

const deliveriesTo = (m: Merchant) => st.receiver.received.filter((r) => r.path === `/hooks/${m.account}`);

describe("webhook endpoints", () => {
  it("creates an endpoint; the secret is returned once and stored encrypted", async () => {
    const m = st.merchant();
    const { token, r } = await endpoint(m, { description: "orders", enabled_events: ["payment_intent.succeeded"] });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      object: "webhook_endpoint",
      livemode: false,
      enabled_events: ["payment_intent.succeeded"],
      api_version: "2026-11-01",
      description: "orders",
      status: "enabled",
      disabled_reason: null,
    });
    expect(r.body.secret).toMatch(/^whsec_[0-9A-Za-z]{48}$/);
    const got = await st.call("GET", `/v1/webhook_endpoints/${r.body.id}`, { token });
    expect(got.status).toBe(200);
    expect(got.body).not.toHaveProperty("secret");
    const row = await st.admin.db
      .selectFrom("webhook_endpoints")
      .selectAll()
      .where("id", "=", toUuid(r.body.id, "we"))
      .executeTakeFirstOrThrow();
    expect(row.secret_enc.toString("latin1")).not.toContain(r.body.secret);
    const t = await st.admin.db
      .selectFrom("webhook_endpoint_transitions")
      .selectAll()
      .where("webhook_endpoint_id", "=", row.id)
      .execute();
    expect(t).toMatchObject([{ from_state: null, to_state: "enabled", cause: "created" }]);
    expect(t[0]?.actor).toMatch(/^secret_key:key_/);
  });

  it("replays an idempotent create with the same secret (response stored encrypted)", async () => {
    const m = st.merchant();
    const a = await endpoint(m, {}, { key: "create-1" });
    const b = await endpoint(m, {}, { key: "create-1" });
    expect(b.r.status).toBe(201);
    expect(b.r.headers.get("idempotent-replayed")).toBe("true");
    expect(b.r.body).toEqual(a.r.body);
    const stored = await st.admin.db
      .selectFrom("idempotency_keys")
      .select("response_body_enc")
      .where("key", "=", "create-1")
      .executeTakeFirstOrThrow();
    expect((stored.response_body_enc as Buffer).toString("latin1")).not.toContain(a.r.body.secret);
    const conflict = await endpoint(m, { description: "different" }, { key: "create-1" });
    expect(conflict.r.status).toBe(409);
    expect(conflict.r.body.error.code).toBe("idempotency_key_reused");
  });

  it("rejects URLs that fail the SSRF rules and unknown event types", async () => {
    const m = st.merchant();
    const live = await endpoint(m, { url: "http://shop.example.com/hook" }, { livemode: true });
    expect(live.r.status).toBe(400);
    expect(live.r.body.error).toMatchObject({ code: "url_invalid", param: "url" });
    expect(live.r.body.error.message).toMatch(/https is required in live mode/);
    for (const url of [
      "https://10.0.0.5/hook",
      "https://169.254.169.254/latest",
      "https://identity-api/internal",
      "https://shop.example.com:8443/",
    ]) {
      const r = await endpoint(m, { url });
      expect(r.r.status, url).toBe(400);
      expect(r.r.body.error.code, url).toBe("url_invalid");
    }
    // spec 0.1.5: any string passes request validation; the service answers event_type_unknown
    const unknown = await endpoint(m, { enabled_events: ["payment_intent.done"] });
    expect(unknown.r.status).toBe(400);
    expect(unknown.r.body.error).toMatchObject({
      code: "event_type_unknown",
      type: "invalid_request_error",
      param: "enabled_events[0]",
      message: "Unknown event type: payment_intent.done",
    });
    const withStar = await endpoint(m, { enabled_events: ["*", "payment_intent.done"] });
    expect(withStar.r.body.error).toMatchObject({ code: "event_type_unknown", param: "enabled_events[1]" });
    const ok = await endpoint(m, { enabled_events: ["payment_intent.succeeded"] });
    const upd = await st.call("PATCH", `/v1/webhook_endpoints/${ok.r.body.id}`, {
      token: ok.token,
      body: { enabled_events: ["payment_intent.succeeded", "mandate.renewed"] }, // not a type in spec 0.4.0
    });
    expect(upd.status).toBe(400);
    expect(upd.body.error).toMatchObject({ code: "event_type_unknown", param: "enabled_events[1]" });
    const kept = await st.call("GET", `/v1/webhook_endpoints/${ok.r.body.id}`, { token: ok.token });
    expect(kept.body.enabled_events).toEqual(["payment_intent.succeeded"]);
    const billing = await endpoint(m, { enabled_events: ["invoice.paid", "customer.subscription.deleted"] }); // Stage 3
    expect(billing.r.status).toBe(201);
    const mandates = await endpoint(m, { enabled_events: ["mandate.activated", "mandate.released"] }); // Stage 4
    expect(mandates.r.status).toBe(201);
    // request validation still bounds the items
    const long = await endpoint(m, { enabled_events: ["x".repeat(101)] });
    expect(long.r.body.error.code).toBe("invalid_request");
    const empty = await endpoint(m, { enabled_events: [""] });
    expect(empty.r.body.error.code).toBe("invalid_request");
  });

  it("lists with cursors, updates (URL re-validated, disable/enable) and deletes", async () => {
    const m = st.merchant();
    const ids: string[] = [];
    let token = "";
    for (let i = 0; i < 3; i++) {
      const e = await endpoint(m, { description: `e${i}` });
      ids.push(e.r.body.id);
      token = e.token;
    }
    const p1 = await st.call("GET", "/v1/webhook_endpoints?limit=2", { token });
    expect(p1.body).toMatchObject({ object: "list", has_more: true, url: "/v1/webhook_endpoints" });
    expect(p1.body.data.map((e: { id: string }) => e.id)).toEqual([ids[2], ids[1]]);
    const p2 = await st.call("GET", `/v1/webhook_endpoints?limit=2&starting_after=${ids[1]}`, { token });
    expect(p2.body.data.map((e: { id: string }) => e.id)).toEqual([ids[0]]);
    expect(p2.body.has_more).toBe(false);
    const back = await st.call("GET", `/v1/webhook_endpoints?limit=1&ending_before=${ids[0]}`, { token });
    expect(back.body.data.map((e: { id: string }) => e.id)).toEqual([ids[1]]);
    const bad = await st.call("GET", "/v1/webhook_endpoints?starting_after=nope", { token });
    expect(bad.status).toBe(400);

    const id = ids[0] as string;
    const badUrl = await st.call("PATCH", `/v1/webhook_endpoints/${id}`, {
      token,
      body: { url: "https://192.168.0.10/x" },
    });
    expect(badUrl.body.error.code).toBe("url_invalid");
    const upd = await st.call("PATCH", `/v1/webhook_endpoints/${id}`, {
      token,
      body: { enabled_events: ["agent_payment.settled", "agent_payment.settled"], description: null, disabled: true },
    });
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({
      enabled_events: ["agent_payment.settled"],
      description: null,
      status: "disabled",
      disabled_reason: "merchant",
    });
    const ping = await st.call("POST", `/v1/webhook_endpoints/${id}/test`, { token, body: {} });
    expect(ping.status).toBe(409);
    expect(ping.body.error.code).toBe("state_conflict");
    const re = await st.call("PATCH", `/v1/webhook_endpoints/${id}`, { token, body: { disabled: false } });
    expect(re.body).toMatchObject({ status: "enabled", disabled_reason: null });

    expect((await st.call("DELETE", `/v1/webhook_endpoints/${id}`, { token })).status).toBe(204);
    expect((await st.call("GET", `/v1/webhook_endpoints/${id}`, { token })).status).toBe(404);
    expect((await st.call("DELETE", `/v1/webhook_endpoints/${id}`, { token })).status).toBe(404);
    const t = await st.admin.db
      .selectFrom("webhook_endpoint_transitions")
      .select(["from_state", "to_state", "cause"])
      .where("webhook_endpoint_id", "=", toUuid(id, "we"))
      .orderBy("created_at")
      .execute();
    expect(t.map((x) => x.cause)).toEqual(["created", "merchant_disabled", "merchant_enabled", "deleted"]);
  });

  it("isolates accounts and modes (INV-8) and requires the right scopes", async () => {
    const m = st.merchant();
    const { r } = await endpoint(m);
    const liveToken = await st.token(m, { livemode: true });
    expect((await st.call("GET", `/v1/webhook_endpoints/${r.body.id}`, { token: liveToken })).status).toBe(404);
    const other = await st.token(st.merchant());
    expect((await st.call("GET", `/v1/webhook_endpoints/${r.body.id}`, { token: other })).status).toBe(404);
    expect((await st.call("GET", "/v1/webhook_endpoints")).status).toBe(401);
    const readOnly = await st.token(m, { ptype: "restricted_key", scp: ["webhook_endpoints.read"] });
    expect((await st.call("GET", `/v1/webhook_endpoints/${r.body.id}`, { token: readOnly })).status).toBe(200);
    const denied = await st.call("POST", "/v1/webhook_endpoints", {
      token: readOnly,
      body: { url: "https://shop.example.com/h", enabled_events: ["*"] },
    });
    expect(denied.status).toBe(403);
    expect((await st.call("GET", "/v1/events", { token: readOnly })).status).toBe(403);
  });

  it("serves the signing keys anonymously", async () => {
    const r = await st.call("GET", "/v1/webhook_signing_keys");
    expect(r.status).toBe(200);
    expect(r.body.keys).toEqual([
      {
        kty: "OKP",
        crv: "Ed25519",
        x: st.signingKey.publicKey.toString("base64url"),
        kid: st.signingKey.kid,
        alg: "EdDSA",
        use: "sig",
      },
    ]);
  });
});

describe("delivery", () => {
  it("sends a signed ping through the egress proxy", async () => {
    const m = st.merchant();
    const { token, r } = await endpoint(m, { enabled_events: ["payment_intent.succeeded"] });
    const ping = await st.call("POST", `/v1/webhook_endpoints/${r.body.id}/test`, {
      token,
      body: {},
      headers: { "idempotency-key": "ping-1" },
    });
    expect(ping.status).toBe(202);
    expect(ping.body).toMatchObject({
      object: "event",
      type: "ping",
      data: { object: { object: "ping", webhook_endpoint: r.body.id } },
    });
    expect(ping.body.request).toMatchObject({ idempotency_key: "ping-1" });
    expect(ping.body.request.id).toMatch(/^req_/);
    const [d] = await waitFor(async () => (deliveriesTo(m).length ? deliveriesTo(m) : null));
    expect(d?.headers).toMatchObject({
      "content-type": "application/json; charset=utf-8",
      "user-agent": "NearPay-Webhooks/1.0",
      "nearpay-event-id": ping.body.id,
      "nearpay-event-type": "ping",
    });
    expect(JSON.parse(d?.body as string)).toEqual(ping.body);
    expect(verifyDelivery(d as Received, r.body.secret, st.signingKey.publicKey.toString("base64url"))).toBe(true);
    expect(String(d?.headers["nearpay-signature"])).toContain(`kid=${st.signingKey.kid}`);
    expect(st.proxy.seen).toContain(`POST ${st.receiver.url}/hooks/${m.account}`);
    const row = await waitFor(() =>
      st.admin.db
        .selectFrom("deliveries")
        .selectAll()
        .where("event_id", "=", toUuid(ping.body.id, "evt"))
        .where("status", "=", "succeeded")
        .executeTakeFirst(),
    );
    expect(row).toMatchObject({ attempts: 1, last_status_code: 200, last_error: null });
    const ep = await st.admin.db
      .selectFrom("webhook_endpoints")
      .selectAll()
      .where("id", "=", row.endpoint_id)
      .executeTakeFirstOrThrow();
    expect(ep.last_success_at).not.toBeNull();
  });

  it("turns domain events into public events and delivers them to subscribed endpoints only", async () => {
    const m = st.merchant();
    const all = await endpoint(m, { url: `${st.receiver.url}/hooks/${m.account}` });
    const only = await endpoint(m, {
      url: `${st.receiver.url}/hooks/${m.account}-sessions`,
      enabled_events: ["checkout.session.completed"],
    });
    const live = await endpoint(m, { url: "https://shop.example.com/live" }, { livemode: true });
    expect(live.r.status).toBe(201);
    const pi = paymentIntent({ status: "succeeded", sequence: 4, amount_settled: "2000042" });
    const e = domainEvent("evt.payments.payment_intent.succeeded", pi, {
      accountUuid: m.uuid,
      livemode: false,
      version: 4,
      previous: { status: "processing" },
    });
    await st.publishEvent(e);
    const [d] = await waitFor(async () => (deliveriesTo(m).length ? deliveriesTo(m) : null));
    const body = JSON.parse(d?.body as string);
    expect(body).toMatchObject({
      object: "event",
      type: "payment_intent.succeeded",
      livemode: false,
      data: { object: { id: pi.id, status: "succeeded", sequence: 4 }, previous_attributes: { status: "processing" } },
      request: { id: null, idempotency_key: null },
    });
    expect(verifyDelivery(d as Received, all.r.body.secret, st.signingKey.publicKey.toString("base64url"))).toBe(true);
    // the events API serves the same object
    const got = await st.call("GET", `/v1/events/${body.id}`, { token: all.token });
    expect(got.status).toBe(200);
    expect(got.body).toEqual(body);
    // the sessions-only endpoint and the live endpoint got nothing
    const ev = await st.admin.db
      .selectFrom("events")
      .selectAll()
      .where("source_event_id", "=", e.id)
      .executeTakeFirstOrThrow();
    const ds = await st.admin.db.selectFrom("deliveries").select("endpoint_id").where("event_id", "=", ev.id).execute();
    expect(ds.map((x) => fromUuid("we", x.endpoint_id))).toEqual([all.r.body.id]);
    expect(only.r.body.id).toBeTruthy();
    expect((await st.call("GET", `/v1/events/${body.id}`, { token: live.token })).status).toBe(404);
  });

  it("ingests checkout sessions and agent payments; objects without a sequence get the aggregate version", async () => {
    const m = st.merchant();
    const { token } = await endpoint(m);
    const cs = checkoutSession({ status: "complete" });
    await st.publishEvent(
      domainEvent("evt.payments.checkout_session.completed", cs, { accountUuid: m.uuid, version: 3 }),
    );
    const ap = agentPayment();
    await st.publishEvent(domainEvent("evt.agentpay.agent_payment.settled", ap, { accountUuid: m.uuid, version: 2 }));
    const list = await waitFor(async () => {
      const r = await st.call("GET", "/v1/events", { token });
      return r.body.data.length === 2 ? r : null;
    });
    expect(list.body.data.map((e: { type: string }) => e.type).sort()).toEqual([
      "agent_payment.settled",
      "checkout.session.completed",
    ]);
    const session = list.body.data.find((e: { type: string }) => e.type === "checkout.session.completed");
    expect(session.data.object).toMatchObject({ id: cs.id, sequence: 3, client_secret: null, url: null });
    const typed = await st.call("GET", "/v1/events?type=agent_payment.settled", { token });
    expect(typed.body.data).toHaveLength(1);
    expect(typed.body.data[0].data.object).toMatchObject({ id: ap.id, sequence: 2 });
    const future = Math.floor(Date.now() / 1000) + 3600;
    expect((await st.call("GET", `/v1/events?created[gte]=${future}`, { token })).body.data).toHaveLength(0);
    const page = await st.call("GET", "/v1/events?limit=1", { token });
    expect(page.body.has_more).toBe(true);
    const next = await st.call("GET", `/v1/events?limit=1&starting_after=${page.body.data[0].id}`, { token });
    expect(next.body.data[0].id).not.toBe(page.body.data[0].id);
    await waitFor(async () => (deliveriesTo(m).length === 2 ? true : null));
  });

  it("keeps the producer's own sequence (spec 0.1.5) instead of the aggregate version", async () => {
    const m = st.merchant();
    const { token } = await endpoint(m);
    const cs = checkoutSession({ status: "expired", sequence: 11 });
    const e = domainEvent("evt.payments.checkout_session.expired", cs, { accountUuid: m.uuid, version: 5 });
    await st.publishEvent(e);
    const ap = agentPayment({ status: "failed", sequence: 0 });
    await st.publishEvent(domainEvent("evt.agentpay.agent_payment.failed", ap, { accountUuid: m.uuid, version: 2 }));
    const list = await waitFor(async () => {
      const r = await st.call("GET", "/v1/events", { token });
      return r.body.data.length === 2 ? r : null;
    });
    const byType = (t: string) => list.body.data.find((x: { type: string }) => x.type === t);
    expect(byType("checkout.session.expired").data.object).toMatchObject({ id: cs.id, sequence: 11 });
    expect(byType("agent_payment.failed").data.object).toMatchObject({ id: ap.id, sequence: 0 });
    const row = await st.admin.db
      .selectFrom("events")
      .select("object_sequence")
      .where("source_event_id", "=", e.id)
      .executeTakeFirstOrThrow();
    expect(row.object_sequence).toBe(11);
    // the delivered payload carries the same sequence
    const delivered = await waitFor(async () => (deliveriesTo(m).length === 2 ? deliveriesTo(m) : null));
    const sent = delivered.map((d) => JSON.parse(d.body)).find((b) => b.type === "checkout.session.expired");
    expect(sent.data.object.sequence).toBe(11);
  });

  it("ingests each domain event once (inbox + source_event_id) and dead-letters invalid ones", async () => {
    const m = st.merchant();
    await endpoint(m, { url: "https://shop.example.com/never-called" }); // the test proxy refuses it
    const e = domainEvent("evt.payments.payment_intent.created", paymentIntent(), { accountUuid: m.uuid });
    const h = webhooksHandlers(st.ingest.webhooks)["evt.payments.payment_intent.created"];
    await h?.(e);
    await h?.(e);
    await h?.({ ...e, id: uuidv7() }); // a different domain event id is a different event
    const rows = await st.admin.db
      .selectFrom("events")
      .select("source_event_id")
      .where("account_id", "=", m.uuid)
      .execute();
    expect(rows).toHaveLength(2);
    // replaying an envelope that skipped the inbox still yields one event
    await st.admin.db.deleteFrom("inbox").where("event_id", "=", e.id).execute();
    await h?.(e);
    expect(await st.admin.db.selectFrom("events").select("id").where("account_id", "=", m.uuid).execute()).toHaveLength(
      2,
    );
    const bad = { ...e, id: uuidv7(), data: { object: { id: "pi_nope" } } };
    await h?.(bad);
    const dl = await st.admin.db.selectFrom("dead_letters").selectAll().where("subject", "=", e.subject).execute();
    expect(dl.some((d) => (d.payload as { id: string }).id === bad.id)).toBe(true);
    await st.admin.db
      .updateTable("webhook_endpoints")
      .set({ status: "disabled", disabled_reason: "merchant" })
      .where("account_id", "=", m.uuid)
      .execute();
  });

  it("retries failures on the schedule with an attempt log, then succeeds", async () => {
    const m = st.merchant();
    const { token, r } = await endpoint(m);
    st.receiver.queue({ status: 500, body: "boom" });
    const ping = await st.call("POST", `/v1/webhook_endpoints/${r.body.id}/test`, { token, body: {} });
    const evt = toUuid(ping.body.id, "evt");
    const failed = await waitFor(() =>
      st.admin.db
        .selectFrom("deliveries")
        .selectAll()
        .where("event_id", "=", evt)
        .where("status", "=", "failed")
        .executeTakeFirst(),
    );
    expect(failed).toMatchObject({ attempts: 1, last_status_code: 500, last_error: "HTTP 500" });
    const delay = (failed.next_attempt_at as Date).getTime() - Date.now();
    expect(delay).toBeGreaterThan(40_000);
    expect(delay).toBeLessThan(67_000);
    const ep1 = await st.admin.db
      .selectFrom("webhook_endpoints")
      .selectAll()
      .where("id", "=", failed.endpoint_id)
      .executeTakeFirstOrThrow();
    expect(ep1.failing_since).not.toBeNull();
    // fast-forward the retry
    await st.admin.db
      .updateTable("deliveries")
      .set({ next_attempt_at: new Date() })
      .where("id", "=", failed.id)
      .execute();
    const ok = await waitFor(() =>
      st.admin.db
        .selectFrom("deliveries")
        .selectAll()
        .where("id", "=", failed.id)
        .where("status", "=", "succeeded")
        .executeTakeFirst(),
    );
    expect(ok.attempts).toBe(2);
    const attempts = await st.admin.db
      .selectFrom("delivery_attempts")
      .selectAll()
      .where("delivery_id", "=", failed.id)
      .orderBy("attempt_no")
      .execute();
    expect(attempts).toMatchObject([
      { attempt_no: 1, status_code: 500, error: "HTTP 500", response_excerpt: "boom" },
      { attempt_no: 2, status_code: 200, error: null, response_excerpt: "ok" },
    ]);
    const ep2 = await st.admin.db
      .selectFrom("webhook_endpoints")
      .selectAll()
      .where("id", "=", failed.endpoint_id)
      .executeTakeFirstOrThrow();
    expect(ep2.failing_since).toBeNull();
    expect(ep2.last_success_at).not.toBeNull();
  });

  it("records timeouts and proxy refusals as failed attempts", async () => {
    const m = st.merchant();
    const { token, r } = await endpoint(m);
    st.receiver.queue({ delayMs: 4_000 });
    const ping = await st.call("POST", `/v1/webhook_endpoints/${r.body.id}/test`, { token, body: {} });
    const d = await waitFor(() =>
      st.admin.db
        .selectFrom("deliveries")
        .selectAll()
        .where("event_id", "=", toUuid(ping.body.id, "evt"))
        .where("status", "=", "failed")
        .executeTakeFirst(),
    );
    expect(d).toMatchObject({ last_status_code: null, last_error: "timeout after 2000 ms" });
    st.proxy.deny.add("127.0.0.1");
    try {
      await st.admin.db.updateTable("deliveries").set({ next_attempt_at: new Date() }).where("id", "=", d.id).execute();
      const again = await waitFor(() =>
        st.admin.db
          .selectFrom("deliveries")
          .selectAll()
          .where("id", "=", d.id)
          .where("attempts", "=", 2)
          .executeTakeFirst(),
      );
      expect(again.last_error).toMatch(/egress proxy refused/);
    } finally {
      st.proxy.deny.delete("127.0.0.1");
    }
  });

  it("abandons after 72 h and disables an endpoint failing for more than 72 h (evt.webhooks.endpoint.disabled)", async () => {
    const m = st.merchant();
    const { token, r } = await endpoint(m);
    const epId = toUuid(r.body.id, "we");
    const probe = await st.probe();
    // a failure streak that started 73 h ago; the next ping delivery fails as well
    const longAgo = new Date(Date.now() - 73 * 3_600_000);
    await st.admin.db.updateTable("webhook_endpoints").set({ failing_since: longAgo }).where("id", "=", epId).execute();
    st.receiver.queue({ status: 503 });
    const ping = await st.call("POST", `/v1/webhook_endpoints/${r.body.id}/test`, { token, body: {} });
    // the delivery itself is fresh: failed, not abandoned
    const d = await waitFor(() =>
      st.admin.db
        .selectFrom("deliveries")
        .selectAll()
        .where("event_id", "=", toUuid(ping.body.id, "evt"))
        .where("attempts", "=", 1)
        .executeTakeFirst(),
    );
    expect(d.status).toBe("failed");
    const ep = await st.admin.db
      .selectFrom("webhook_endpoints")
      .selectAll()
      .where("id", "=", epId)
      .executeTakeFirstOrThrow();
    expect(ep).toMatchObject({ status: "disabled", disabled_reason: "failing" });
    const evt = await expectEvent(probe, "evt.webhooks.endpoint.disabled", {
      data: { object: { endpoint_id: r.body.id } },
    });
    expect(evt).toMatchObject({
      account_id: m.uuid,
      livemode: false,
      aggregate: { type: "webhook_endpoint", id: r.body.id },
      data: {
        object: { account_id: m.account, reason: "failing", url: r.body.url, failing_since: longAgo.toISOString() },
      },
    });
    const t = await st.admin.db
      .selectFrom("webhook_endpoint_transitions")
      .selectAll()
      .where("webhook_endpoint_id", "=", epId)
      .orderBy("created_at")
      .execute();
    expect(t.at(-1)).toMatchObject({
      from_state: "enabled",
      to_state: "disabled",
      cause: "failing_72h",
      actor: "webhooks-dispatcher",
    });
    // the dispatcher skips disabled endpoints; the API shows the reason
    expect((await st.call("GET", `/v1/webhook_endpoints/${r.body.id}`, { token })).body).toMatchObject({
      status: "disabled",
      disabled_reason: "failing",
    });
    expect(await claimDue(st.dispatcher.dispatcher, 100).then((c) => c.filter((x) => x.endpoint_id === epId))).toEqual(
      [],
    );

    // abandonment: a delivery older than 72 h fails once more → abandoned
    await st.admin.db
      .updateTable("webhook_endpoints")
      .set({ status: "enabled", disabled_reason: null, failing_since: null })
      .where("id", "=", epId)
      .execute();
    await st.admin.db
      .updateTable("deliveries")
      .set({ created_at: new Date(Date.now() - 72 * 3_600_000 - 1_000), next_attempt_at: new Date() })
      .where("id", "=", d.id)
      .execute();
    st.receiver.queue({ status: 500 });
    const gone = await waitFor(() =>
      st.admin.db
        .selectFrom("deliveries")
        .selectAll()
        .where("id", "=", d.id)
        .where("status", "=", "abandoned")
        .executeTakeFirst(),
    );
    expect(gone).toMatchObject({ attempts: 2, next_attempt_at: null });
  });

  it("abandons undelivered deliveries of deleted endpoints and old ones in the sweep; purges past retention", async () => {
    const m = st.merchant();
    const { token, r } = await endpoint(m, { url: "https://shop.example.com/x" });
    await st.call("PATCH", `/v1/webhook_endpoints/${r.body.id}`, { token, body: { disabled: true } });
    await st.call("PATCH", `/v1/webhook_endpoints/${r.body.id}`, { token, body: { disabled: false } });
    // disable first so the dispatcher never tries shop.example.com
    await st.call("PATCH", `/v1/webhook_endpoints/${r.body.id}`, { token, body: { disabled: true } });
    const e = domainEvent("evt.payments.payment_intent.canceled", paymentIntent({ status: "canceled" }), {
      accountUuid: m.uuid,
    });
    const h = webhooksHandlers(st.ingest.webhooks)["evt.payments.payment_intent.canceled"];
    await h?.(e);
    const ev = await st.admin.db
      .selectFrom("events")
      .selectAll()
      .where("source_event_id", "=", e.id)
      .executeTakeFirstOrThrow();
    // disabled endpoints get no new deliveries; add one by hand to exercise the sweep
    await st.admin.db
      .insertInto("deliveries")
      .values({
        id: uuidv7(),
        event_id: ev.id,
        endpoint_id: toUuid(r.body.id, "we"),
        status: "pending",
        next_attempt_at: new Date(),
        created_at: new Date(Date.now() - 73 * 3_600_000),
      })
      .execute();
    expect(await abandonExpired(st.ingest.webhooks)).toBeGreaterThanOrEqual(1);
    const swept = await st.admin.db
      .selectFrom("deliveries")
      .selectAll()
      .where("event_id", "=", ev.id)
      .executeTakeFirstOrThrow();
    expect(swept).toMatchObject({ status: "abandoned", last_error: "not delivered within 72 h" });

    await st.admin.db
      .updateTable("events")
      .set({ created_at: new Date(Date.now() - 31 * 86_400_000) })
      .where("id", "=", ev.id)
      .execute();
    expect((await st.call("GET", `/v1/events/${fromUuid("evt", ev.id)}`, { token })).status).toBe(404);
    const purged = await purgeEvents(st.ingest.webhooks);
    expect(purged.events).toBeGreaterThanOrEqual(1);
    expect(await st.admin.db.selectFrom("events").select("id").where("id", "=", ev.id).execute()).toHaveLength(0);
  });

  it("limits deliveries in flight per endpoint (Valkey semaphore, local fallback)", async () => {
    const valkey = st.valkey?.url as string;
    const sem = valkeySemaphore(valkey, 2);
    await waitFor(async () => sem.shared());
    const a = await sem.acquire("ep-1");
    const b = await sem.acquire("ep-1");
    expect(a && b).toBeTruthy();
    expect(await sem.acquire("ep-1")).toBeNull();
    expect(await sem.acquire("ep-2")).not.toBeNull();
    await a?.();
    expect(await sem.acquire("ep-1")).not.toBeNull();
    await sem.close();
    // Valkey unreachable → one per endpoint in this process
    const down = valkeySemaphore("redis://127.0.0.1:1", 5);
    expect(down.shared()).toBe(false);
    const x = await down.acquire("ep");
    expect(x).not.toBeNull();
    expect(await down.acquire("ep")).toBeNull();
    await x?.();
    expect(await down.acquire("ep")).not.toBeNull();
    await down.close();
    const local = localSemaphore(1);
    const l = await local.acquire("e");
    await l?.();
    await l?.();
    expect(await local.acquire("e")).not.toBeNull();
  });

  it("postpones a claimed delivery when its endpoint is at the limit (no attempt counted)", async () => {
    const m = st.merchant();
    const { token, r } = await endpoint(m);
    const epId = toUuid(r.body.id, "we");
    await st.call("PATCH", `/v1/webhook_endpoints/${r.body.id}`, { token, body: { disabled: true } });
    const ev = await st.admin.db.selectFrom("events").select("id").limit(1).executeTakeFirstOrThrow();
    const id = uuidv7();
    await st.admin.db
      .insertInto("deliveries")
      .values({ id, event_id: ev.id, endpoint_id: epId, status: "pending", next_attempt_at: new Date() })
      .execute();
    const full = {
      ...st.dispatcher.dispatcher,
      semaphore: { acquire: async () => null, shared: () => false, close: async () => {} },
    };
    await deliverOne(full, { id, endpoint_id: epId });
    const row = await st.admin.db.selectFrom("deliveries").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    expect(row.attempts).toBe(0);
    expect((row.next_attempt_at as Date).getTime()).toBeGreaterThan(Date.now());
  });
});

describe("delivery log (GET /v1/webhook_endpoints/{id}/deliveries)", () => {
  const ids = (r: { body: { data: { id: string }[] } }) => r.body.data.map((d) => d.id);

  it("lists an endpoint's deliveries newest first with cursors, in the spec shape", async () => {
    const m = st.merchant();
    const { token, r } = await endpoint(m);
    const epId = toUuid(r.body.id, "we");
    const deliveryOf = async (evt: string) =>
      st.admin.db
        .selectFrom("deliveries")
        .selectAll()
        .where("event_id", "=", toUuid(evt, "evt"))
        .where("endpoint_id", "=", epId)
        .executeTakeFirstOrThrow();

    // 1: a ping whose first attempt gets a 500 (failed, retry scheduled)
    st.receiver.queue({ status: 500, body: "boom" });
    const p1 = await st.call("POST", `/v1/webhook_endpoints/${r.body.id}/test`, { token, body: {} });
    await waitFor(async () => ((await deliveryOf(p1.body.id)).status === "failed" ? true : null));
    // 2: a ping that succeeds
    const p2 = await st.call("POST", `/v1/webhook_endpoints/${r.body.id}/test`, { token, body: {} });
    await waitFor(async () => ((await deliveryOf(p2.body.id)).status === "succeeded" ? true : null));
    // 3: an ingested domain event (delivery id generated at ingest), delivered
    const pi = paymentIntent({ status: "succeeded", sequence: 2 });
    const e = domainEvent("evt.payments.payment_intent.succeeded", pi, { accountUuid: m.uuid, version: 2 });
    await st.publishEvent(e);
    const ev = await waitFor(() =>
      st.admin.db.selectFrom("events").selectAll().where("source_event_id", "=", e.id).executeTakeFirst(),
    );
    const d3 = await waitFor(async () => {
      const d = await deliveryOf(fromUuid("evt", ev.id));
      return d.status === "succeeded" ? d : null;
    });
    expect(d3.id[14]).toBe("7"); // UUIDv7, like every other prefixed id
    // 0: an older delivery with a random (pre-UUIDv7) id, abandoned; and one past the 30-day window
    const old = await st.admin.db
      .insertInto("events")
      .values({
        id: uuidv7(),
        account_id: m.uuid,
        livemode: false,
        type: "payment_intent.created",
        source_event_id: uuidv7(),
        object_type: "payment_intent",
        object_id: pi.id,
        object_sequence: 1,
        data: JSON.stringify(paymentIntent()),
        created_at: new Date(Date.now() - 3_600_000),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const legacy = randomUUID();
    await st.admin.db
      .insertInto("deliveries")
      .values({
        id: legacy,
        event_id: old.id,
        endpoint_id: epId,
        status: "abandoned",
        attempts: 0,
        last_error: "endpoint disabled for 72 h",
        created_at: new Date(Date.now() - 3_600_000),
      })
      .execute();
    const ancient = await st.admin.db
      .insertInto("events")
      .values({
        id: uuidv7(),
        account_id: m.uuid,
        livemode: false,
        type: "payment_intent.created",
        source_event_id: uuidv7(),
        object_type: "payment_intent",
        object_id: pi.id,
        object_sequence: 1,
        data: JSON.stringify(paymentIntent()),
        created_at: new Date(Date.now() - 31 * 86_400_000),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await st.admin.db
      .insertInto("deliveries")
      .values({
        id: uuidv7(),
        event_id: ancient.id,
        endpoint_id: epId,
        status: "succeeded",
        attempts: 1,
        created_at: new Date(Date.now() - 31 * 86_400_000),
      })
      .execute();

    const d1 = fromUuid("whd", (await deliveryOf(p1.body.id)).id);
    const d2 = fromUuid("whd", (await deliveryOf(p2.body.id)).id);
    const whd3 = fromUuid("whd", d3.id);
    const whd0 = fromUuid("whd", legacy);
    const path = `/v1/webhook_endpoints/${r.body.id}/deliveries`;

    const all = await st.call("GET", path, { token });
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ object: "list", has_more: false, url: path });
    expect(ids(all)).toEqual([whd3, d2, d1, whd0]);
    for (const d of all.body.data) {
      const parsed = WebhookDelivery.safeParse(d);
      expect(parsed.success, JSON.stringify(d)).toBe(true);
    }
    const [g3, g2, g1, g0] = all.body.data;
    expect(g3).toMatchObject({
      object: "webhook_delivery",
      livemode: false,
      webhook_endpoint: r.body.id,
      event: fromUuid("evt", ev.id),
      event_type: "payment_intent.succeeded",
      status: "succeeded",
      attempts: 1,
      last_status_code: 200,
      last_error: null,
      next_attempt_at: null,
    });
    expect(g3.succeeded_at).toBeGreaterThanOrEqual(g3.created);
    expect(g2).toMatchObject({ event: p2.body.id, event_type: "ping", status: "succeeded" });
    expect(g1).toMatchObject({
      event: p1.body.id,
      event_type: "ping",
      status: "failed",
      attempts: 1,
      last_status_code: 500,
      last_error: "HTTP 500",
      succeeded_at: null,
    });
    expect(g1.next_attempt_at).toBeGreaterThan(Math.floor(Date.now() / 1000) + 30);
    expect(g0).toMatchObject({
      status: "abandoned",
      event_type: "payment_intent.created",
      attempts: 0,
      last_status_code: null,
      last_error: "endpoint disabled for 72 h",
      next_attempt_at: null,
      succeeded_at: null,
    });

    // pages of 2 forward and back
    const p = await st.call("GET", `${path}?limit=2`, { token });
    expect(ids(p)).toEqual([whd3, d2]);
    expect(p.body.has_more).toBe(true);
    const n = await st.call("GET", `${path}?limit=2&starting_after=${d2}`, { token });
    expect(ids(n)).toEqual([d1, whd0]);
    expect(n.body.has_more).toBe(false);
    const after0 = await st.call("GET", `${path}?limit=2&starting_after=${whd0}`, { token });
    expect(after0.body).toMatchObject({ data: [], has_more: false });
    const back = await st.call("GET", `${path}?limit=2&ending_before=${whd0}`, { token });
    expect(ids(back)).toEqual([d2, d1]);
    expect(back.body.has_more).toBe(true);
    const top = await st.call("GET", `${path}?limit=2&ending_before=${d2}`, { token });
    expect(ids(top)).toEqual([whd3]);
    expect(top.body.has_more).toBe(false);

    // cursors must be deliveries of this endpoint
    const bad = await st.call("GET", `${path}?starting_after=${p1.body.id}`, { token });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatchObject({ code: "invalid_request", param: "starting_after" });
    const other = await endpoint(m);
    const foreign = await st.call("GET", `/v1/webhook_endpoints/${other.r.body.id}/deliveries?ending_before=${d1}`, {
      token,
    });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error.param).toBe("ending_before");
    const none = await st.call("GET", `/v1/webhook_endpoints/${other.r.body.id}/deliveries`, { token });
    expect(none.body).toMatchObject({ data: [], has_more: false });
    expect((await st.call("GET", `${path}?limit=0`, { token })).status).toBe(400);
  });

  it("shows pending deliveries and abandons them when the endpoint is deleted (then 404)", async () => {
    const m = st.merchant();
    const { token, r } = await endpoint(m);
    await st.call("PATCH", `/v1/webhook_endpoints/${r.body.id}`, { token, body: { disabled: true } });
    const ev = await st.admin.db
      .insertInto("events")
      .values({
        id: uuidv7(),
        account_id: m.uuid,
        livemode: false,
        type: "checkout.session.completed",
        source_event_id: uuidv7(),
        object_type: "checkout_session",
        object_id: "cs_x",
        object_sequence: 1,
        data: JSON.stringify(checkoutSession()),
        created_at: new Date(),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const id = uuidv7();
    await st.admin.db
      .insertInto("deliveries")
      .values({
        id,
        event_id: ev.id,
        endpoint_id: toUuid(r.body.id, "we"),
        status: "pending",
        next_attempt_at: new Date(),
      })
      .execute();
    const path = `/v1/webhook_endpoints/${r.body.id}/deliveries`;
    const list = await st.call("GET", path, { token });
    expect(list.body.data).toMatchObject([
      {
        id: fromUuid("whd", id),
        event_type: "checkout.session.completed",
        status: "pending",
        attempts: 0,
        last_status_code: null,
      },
    ]);
    expect(list.body.data[0].next_attempt_at).toEqual(expect.any(Number));
    expect((await st.call("DELETE", `/v1/webhook_endpoints/${r.body.id}`, { token })).status).toBe(204);
    expect((await st.call("GET", path, { token })).status).toBe(404);
    const row = await st.admin.db.selectFrom("deliveries").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: "abandoned", next_attempt_at: null });
  });

  it("uses the endpoint read auth: scopes, dashboard roles, account and mode isolation (INV-8)", async () => {
    const m = st.merchant();
    const { r } = await endpoint(m);
    const path = `/v1/webhook_endpoints/${r.body.id}/deliveries`;
    const call = async (token?: string) => (await st.call("GET", path, token ? { token } : {})).status;
    expect(await call()).toBe(401);
    expect(await call(await st.token(m))).toBe(200);
    expect(await call(await st.token(m, { ptype: "restricted_key", scp: ["webhook_endpoints.read"] }))).toBe(200);
    expect(await call(await st.token(m, { ptype: "restricted_key", scp: ["webhook_endpoints.write"] }))).toBe(403);
    expect(await call(await st.token(m, { ptype: "restricted_key", scp: ["events.read"] }))).toBe(403);
    for (const role of ["owner", "admin", "developer"] as const)
      expect(await call(await st.token(m, { ptype: "session", role })), role).toBe(200);
    expect(await call(await st.token(m, { ptype: "session", role: "viewer" }))).toBe(403);
    expect(await call(await st.token(m, { ptype: "session" }))).toBe(403);
    expect(await call(await st.token(m, { livemode: true }))).toBe(404);
    expect(await call(await st.token(st.merchant()))).toBe(404);
    const missing = await st.call("GET", "/v1/webhook_endpoints/we_nope/deliveries", { token: await st.token(m) });
    expect(missing.status).toBe(400);
  });
});

describe("ops CLI", () => {
  it("shows endpoints and events, re-queues deliveries, re-enables endpoints, reports the backlog", async () => {
    const m = st.merchant();
    const { token, r } = await endpoint(m);
    const ping = await st.call("POST", `/v1/webhook_endpoints/${r.body.id}/test`, { token, body: {} });
    await waitFor(() =>
      st.admin.db
        .selectFrom("deliveries")
        .select("id")
        .where("event_id", "=", toUuid(ping.body.id, "evt"))
        .where("status", "=", "succeeded")
        .executeTakeFirst(),
    );
    const run = async (...args: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runOps(args, st.api.webhooks, { out: (l) => out.push(l), err: (l) => err.push(l) });
      return { code, json: out.length ? JSON.parse(out.join("\n")) : null, err: err.join("\n") };
    };
    const ep = await run("endpoint", r.body.id);
    expect(ep.code).toBe(0);
    expect(ep.json.endpoint).toMatchObject({ id: r.body.id, account: m.account });
    expect(ep.json.endpoint).not.toHaveProperty("secret");
    expect(JSON.stringify(ep.json)).not.toContain(r.body.secret);
    expect(ep.json.deliveries.succeeded).toBe(1);
    const ev = await run("event", ping.body.id);
    expect(ev.json.deliveries[0].attempts_log).toHaveLength(1);
    const before = st.receiver.received.length;
    expect((await run("retry", ping.body.id)).json.requeued).toBe(0); // already succeeded
    await st.call("PATCH", `/v1/webhook_endpoints/${r.body.id}`, { token, body: { disabled: true } });
    const en = await run("enable", r.body.id);
    expect(en.json).toMatchObject({ changed: true, endpoint: { status: "enabled" } });
    expect((await run("enable", r.body.id)).json.changed).toBe(false);
    const bl = await run("backlog", "--limit", "5");
    expect(bl.code).toBe(0);
    expect(typeof bl.json.due).toBe("number");
    expect(st.receiver.received.length).toBeGreaterThanOrEqual(before);
    expect((await run("nope")).code).toBe(2);
    expect((await run("endpoint", "we_bad")).code).toBe(2);
    expect((await run("event", fromUuid("evt", uuidv7()))).code).toBe(1);
  });
});
