/**
 * Stage 2 end to end through the real api, ingest and dispatcher (lld/webhooks.md §4–§6, §12):
 * refund / account / review events over NATS → public events → signed deliveries; endpoint secret
 * rotation (both `v1=` signatures during the overlap, only the new secret after it); event resend (one
 * new delivery per endpoint, `(event, endpoint, resend_no)` unique, concurrent resends serialised).
 */
import { timingSafeEqual } from "node:crypto";
import { Event, parseSignatureHeader, signedPayload, WebhookDelivery } from "@nearpay/spec";
import { fromUuid, newId, toUuid, uuidv7 } from "@nearpay-internal/ids";
import { account, domainEvent, paymentIntent } from "@nearpay-internal/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { webhooksHandlers } from "../../src/consumers/handlers.js";
import { hmacV1 } from "../../src/signing/signer.js";
import { expireSecrets } from "../../src/workers/jobs.js";
import { refund, review } from "../support/fixtures.js";
import type { Received } from "../support/net.js";
import { type Merchant, type Stack, startStack, waitFor } from "../support/stack.js";

let st: Stack;

beforeAll(async () => {
  st = await startStack();
});
afterAll(async () => {
  await st?.stop();
});

async function endpoint(
  m: Merchant,
  body: Record<string, unknown> = {},
  o: { livemode?: boolean; path?: string } = {},
): Promise<{ token: string; id: string; secret: string }> {
  const token = await st.token(m, { livemode: o.livemode ?? false });
  const r = await st.call("POST", "/v1/webhook_endpoints", {
    token,
    body: { url: `${st.receiver.url}/hooks/${o.path ?? m.account}`, enabled_events: ["*"], ...body },
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { token, id: r.body.id, secret: r.body.secret };
}

const at = (path: string) => st.receiver.received.filter((r) => r.path === `/hooks/${path}`);

/** True when one of the delivery's `v1=` signatures is the HMAC of this secret. */
function signedWith(d: Received, secret: string): boolean {
  const h = parseSignatureHeader(String(d.headers["nearpay-signature"]));
  if (!h) return false;
  const want = Buffer.from(hmacV1(secret, signedPayload(h.timestamp, d.body)), "hex");
  return h.v1.some((v) => timingSafeEqual(Buffer.from(v, "hex"), want));
}

async function eventsOf(m: Merchant, livemode?: boolean) {
  let q = st.admin.db.selectFrom("events").selectAll().where("account_id", "=", m.uuid);
  if (livemode !== undefined) q = q.where("livemode", "=", livemode);
  return q.orderBy("id").execute();
}

describe("Stage 2 ingest", () => {
  it("ingests every refund event and delivers it to subscribed endpoints, keeping the refund's sequence", async () => {
    const m = st.merchant();
    const all = await endpoint(m, {
      enabled_events: [
        "refund.created",
        "refund.requires_action",
        "refund.pending",
        "refund.succeeded",
        "refund.failed",
        "refund.canceled",
      ],
    });
    await endpoint(m, { enabled_events: ["payment_intent.succeeded"] }, { path: `${m.account}-pi` });
    const re = newId("re");
    const steps = [
      ["created", "requires_action"],
      ["requires_action", "requires_action"],
      ["pending", "pending"],
      ["failed", "failed"],
      ["succeeded", "succeeded"],
      ["canceled", "canceled"],
    ] as const;
    let seq = 1;
    for (const [ev, status] of steps) {
      await st.publishEvent(
        domainEvent(`evt.payments.refund.${ev}`, refund({ id: re, status, sequence: seq }), {
          accountUuid: m.uuid,
          version: seq,
        }),
      );
      seq++;
    }
    const got = await waitFor(async () => (at(m.account).length === 6 ? at(m.account) : null));
    const bodies = got.map((d) => JSON.parse(d.body));
    expect(bodies.map((b) => b.type).sort()).toEqual(steps.map(([e]) => `refund.${e}`).sort());
    for (const b of bodies) {
      expect(Event.safeParse(b).success, b.type).toBe(true);
      expect(b.data.object).toMatchObject({ id: re, object: "refund" });
      expect(signedWith(got[0] as Received, all.secret)).toBe(true);
    }
    const pending = bodies.find((b) => b.type === "refund.pending");
    expect(pending.data.object.sequence).toBe(3);
    // the payment-intent-only endpoint got nothing
    expect(at(`${m.account}-pi`)).toHaveLength(0);
    const list = await st.call("GET", "/v1/events?type=refund.succeeded", { token: all.token });
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].data.object.status).toBe("succeeded");
  });

  it("renders reviews with toPublicReview; a non-public review is skipped and an invalid one dead-lettered", async () => {
    const m = st.merchant();
    const ep = await endpoint(m, { enabled_events: ["review.opened", "review.closed"] });
    const pi = newId("pi");
    const rv = review({ subject: { type: "execution", id: newId("ex") }, payment_intent: pi });
    await st.publishEvent(domainEvent("evt.compliance.review.opened", rv, { accountUuid: m.uuid, version: 1 }));
    const closed = review({
      id: rv.id,
      subject: rv.subject,
      payment_intent: pi,
      status: "closed",
      closed_at: "2026-11-07T12:00:00.000Z",
    });
    await st.publishEvent(domainEvent("evt.compliance.review.closed", closed, { accountUuid: m.uuid, version: 2 }));
    const got = await waitFor(async () => (at(m.account).length === 2 ? at(m.account) : null));
    const byType = Object.fromEntries(got.map((d) => [JSON.parse(d.body).type, JSON.parse(d.body)]));
    expect(byType["review.opened"].data.object).toEqual({
      id: rv.id,
      object: "review",
      created: Math.floor(Date.parse(rv.opened_at) / 1000),
      livemode: false,
      subject: { type: "payment_intent", id: pi },
      reason: rv.reason,
      status: "open",
      closed_at: null,
      sequence: 1,
    });
    expect(byType["review.closed"].data.object).toMatchObject({
      status: "closed",
      closed_at: Math.floor(Date.parse("2026-11-07T12:00:00.000Z") / 1000),
      sequence: 2,
    });
    for (const b of Object.values(byType)) expect(Event.safeParse(b).success).toBe(true);
    expect(JSON.stringify(byType)).not.toContain("account_id");
    expect((await st.call("GET", `/v1/events/${byType["review.opened"].id}`, { token: ep.token })).body).toEqual(
      byType["review.opened"],
    );

    // an execution review without a payment intent is not public: no event, no dead letter
    const h = webhooksHandlers(st.ingest.webhooks)["evt.compliance.review.opened"];
    const hidden = domainEvent(
      "evt.compliance.review.opened",
      review({ subject: { type: "execution", id: newId("ex") } }),
      { accountUuid: m.uuid },
    );
    await h?.(hidden);
    expect(await eventsOf(m)).toHaveLength(2);
    const bad = { ...hidden, id: uuidv7(), data: { object: { id: "case_nope" } } };
    await h?.(bad);
    const dl = await st.admin.db.selectFrom("dead_letters").selectAll().execute();
    expect(dl.some((d) => (d.payload as { id: string }).id === bad.id)).toBe(true);
    expect(dl.some((d) => (d.payload as { id: string }).id === hidden.id)).toBe(false);
  });

  it("turns a mode-less account.updated into one event per mode, delivered to that mode's endpoints, once", async () => {
    const m = st.merchant();
    const test = await endpoint(m, { enabled_events: ["account.updated"] });
    const live = await endpoint(m, { url: "https://shop.example.com/live" }, { livemode: true });
    const a = account({ id: m.account, kyb_status: "approved", live_enabled: true });
    const e = domainEvent("evt.identity.account.updated", a, {
      accountUuid: m.uuid,
      livemode: null,
      version: 4,
      previous: { kyb_status: "pending", live_enabled: false },
    });
    await st.publishEvent(e);
    const [d] = await waitFor(async () => (at(m.account).length ? at(m.account) : null));
    const body = JSON.parse(d?.body as string);
    expect(body).toMatchObject({
      type: "account.updated",
      livemode: false,
      data: {
        object: { id: m.account, object: "account", kyb_status: "approved", sequence: 4 },
        previous_attributes: { kyb_status: "pending", live_enabled: false },
      },
    });
    expect(Event.safeParse(body).success).toBe(true);
    const rows = await waitFor(async () => {
      const r = await eventsOf(m);
      return r.length === 2 ? r : null;
    });
    expect(rows.map((r) => r.livemode).sort()).toEqual([false, true]);
    expect(new Set(rows.map((r) => r.source_event_id))).toEqual(new Set([e.id]));
    const liveEv = rows.find((r) => r.livemode) as (typeof rows)[number];
    const liveDeliveries = await st.admin.db
      .selectFrom("deliveries")
      .select("endpoint_id")
      .where("event_id", "=", liveEv.id)
      .execute();
    expect(liveDeliveries.map((x) => x.endpoint_id)).toEqual([toUuid(live.id, "we")]);
    // each mode's events API shows its own copy only
    const testList = await st.call("GET", "/v1/events?type=account.updated", { token: test.token });
    const liveList = await st.call("GET", "/v1/events?type=account.updated", { token: live.token });
    expect(testList.body.data.map((x: { livemode: boolean }) => x.livemode)).toEqual([false]);
    expect(liveList.body.data.map((x: { livemode: boolean }) => x.livemode)).toEqual([true]);
    expect(testList.body.data[0].id).not.toBe(liveList.body.data[0].id);
    // a redelivered domain event (inbox bypassed) adds nothing
    await st.admin.db.deleteFrom("inbox").where("event_id", "=", e.id).execute();
    await webhooksHandlers(st.ingest.webhooks)["evt.identity.account.updated"]?.(e);
    expect(await eventsOf(m)).toHaveLength(2);
  });

  it("dead-letters an event without a mode for a type that has one, and an object whose mode disagrees (INV-8)", async () => {
    const m = st.merchant();
    await endpoint(m);
    const h = webhooksHandlers(st.ingest.webhooks);
    const noMode = domainEvent("evt.payments.refund.created", refund(), { accountUuid: m.uuid, livemode: null });
    await h["evt.payments.refund.created"]?.(noMode);
    const wrongMode = domainEvent("evt.payments.payment_intent.created", paymentIntent({ livemode: false }), {
      accountUuid: m.uuid,
      livemode: true,
    });
    await h["evt.payments.payment_intent.created"]?.(wrongMode);
    expect(await eventsOf(m)).toHaveLength(0);
    const dl = await st.admin.db.selectFrom("dead_letters").selectAll().execute();
    const ids = dl.map((d) => (d.payload as { id: string }).id);
    expect(ids).toEqual(expect.arrayContaining([noMode.id, wrongMode.id]));
  });
});

describe("secret rotation (POST /v1/webhook_endpoints/{id}/rotate_secret)", () => {
  it("signs with both secrets during the overlap, then with the new one only; idempotent and audited", async () => {
    const m = st.merchant();
    const ep = await endpoint(m);
    const t0 = Math.floor(Date.now() / 1000);
    const r1 = await st.call("POST", `/v1/webhook_endpoints/${ep.id}/rotate_secret`, {
      token: ep.token,
      body: {},
      headers: { "idempotency-key": "rot-1" },
    });
    expect(r1.status).toBe(200);
    expect(r1.body.secret).toMatch(/^whsec_[0-9A-Za-z]{48}$/);
    expect(r1.body.secret).not.toBe(ep.secret);
    expect(r1.body.previous_secret_expires_at).toBeGreaterThanOrEqual(t0 + 86_400 - 1);
    expect(r1.body.previous_secret_expires_at).toBeLessThanOrEqual(t0 + 86_400 + 5);
    // idempotent replay: same secret, response stored encrypted
    const replay = await st.call("POST", `/v1/webhook_endpoints/${ep.id}/rotate_secret`, {
      token: ep.token,
      body: {},
      headers: { "idempotency-key": "rot-1" },
    });
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(replay.body).toEqual(r1.body);
    const stored = await st.admin.db
      .selectFrom("idempotency_keys")
      .select("response_body_enc")
      .where("key", "=", "rot-1")
      .executeTakeFirstOrThrow();
    expect((stored.response_body_enc as Buffer).toString("latin1")).not.toContain(r1.body.secret);
    // reads show the overlap, never a secret
    const got = await st.call("GET", `/v1/webhook_endpoints/${ep.id}`, { token: ep.token });
    expect(got.body.previous_secret_expires_at).toBe(r1.body.previous_secret_expires_at);
    expect(got.body).not.toHaveProperty("secret");

    // during the overlap: two v1 signatures, the new one first
    await st.call("POST", `/v1/webhook_endpoints/${ep.id}/test`, { token: ep.token, body: {} });
    const [d1] = await waitFor(async () => (at(m.account).length >= 1 ? at(m.account) : null));
    expect(parseSignatureHeader(String(d1?.headers["nearpay-signature"]))?.v1).toHaveLength(2);
    expect(signedWith(d1 as Received, r1.body.secret)).toBe(true);
    expect(signedWith(d1 as Received, ep.secret)).toBe(true);

    // rotating again during the overlap replaces the previous secret; a 1 s overlap
    const r2 = await st.call("POST", `/v1/webhook_endpoints/${ep.id}/rotate_secret`, {
      token: ep.token,
      body: { expire_previous_in_seconds: 1 },
    });
    expect(r2.status).toBe(200);
    await st.call("POST", `/v1/webhook_endpoints/${ep.id}/test`, { token: ep.token, body: {} });
    const d2 = (await waitFor(async () => (at(m.account).length >= 2 ? at(m.account) : null)))[1] as Received;
    const h2 = parseSignatureHeader(String(d2.headers["nearpay-signature"]));
    if ((h2?.timestamp ?? 0) * 1000 < (r2.body.previous_secret_expires_at as number) * 1000) {
      expect(signedWith(d2, r1.body.secret)).toBe(true);
    }
    expect(signedWith(d2, r2.body.secret)).toBe(true);
    expect(signedWith(d2, ep.secret)).toBe(false); // the first secret never signs again

    // after the overlap: the new secret only
    await new Promise((r) => setTimeout(r, 1_100));
    expect(
      (await st.call("GET", `/v1/webhook_endpoints/${ep.id}`, { token: ep.token })).body.previous_secret_expires_at,
    ).toBeNull();
    await st.call("POST", `/v1/webhook_endpoints/${ep.id}/test`, { token: ep.token, body: {} });
    const d3 = (await waitFor(async () => (at(m.account).length >= 3 ? at(m.account) : null)))[2] as Received;
    expect(parseSignatureHeader(String(d3.headers["nearpay-signature"]))?.v1).toHaveLength(1);
    expect(signedWith(d3, r2.body.secret)).toBe(true);
    expect(signedWith(d3, r1.body.secret)).toBe(false);

    // the sweep erases the expired previous secret
    expect(await expireSecrets(st.ingest.webhooks)).toBeGreaterThanOrEqual(1);
    const row = await st.admin.db
      .selectFrom("webhook_endpoints")
      .selectAll()
      .where("id", "=", toUuid(ep.id, "we"))
      .executeTakeFirstOrThrow();
    expect(row.secondary_secret_enc).toBeNull();
    expect(row.secondary_expires_at).toBeNull();

    // 0 drops the previous secret at once
    const r3 = await st.call("POST", `/v1/webhook_endpoints/${ep.id}/rotate_secret`, {
      token: ep.token,
      body: { expire_previous_in_seconds: 0 },
    });
    expect(r3.body.previous_secret_expires_at).toBeNull();
    await st.call("POST", `/v1/webhook_endpoints/${ep.id}/test`, { token: ep.token, body: {} });
    const d4 = (await waitFor(async () => (at(m.account).length >= 4 ? at(m.account) : null)))[3] as Received;
    expect(parseSignatureHeader(String(d4.headers["nearpay-signature"]))?.v1).toHaveLength(1);
    expect(signedWith(d4, r3.body.secret)).toBe(true);
    expect(signedWith(d4, r2.body.secret)).toBe(false);

    const t = await st.admin.db
      .selectFrom("webhook_endpoint_transitions")
      .selectAll()
      .where("webhook_endpoint_id", "=", toUuid(ep.id, "we"))
      .orderBy("created_at")
      .execute();
    expect(t.map((x) => x.cause)).toEqual(["created", "secret_rotated", "secret_rotated", "secret_rotated"]);
    expect(t[1]).toMatchObject({ from_state: "enabled", to_state: "enabled" });
    expect(t[3]?.evidence).toEqual({ previous_secret_expires_at: null });
  });

  it("rotates disabled endpoints; 404 for deleted, other accounts and modes; validates the overlap; needs write", async () => {
    const m = st.merchant();
    const ep = await endpoint(m, { url: "https://shop.example.com/x" });
    await st.call("PATCH", `/v1/webhook_endpoints/${ep.id}`, { token: ep.token, body: { disabled: true } });
    const rot = (token: string, body: unknown = {}, id = ep.id) =>
      st.call("POST", `/v1/webhook_endpoints/${id}/rotate_secret`, { token, body });
    expect((await rot(ep.token)).status).toBe(200);
    expect((await rot(await st.token(st.merchant()))).status).toBe(404);
    expect((await rot(await st.token(m, { livemode: true }))).status).toBe(404);
    const tooLong = await rot(ep.token, { expire_previous_in_seconds: 86_401 });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.code).toBe("invalid_request");
    const readOnly = await st.token(m, { ptype: "restricted_key", scp: ["webhook_endpoints.read"] });
    expect((await rot(readOnly)).status).toBe(403);
    const viewer = await st.token(m, { ptype: "session", role: "viewer" });
    expect((await rot(viewer)).status).toBe(403);
    await st.call("DELETE", `/v1/webhook_endpoints/${ep.id}`, { token: ep.token });
    expect((await rot(ep.token)).status).toBe(404);
  });
});

describe("resend (POST /v1/events/{id}/resend)", () => {
  async function refundEvent(m: Merchant) {
    const e = domainEvent("evt.payments.refund.created", refund(), { accountUuid: m.uuid });
    await webhooksHandlers(st.ingest.webhooks)["evt.payments.refund.created"]?.(e);
    const row = await st.admin.db
      .selectFrom("events")
      .selectAll()
      .where("source_event_id", "=", e.id)
      .executeTakeFirstOrThrow();
    return fromUuid("evt", row.id);
  }

  const deliveriesOf = (eventId: string) =>
    st.admin.db
      .selectFrom("deliveries")
      .selectAll()
      .where("event_id", "=", toUuid(eventId, "evt"))
      .orderBy("endpoint_id")
      .orderBy("resend_no")
      .execute();

  it("creates one new delivery per subscribed enabled endpoint and delivers the same event again", async () => {
    const m = st.merchant();
    const a = await endpoint(m, {}, { path: `${m.account}-a` });
    const b = await endpoint(m, { enabled_events: ["refund.created"] }, { path: `${m.account}-b` });
    const c = await endpoint(m, { enabled_events: ["refund.created"] }, { path: `${m.account}-c` });
    await endpoint(m, { enabled_events: ["payment_intent.succeeded"] }, { path: `${m.account}-d` });
    const evt = await refundEvent(m);
    await waitFor(async () => (at(`${m.account}-a`).length && at(`${m.account}-b`).length ? true : null));
    await st.call("PATCH", `/v1/webhook_endpoints/${c.id}`, { token: c.token, body: { disabled: true } });

    const r = await st.call("POST", `/v1/events/${evt}/resend`, {
      token: a.token,
      body: {},
      headers: { "idempotency-key": "resend-1" },
    });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ object: "event_resend", event: evt });
    expect(r.body.deliveries.map((d: { webhook_endpoint: string }) => d.webhook_endpoint).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    for (const d of r.body.deliveries) {
      expect(WebhookDelivery.safeParse(d).success).toBe(true);
      expect(d).toMatchObject({ status: "pending", attempts: 0, event: evt, event_type: "refund.created" });
    }
    const again = await waitFor(async () => (at(`${m.account}-a`).length === 2 ? at(`${m.account}-a`) : null));
    expect(again[0]?.headers["nearpay-event-id"]).toBe(evt);
    expect(again[1]?.headers["nearpay-event-id"]).toBe(evt);
    expect(JSON.parse(again[1]?.body as string)).toEqual(JSON.parse(again[0]?.body as string));
    const rows = await deliveriesOf(evt);
    expect(rows.map((x) => x.resend_no).sort()).toEqual([0, 0, 0, 1, 1]); // a, b, c originals + a, b resends

    // idempotent replay: same response, nothing new
    const replay = await st.call("POST", `/v1/events/${evt}/resend`, {
      token: a.token,
      body: {},
      headers: { "idempotency-key": "resend-1" },
    });
    expect(replay.body).toEqual(r.body);
    expect(await deliveriesOf(evt)).toHaveLength(5);

    // the delivery log shows the resend as its own delivery
    const log = await st.call("GET", `/v1/webhook_endpoints/${a.id}/deliveries`, { token: a.token });
    expect(log.body.data.filter((d: { event: string }) => d.event === evt)).toHaveLength(2);
  });

  it("resends to one given endpoint regardless of subscriptions; refuses disabled (409) and foreign (404) endpoints", async () => {
    const m = st.merchant();
    const a = await endpoint(m, { enabled_events: ["refund.created"] }, { path: `${m.account}-a` });
    const d = await endpoint(m, { enabled_events: ["payment_intent.succeeded"] }, { path: `${m.account}-d` });
    const evt = await refundEvent(m);
    const one = await st.call("POST", `/v1/events/${evt}/resend`, { token: a.token, body: { endpoint: d.id } });
    expect(one.status).toBe(202);
    expect(one.body.deliveries.map((x: { webhook_endpoint: string }) => x.webhook_endpoint)).toEqual([d.id]);
    const got = await waitFor(async () => (at(`${m.account}-d`).length ? at(`${m.account}-d`) : null));
    expect(got[0]?.headers["nearpay-event-type"]).toBe("refund.created");
    expect((await deliveriesOf(evt)).find((x) => x.endpoint_id === toUuid(d.id, "we"))?.resend_no).toBe(1);

    await st.call("PATCH", `/v1/webhook_endpoints/${d.id}`, { token: d.token, body: { disabled: true } });
    const off = await st.call("POST", `/v1/events/${evt}/resend`, { token: a.token, body: { endpoint: d.id } });
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe("state_conflict");
    const other = await endpoint(st.merchant(), {}, { path: "other" });
    const foreign = await st.call("POST", `/v1/events/${evt}/resend`, { token: a.token, body: { endpoint: other.id } });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error).toMatchObject({ code: "resource_missing", param: "endpoint" });
    // the event is invisible to other accounts and the other mode
    expect((await st.call("POST", `/v1/events/${evt}/resend`, { token: other.token, body: {} })).status).toBe(404);
    expect(
      (await st.call("POST", `/v1/events/${evt}/resend`, { token: await st.token(m, { livemode: true }), body: {} }))
        .status,
    ).toBe(404);
    // events past the 30-day window are 404
    await st.admin.db
      .updateTable("events")
      .set({ created_at: new Date(Date.now() - 31 * 86_400_000) })
      .where("id", "=", toUuid(evt, "evt"))
      .execute();
    expect((await st.call("POST", `/v1/events/${evt}/resend`, { token: a.token, body: {} })).status).toBe(404);
    const readOnly = await st.token(m, { ptype: "restricted_key", scp: ["events.read"] });
    expect((await st.call("POST", `/v1/events/${evt}/resend`, { token: readOnly, body: {} })).status).toBe(403);
  });

  it("serialises concurrent resends: every (event, endpoint, resend_no) is created once", async () => {
    const m = st.merchant();
    const a = await endpoint(m, { url: "https://shop.example.com/a", enabled_events: ["refund.created"] });
    const evt = await refundEvent(m);
    const rs = await Promise.all(
      Array.from({ length: 6 }, () => st.call("POST", `/v1/events/${evt}/resend`, { token: a.token, body: {} })),
    );
    expect(rs.map((r) => r.status)).toEqual(Array(6).fill(202));
    const rows = await deliveriesOf(evt);
    expect(rows.map((x) => x.resend_no)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(new Set(rows.map((x) => x.id)).size).toBe(7);
  });

  it("resends a ping to the endpoint it tested only", async () => {
    const m = st.merchant();
    const a = await endpoint(m, {}, { path: `${m.account}-a` });
    await endpoint(m, {}, { path: `${m.account}-b` });
    const ping = await st.call("POST", `/v1/webhook_endpoints/${a.id}/test`, { token: a.token, body: {} });
    const r = await st.call("POST", `/v1/events/${ping.body.id}/resend`, { token: a.token, body: {} });
    expect(r.status).toBe(202);
    expect(r.body.deliveries.map((x: { webhook_endpoint: string }) => x.webhook_endpoint)).toEqual([a.id]);
    await waitFor(async () => (at(`${m.account}-a`).length === 2 ? true : null));
    expect(at(`${m.account}-b`)).toHaveLength(0);
  });
});
