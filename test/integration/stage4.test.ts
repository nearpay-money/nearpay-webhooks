/**
 * Stage 4 end to end. Mandate ingest (lld/webhooks.md §4, billing §14 d10): the 8 `evt.billing.mandate.*`
 * subjects become `mandate.*` events carrying the public `Mandate`, delivered (signed) to subscribed
 * endpoints in their mode, listed by `GET /v1/events` and tailed by the events stream byte-for-byte; a
 * mandate in the other mode than its envelope is dead-lettered (nested-livemode guard, INV-8).
 */
import { setTimeout as sleep } from "node:timers/promises";
import { domainEvent } from "@nearpay-internal/testing";
import { Event, Mandate } from "@nearpay-money/spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mandate } from "../support/fixtures.js";
import { type Frame, openSse } from "../support/sse.js";
import { type Stack, startStack, waitFor } from "../support/stack.js";

let st: Stack;

beforeAll(async () => {
  st = await startStack({ valkey: true, stream: { pollMs: 200, refreshMs: 300 } });
});
afterAll(async () => {
  await st?.stop();
});

const MANDATE = [
  "activated",
  "collected",
  "insufficient_funds",
  "canceled",
  "exhausted",
  "updated",
  "unlinked",
  "released",
] as const;
const isEvent = (f: Frame) => f.event === "event";

describe("mandate ingest", () => {
  it("delivers every mandate.* event with the Mandate to subscribed endpoints, in its mode, and lists it", async () => {
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
    await mk(`${m.account}-released`, ["mandate.released", "mandate.unlinked"]);
    await mk(`${m.account}-live`, ["*"], true);

    const md = mandate({ livemode: false });
    let v = 1;
    for (const e of MANDATE)
      await st.publishEvent(
        domainEvent(
          `evt.billing.mandate.${e}` as "evt.billing.mandate.activated",
          { ...md, sequence: v },
          {
            accountUuid: m.uuid,
            version: v++,
            livemode: false,
            ...(e === "updated" ? { previous: { balance: "75000000" } } : {}),
          },
        ),
      );

    const at = (p: string) => st.receiver.received.filter((r) => r.path === `/hooks/${m.account}-${p}`);
    const all = await waitFor(async () => (at("all").length === MANDATE.length ? at("all") : null));
    expect(all.map((d) => JSON.parse(d.body).type).sort()).toEqual(MANDATE.map((e) => `mandate.${e}`).sort());
    for (const d of all) {
      const body = JSON.parse(d.body);
      expect(Event.safeParse(body).success, body.type).toBe(true);
      expect(Mandate.safeParse(body.data.object).success, body.type).toBe(true);
      expect(body.data.object).toMatchObject({ id: md.id, object: "mandate", livemode: false, payer: "dana.near" });
      expect(body.livemode).toBe(false);
      expect(d.headers["nearpay-signature"]).toMatch(/v1=.*v1a=/);
      if (body.type === "mandate.updated") expect(body.data.previous_attributes).toEqual({ balance: "75000000" });
    }
    const released = await waitFor(async () => (at("released").length === 2 ? at("released") : null));
    expect(released.map((d) => JSON.parse(d.body).type).sort()).toEqual(["mandate.released", "mandate.unlinked"]);
    await sleep(500);
    expect(at("live")).toHaveLength(0); // sandbox-vault mandates never reach live endpoints (INV-8)

    const list = await st.call("GET", "/v1/events?type=mandate.activated", { token });
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].data.object).toMatchObject({ id: md.id, sequence: 1 });
  });

  it("dead-letters a mandate whose own livemode disagrees with its envelope and creates no event", async () => {
    const m = st.merchant();
    const env = domainEvent("evt.billing.mandate.activated", mandate({ livemode: true }), {
      accountUuid: m.uuid,
      version: 1,
      livemode: false,
    });
    await st.publishEvent(env);
    await waitFor(async () => {
      const dl = await st.admin.db.selectFrom("dead_letters").selectAll().execute();
      return dl.some((d) => (d.payload as { id: string }).id === env.id);
    });
    const rows = await st.admin.db.selectFrom("events").select("id").where("account_id", "=", m.uuid).execute();
    expect(rows).toHaveLength(0);
  });
});

describe("events stream", () => {
  it("tails mandate events per type filter, byte-for-byte like GET /v1/events/{id}", async () => {
    const m = st.merchant();
    const token = await st.token(m);
    const all = await openSse(`${st.url}/v1/events/stream`, token);
    const collected = await openSse(`${st.url}/v1/events/stream?types=mandate.collected`, token);
    await Promise.all([all, collected].map((s) => s.waitFor((f) => f.event === "ready")));

    const md = mandate({ livemode: false, sequence: 1 });
    await st.publishEvent(
      domainEvent("evt.billing.mandate.activated", md, { accountUuid: m.uuid, version: 1, livemode: false }),
    );
    await st.publishEvent(
      domainEvent(
        "evt.billing.mandate.collected",
        { ...md, collected_periods: 2, balance: "25000000", funded_periods: 1, sequence: 2 },
        { accountUuid: m.uuid, version: 2, livemode: false },
      ),
    );

    const got = await all.waitFor(isEvent, 2);
    expect(got.map((f) => f.data.type)).toEqual(["mandate.activated", "mandate.collected"]);
    for (const f of got) {
      expect(Event.safeParse(f.data).success, f.data.type).toBe(true);
      const res = await fetch(`${st.url}/v1/events/${f.id}`, { headers: { "x-nearpay-token": token } });
      expect(f.raw).toBe(await res.text());
    }
    const [only] = await collected.waitFor(isEvent);
    expect(only?.data.data.object).toMatchObject({ id: md.id, collected_periods: 2, balance: "25000000" });
    await sleep(1_500);
    expect(collected.frames.filter(isEvent)).toHaveLength(1);
    for (const s of [all, collected]) s.close();
  });
});
