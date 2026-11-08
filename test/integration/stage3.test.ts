/**
 * Stage 3 end to end. Billing ingest (lld/webhooks.md §4): the 12 billing subjects become `invoice.*` /
 * `customer.subscription.*` events delivered (signed) to subscribed endpoints; an invoice carrying its hosted
 * URL is dead-lettered. Events stream (lld/webhooks.md §5.1, spec 0.3.0 `streamEvents`) through the real api and
 * ingest: auth and mode (API keys test only, sessions follow their mode), frames, billing events from NATS
 * byte-for-byte like `GET /v1/events/{id}`, type filter, replay with `Last-Event-ID` / `starting_after`,
 * `reset`, the settle-window ordering of out-of-order commits, and the limits (5 per account and mode
 * across replicas via Valkey, 1 h → shortened, slow readers, shutdown).
 */
import { setTimeout as sleep } from "node:timers/promises";
import { API_VERSION, EVENT_STREAM_RETRY_MS, Event, EventStreamReady, EventStreamReset } from "@nearpay/spec";
import { createDb, type Kysely } from "@nearpay-internal/db";
import { fromUuid, newId, uuidv7 } from "@nearpay-internal/ids";
import type { Service } from "@nearpay-internal/service";
import { domainEvent, testKeySource } from "@nearpay-internal/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { notifyEvents } from "../../src/app/events.js";
import { createApi } from "../../src/app/services.js";
import type { StreamSettings } from "../../src/app/stream.js";
import type { DB } from "../../src/infra/db/schema.js";
import { invoice, subscription } from "../support/fixtures.js";
import { type Frame, openSse, stalledClient } from "../support/sse.js";
import { type Merchant, type Stack, startStack, waitFor } from "../support/stack.js";

let st: Stack;

beforeAll(async () => {
  st = await startStack({ valkey: true, stream: { pollMs: 200, refreshMs: 300 } });
});
afterAll(async () => {
  await st?.stop();
});

const PATH = "/v1/events/stream";
const isEvent = (f: Frame) => f.event === "event";

async function open(
  m: Merchant,
  o: {
    query?: string;
    headers?: Record<string, string>;
    livemode?: boolean;
    ptype?: "secret_key" | "restricted_key" | "session";
    scp?: string[];
    base?: string;
  } = {},
) {
  const token = await st.token(m, {
    livemode: o.livemode ?? false,
    ptype: o.ptype ?? "secret_key",
    ...(o.scp ? { scp: o.scp } : {}),
    ...(o.ptype === "session" ? { role: "developer" as const } : {}),
  });
  return openSse(`${o.base ?? st.url}${PATH}${o.query ?? ""}`, token, o.headers);
}

/** Inserts a public event the way ingest stores it (direct SQL: replay and ordering tests). */
async function insertEvent(
  db: Kysely<DB>,
  m: Merchant,
  o: { type?: string; livemode?: boolean; data?: Record<string, unknown>; createdAt?: Date; id?: string } = {},
): Promise<string> {
  const livemode = o.livemode ?? false;
  const type = o.type ?? "invoice.paid";
  const data =
    o.data ??
    ((type.startsWith("customer.") ? subscription({ livemode }) : invoice({ livemode })) as unknown as Record<
      string,
      unknown
    >);
  const id = o.id ?? uuidv7();
  await db
    .insertInto("events")
    .values({
      id,
      account_id: m.uuid,
      livemode,
      type,
      source_event_id: uuidv7(),
      object_type: type.split(".")[0] as string,
      object_id: String(data.id ?? "x"),
      object_sequence: 1,
      data: JSON.stringify(data),
      previous: null,
      request: null,
      created_at: o.createdAt ?? new Date(),
    })
    .execute();
  return id;
}

const evtIds = (frames: Frame[]) => frames.filter(isEvent).map((f) => f.id);

describe("billing ingest", () => {
  const INVOICE = [
    "created",
    "finalized",
    "sent",
    "paid",
    "payment_failed",
    "overdue",
    "voided",
    "marked_uncollectible",
  ];
  const SUBSCRIPTION = ["created", "updated", "deleted", "renewal_upcoming"];

  it("delivers every invoice.* and customer.subscription.* event to subscribed endpoints, in its mode", async () => {
    const m = st.merchant();
    const token = await st.token(m);
    const mk = async (path: string, enabled: string[], livemode = false) => {
      const t = livemode ? await st.token(m, { livemode: true }) : token;
      const r = await st.call("POST", "/v1/webhook_endpoints", {
        token: t,
        body: { url: `${st.receiver.url}/hooks/${path}`, enabled_events: enabled },
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    };
    await mk(`${m.account}-all`, ["*"]);
    await mk(
      `${m.account}-subs`,
      SUBSCRIPTION.map((e) => `customer.subscription.${e}`),
    );
    await mk(`${m.account}-live`, ["*"], true);
    const inv = invoice();
    let v = 1;
    for (const e of INVOICE)
      await st.publishEvent(
        domainEvent(
          `evt.billing.invoice.${e}` as "evt.billing.invoice.created",
          { ...inv, sequence: v },
          {
            accountUuid: m.uuid,
            version: v++,
            livemode: false,
          },
        ),
      );
    const sub = subscription();
    for (const e of SUBSCRIPTION)
      await st.publishEvent(
        domainEvent(
          `evt.billing.subscription.${e}` as "evt.billing.subscription.created",
          { ...sub, sequence: v },
          {
            accountUuid: m.uuid,
            version: v++,
            livemode: false,
          },
        ),
      );
    const at = (p: string) => st.receiver.received.filter((r) => r.path === `/hooks/${m.account}-${p}`);
    const all = await waitFor(async () => (at("all").length === 12 ? at("all") : null));
    const types = all.map((d) => JSON.parse(d.body).type).sort();
    expect(types).toEqual(
      [...INVOICE.map((e) => `invoice.${e}`), ...SUBSCRIPTION.map((e) => `customer.subscription.${e}`)].sort(),
    );
    for (const d of all) {
      const body = JSON.parse(d.body);
      expect(Event.safeParse(body).success, body.type).toBe(true);
      expect(d.headers["nearpay-signature"]).toMatch(/v1=.*v1a=/);
      if (body.type.startsWith("invoice.")) expect(body.data.object.hosted_invoice_url).toBeNull();
    }
    const subs = await waitFor(async () => (at("subs").length === 4 ? at("subs") : null));
    expect(subs.every((d) => JSON.parse(d.body).type.startsWith("customer.subscription."))).toBe(true);
    await sleep(500);
    expect(at("live")).toHaveLength(0); // test-mode events never reach live endpoints (INV-8)
    const list = await st.call("GET", "/v1/events?type=invoice.paid", { token });
    expect(list.body.data).toHaveLength(1);
  });

  it("dead-letters an invoice that carries its hosted URL (the invoice secret) and creates no event", async () => {
    const m = st.merchant();
    // the kit factory refuses a non-null URL (InvoiceEvent), so the envelope is altered after building it
    const env = domainEvent("evt.billing.invoice.finalized", invoice(), {
      accountUuid: m.uuid,
      version: 1,
      livemode: false,
    });
    (env.data.object as Record<string, unknown>).hosted_invoice_url = "https://pay.nearpay.money/i/in_x#secret";
    await st.publishEvent(env);
    await waitFor(async () => {
      const dl = await st.admin.db.selectFrom("dead_letters").selectAll().execute();
      return dl.some((d) => (d.payload as { id: string }).id === env.id);
    });
    const rows = await st.admin.db.selectFrom("events").select("id").where("account_id", "=", m.uuid).execute();
    expect(rows).toHaveLength(0);
  });
});

describe("auth, mode and frames", () => {
  it("opens a test-mode stream for an API key: retry, ready, heartbeat-ready SSE headers", async () => {
    const m = st.merchant();
    const s = await open(m);
    expect(s.status).toBe(200);
    expect(s.headers.get("content-type")).toMatch(/^text\/event-stream/);
    const [ready] = await s.waitFor((f) => f.event === "ready");
    expect(s.retry).toBe(EVENT_STREAM_RETRY_MS);
    expect(EventStreamReady.parse(ready?.data)).toMatchObject({
      object: "event_stream",
      livemode: false,
      account: m.account,
      types: ["*"],
      resumed_after: null,
    });
    const exp = Number(ready?.data.expires_at);
    expect(Math.abs(exp - (Math.floor(Date.now() / 1000) + 3600))).toBeLessThanOrEqual(5);
    s.close();
  });

  it("refuses live API keys (403 livemode_forbidden); a live dashboard session streams live mode", async () => {
    const m = st.merchant();
    for (const ptype of ["secret_key", "restricted_key"] as const) {
      const s = await open(m, { livemode: true, ptype, scp: ["events.read"] });
      expect(s.status, ptype).toBe(403);
      expect(s.body.error.code).toBe("livemode_forbidden");
    }
    const r = await open(m, { ptype: "restricted_key", scp: ["events.read"] });
    expect(r.status).toBe(200);
    r.close();
    const noScope = await open(m, { ptype: "restricted_key", scp: ["webhook_endpoints.read"] });
    expect(noScope.status).toBe(403);
    const live = await open(m, { livemode: true, ptype: "session" });
    expect(live.status).toBe(200);
    const [ready] = await live.waitFor((f) => f.event === "ready");
    expect(ready?.data.livemode).toBe(true);
    live.close();
    const anon = await openSse(`${st.url}${PATH}`, null);
    expect(anon.status).toBe(401);
  });

  it("validates types and cursors before opening", async () => {
    const m = st.merchant();
    const bad = await open(m, { query: "?types=invoice.paid,Invoice.sent" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatchObject({ code: "event_type_unknown", param: "types[1]" });
    const reminder = await open(m, { query: "?types=invoice.reminder" });
    expect(reminder.body.error).toMatchObject({ code: "event_type_unknown", param: "types[0]" });
    const header = await open(m, { headers: { "last-event-id": "evt_nope" } });
    expect(header.status).toBe(400);
    expect(header.body.error.code).toBe("invalid_request");
    const query = await open(m, { query: "?starting_after=we_123" });
    expect(query.status).toBe(400);
    expect(query.body.error.code).toBe("invalid_request");
  });
});

describe("live tail", () => {
  it("streams billing events and pings byte-for-byte like GET /v1/events/{id}, per type filter and mode", async () => {
    const m = st.merchant();
    const other = st.merchant();
    const all = await open(m);
    const paidOnly = await open(m, { query: "?types=invoice.paid" });
    const live = await open(m, { livemode: true, ptype: "session" });
    const otherStream = await open(other);
    await Promise.all([all, paidOnly, live, otherStream].map((s) => s.waitFor((f) => f.event === "ready")));

    const inv = invoice({ sequence: 1 });
    await st.publishEvent(
      domainEvent("evt.billing.invoice.finalized", inv, { accountUuid: m.uuid, version: 1, livemode: false }),
    );
    await st.publishEvent(
      domainEvent(
        "evt.billing.invoice.paid",
        { ...inv, status: "paid", sequence: 2 },
        { accountUuid: m.uuid, version: 2, livemode: false, previous: { status: "open" } },
      ),
    );
    await st.publishEvent(
      domainEvent("evt.billing.subscription.created", subscription({ livemode: true }), {
        accountUuid: m.uuid,
        version: 1,
        livemode: true,
      }),
    );
    // a ping from the endpoint test shows up too (nearpay listen)
    const token = await st.token(m);
    const ep = await st.call("POST", "/v1/webhook_endpoints", {
      token,
      body: { url: `${st.receiver.url}/hooks/${m.account}`, enabled_events: ["invoice.paid"] },
    });
    expect(ep.status).toBe(201);
    const ping = await st.call("POST", `/v1/webhook_endpoints/${ep.body.id}/test`, { token });
    expect(ping.status).toBe(202);

    const got = await all.waitFor(isEvent, 3);
    expect(got.map((f) => f.data.type).sort()).toEqual(["invoice.finalized", "invoice.paid", "ping"]);
    for (const f of got) {
      expect(f.id).toBe(f.data.id);
      expect(Event.safeParse(f.data).success, f.data.type).toBe(true);
      expect(f.data.api_version).toBe(API_VERSION);
      const res = await fetch(`${st.url}/v1/events/${f.id}`, { headers: { "x-nearpay-token": token } });
      expect(f.raw).toBe(await res.text());
    }
    expect(evtIds(got)).toEqual([...evtIds(got)].sort()); // id order
    const paid = got.find((f) => f.data.type === "invoice.paid");
    expect(paid?.data.data.object).toMatchObject({ id: inv.id, status: "paid", sequence: 2, hosted_invoice_url: null });
    expect(paid?.data.data.previous_attributes).toEqual({ status: "open" });

    const [onlyPaid] = await paidOnly.waitFor(isEvent);
    expect(onlyPaid?.data.type).toBe("invoice.paid");
    const [sub] = await live.waitFor(isEvent);
    expect(sub?.data).toMatchObject({ type: "customer.subscription.created", livemode: true });
    await sleep(2_500);
    expect(paidOnly.frames.filter(isEvent)).toHaveLength(1);
    expect(live.frames.filter(isEvent)).toHaveLength(1);
    expect(all.frames.filter(isEvent)).toHaveLength(3);
    expect(otherStream.frames.filter(isEvent)).toHaveLength(0);
    for (const s of [all, paidOnly, live, otherStream]) s.close();
  });

  it("delivers an event within the settle window plus a NOTIFY wake when polling is slow", async () => {
    const api = createApi(st.apiConfig, {
      keys: testKeySource(),
      database: createDb<DB>({ url: st.appDbUrl }),
      streamSettings: { pollMs: 60_000 },
    });
    const { port } = await api.service.start();
    try {
      const m = st.merchant();
      const s = await open(m, { base: `http://127.0.0.1:${port}` });
      await s.waitFor((f) => f.event === "ready");
      const t0 = Date.now();
      await st.publishEvent(
        domainEvent("evt.billing.invoice.created", invoice({ status: "draft", number: null }), {
          accountUuid: m.uuid,
          version: 1,
          livemode: false,
        }),
      );
      await s.waitFor(isEvent, 1, 10_000);
      expect(Date.now() - t0).toBeLessThan(8_000); // not the 60 s poll
      s.close();
    } finally {
      await api.service.stop();
    }
  });
});

describe("resume", () => {
  it("replays every later event in id order (pages of 100) after Last-Event-ID, then continues live", async () => {
    const m = st.merchant();
    const ids: string[] = [];
    for (let i = 0; i < 250; i++)
      ids.push(await insertEvent(st.admin.db, m, { type: i % 2 ? "invoice.paid" : "customer.subscription.updated" }));
    await insertEvent(st.admin.db, m, { livemode: true }); // other mode: never replayed
    await sleep(2_100); // past the settle window
    const cursor = fromUuid("evt", ids[9] as string);
    const s = await open(m, { headers: { "last-event-id": cursor } });
    const [ready] = await s.waitFor((f) => f.event === "ready");
    expect(ready?.data.resumed_after).toBe(cursor);
    const got = await s.waitFor(isEvent, 240, 30_000);
    expect(evtIds(got)).toEqual(ids.slice(10).map((u) => fromUuid("evt", u)));
    const fresh = await insertEvent(st.admin.db, m);
    const after = await s.waitFor(isEvent, 241, 10_000);
    expect(after.at(-1)?.id).toBe(fromUuid("evt", fresh));
    s.close();

    // the header wins over starting_after; the type filter applies to the replay
    const both = await open(m, {
      query: `?types=invoice.paid&starting_after=${fromUuid("evt", ids[200] as string)}`,
      headers: { "last-event-id": fromUuid("evt", ids[99] as string) },
    });
    const [r2] = await both.waitFor((f) => f.event === "ready");
    expect(r2?.data).toMatchObject({ resumed_after: fromUuid("evt", ids[99] as string), types: ["invoice.paid"] });
    const want = ids
      .slice(100)
      .filter((_, i) => (i + 100) % 2 === 1)
      .map((u) => fromUuid("evt", u));
    const paid = await both.waitFor(isEvent, want.length + 1, 30_000); // + the live one
    expect(evtIds(paid)).toEqual([...want, fromUuid("evt", fresh)]);
    both.close();

    const q = await open(m, { query: `?starting_after=${fromUuid("evt", ids[247] as string)}` });
    const tail = await q.waitFor(isEvent, 3);
    expect(evtIds(tail)).toEqual([ids[248], ids[249], fresh].map((u) => fromUuid("evt", u as string)));
    q.close();
  });

  it("sends reset (cursor_unknown / cursor_expired) and continues live only", async () => {
    const m = st.merchant();
    const other = st.merchant();
    const foreign = await insertEvent(st.admin.db, other);
    const liveMode = await insertEvent(st.admin.db, m, { livemode: true });
    const old = await insertEvent(st.admin.db, m, { createdAt: new Date(Date.now() - 31 * 86_400_000) });
    const before = await insertEvent(st.admin.db, m);
    await sleep(2_100);
    const cases = [
      [foreign, "cursor_unknown"],
      [liveMode, "cursor_unknown"],
      [old, "cursor_expired"],
      [uuidv7(), "cursor_unknown"],
    ] as const;
    const streams = [];
    for (const [cursor, reason] of cases) {
      const evt = fromUuid("evt", cursor);
      const s = await open(m, { headers: { "last-event-id": evt } });
      const [ready, reset] = await s.waitFor((f) => f.event === "ready" || f.event === "reset", 2);
      expect(ready?.event).toBe("ready");
      expect(ready?.data.resumed_after).toBeNull();
      expect(EventStreamReset.parse(reset?.data)).toEqual({ object: "event_stream_reset", reason, cursor: evt });
      streams.push(s);
    }
    const fresh = await insertEvent(st.admin.db, m);
    for (const s of streams) {
      const got = await s.waitFor(isEvent, 1, 10_000);
      expect(evtIds(got)).toEqual([fromUuid("evt", fresh)]); // `before` is not replayed
      s.close();
    }
    expect(before).toBeTruthy();
  });
});

describe("settle window", () => {
  it("keeps id order when a lower id commits after a higher one inside the settle window", async () => {
    const m = st.merchant();
    const s = await open(m);
    await s.waitFor((f) => f.event === "ready");
    const a = uuidv7();
    await sleep(5);
    const b = uuidv7();
    const slow = st.admin.db.transaction().execute(async (tx) => {
      await insertEvent(tx, m, { id: a });
      await notifyEvents(tx, m.uuid, false);
      await sleep(1_000);
    });
    await sleep(100);
    await insertEvent(st.admin.db, m, { id: b }); // committed first, higher id
    await slow;
    const got = await s.waitFor(isEvent, 2, 10_000);
    expect(evtIds(got)).toEqual([fromUuid("evt", a), fromUuid("evt", b)]);
    s.close();
  });

  it("still delivers, once, a lower id committed after the settle window (the 10 s re-read)", async () => {
    const m = st.merchant();
    const s = await open(m);
    await s.waitFor((f) => f.event === "ready");
    const a = uuidv7();
    await sleep(5);
    const b = uuidv7();
    const slow = st.admin.db.transaction().execute(async (tx) => {
      await insertEvent(tx, m, { id: a });
      await sleep(4_000);
    });
    await sleep(100);
    await insertEvent(st.admin.db, m, { id: b });
    await s.waitFor(isEvent, 1, 10_000);
    expect(evtIds(s.frames)).toEqual([fromUuid("evt", b)]);
    await slow;
    await s.waitFor(isEvent, 2, 10_000);
    await sleep(3_000); // several more polls: no duplicate
    expect(evtIds(s.frames)).toEqual([fromUuid("evt", b), fromUuid("evt", a)]);
    s.close();
  });
});

describe("limits", () => {
  async function replica(settings: Partial<StreamSettings> = {}): Promise<{ service: Service; base: string }> {
    const api = createApi(st.apiConfig, {
      keys: testKeySource(),
      database: createDb<DB>({ url: st.appDbUrl }),
      streamSettings: { pollMs: 200, refreshMs: 300, ...settings },
    });
    const { port } = await api.service.start();
    return { service: api.service, base: `http://127.0.0.1:${port}` };
  }

  it("allows 5 streams per account and mode across replicas (Valkey), then 429 with Retry-After", async () => {
    const m = st.merchant();
    const r2 = await replica();
    try {
      const streams = [];
      for (let i = 0; i < 3; i++) streams.push(await open(m));
      for (let i = 0; i < 2; i++) streams.push(await open(m, { base: r2.base }));
      for (const s of streams) expect(s.status).toBe(200);
      for (const base of [st.url, r2.base]) {
        const sixth = await open(m, { base });
        expect(sixth.status).toBe(429);
        expect(sixth.body.error.code).toBe("rate_limited");
        expect(sixth.headers.get("retry-after")).toBe("5");
      }
      const live = await open(m, { livemode: true, ptype: "session" }); // the other mode has its own 5
      expect(live.status).toBe(200);
      live.close();
      streams[0]?.close();
      const again = await waitFor(async () => {
        const s = await open(m, { base: r2.base });
        return s.status === 200 ? s : null;
      });
      again.close();
      for (const s of streams) s.close();
      expect(st.api.streams.slots.shared()).toBe(true);
    } finally {
      await r2.service.stop();
    }
  });

  it("ends a stream at its maximum duration and on shutdown, freeing the slot", async () => {
    const r = await replica({ maxDurationMs: 1_500 });
    const m = st.merchant();
    const s = await open(m, { base: r.base });
    const [ready] = await s.waitFor((f) => f.event === "ready");
    expect(ready?.data.expires_at).toBeLessThanOrEqual(Math.ceil(Date.now() / 1000) + 2);
    await s.ended;
    await waitFor(async () =>
      /event_stream_closed_total\{reason="max_duration"\} 1/.test(await r.service.metrics.render()),
    );
    const t = await open(m, { base: r.base });
    await t.waitFor((f) => f.event === "ready");
    expect(await r.service.metrics.render()).toMatch(/event_streams\{mode="test"\} 1/);
    await r.service.stop();
    await t.ended;
    await waitFor(async () =>
      /event_stream_closed_total\{reason="shutdown"\} 1/.test(await r.service.metrics.render()),
    );
  });

  it("closes a client that stops reading once more than the buffer limit stays unsent", async () => {
    const r = await replica({ maxBufferedBytes: 64 * 1024, slowClientMs: 0 });
    try {
      const m = st.merchant();
      const first = await insertEvent(st.admin.db, m);
      const base = invoice();
      const line = base.lines[0];
      const big = invoice({
        lines: Array.from({ length: 100 }, () => ({ ...line, id: newId("il") })) as typeof base.lines,
      }) as unknown as Record<string, unknown>;
      // ~800 × 40 KB: far more than the kernel socket buffers of a client that does not read
      for (let batch = 0; batch < 8; batch++) {
        const rows = Array.from({ length: 100 }, () => ({
          id: uuidv7(),
          account_id: m.uuid,
          livemode: false,
          type: "invoice.paid",
          source_event_id: uuidv7(),
          object_type: "invoice",
          object_id: String(big.id),
          object_sequence: 1,
          data: JSON.stringify(big),
          previous: null,
          request: null,
          created_at: new Date(),
        }));
        await st.admin.db.insertInto("events").values(rows).execute();
      }
      await sleep(2_100);
      const port = Number(new URL(r.base).port);
      const token = await st.token(m);
      const client = stalledClient(port, `${PATH}?starting_after=${fromUuid("evt", first)}`, token);
      await waitFor(
        async () => /event_stream_closed_total\{reason="slow_client"\} 1/.test(await r.service.metrics.render()),
        45_000,
      );
      expect(await r.service.metrics.render()).toMatch(/event_streams\{mode="test"\} 0/);
      client.close();
    } finally {
      await r.service.stop();
    }
  });
});
