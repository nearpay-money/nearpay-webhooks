/** Subscriptions, the domain → public mapping and version rendering (lld/webhooks.md §4, §11). */
import { API_VERSION, Event, SUBJECT_TO_WEBHOOK_TYPE, WEBHOOK_TYPE_NAMES, WEBHOOK_TYPES } from "@nearpay/spec";
import { fromUuid, uuidv7 } from "@nearpay-internal/ids";
import { SUBJECTS, type Subject } from "@nearpay-internal/spec";
import { agentPayment, checkoutSession, paymentIntent } from "@nearpay-internal/testing";
import { describe, expect, it } from "vitest";
import { objectSequence } from "../../src/app/events.js";
import { normalizeEnabledEvents, SUBSCRIBABLE, subscribes } from "../../src/domain/endpoint/events.js";
import { canonicalEvent, pingObject, publicType, renderFor, type StoredEvent } from "../../src/domain/event/render.js";

describe("subscriptions", () => {
  it("normalises enabled_events", () => {
    expect(normalizeEnabledEvents(["payment_intent.succeeded", "*"])).toEqual({ ok: ["*"] });
    expect(
      normalizeEnabledEvents(["payment_intent.succeeded", "payment_intent.succeeded", "agent_payment.failed"]),
    ).toEqual({
      ok: ["payment_intent.succeeded", "agent_payment.failed"],
    });
    expect(normalizeEnabledEvents(["payment_intent.done"])).toEqual({ unknown: "payment_intent.done", index: 0 });
    expect(SUBSCRIBABLE).not.toContain("ping");
    expect(SUBSCRIBABLE.length).toBe(WEBHOOK_TYPE_NAMES.length - 1);
  });

  it("reports the first unknown type with its index, even next to `*` (spec 0.1.5 lets any string through)", () => {
    expect(normalizeEnabledEvents(["payment_intent.succeeded", "nope", "also.nope"])).toEqual({
      unknown: "nope",
      index: 1,
    });
    expect(normalizeEnabledEvents(["*", "payment_intent.done"])).toEqual({ unknown: "payment_intent.done", index: 1 });
    expect(normalizeEnabledEvents(["PAYMENT_INTENT.SUCCEEDED"])).toEqual({
      unknown: "PAYMENT_INTENT.SUCCEEDED",
      index: 0,
    });
    expect(normalizeEnabledEvents(["*", "*"])).toEqual({ ok: ["*"] });
  });

  it("matches types", () => {
    expect(subscribes(["*"], "agent_payment.settled")).toBe(true);
    expect(subscribes(["payment_intent.succeeded"], "payment_intent.succeeded")).toBe(true);
    expect(subscribes(["payment_intent.succeeded"], "payment_intent.created")).toBe(false);
  });
});

describe("domain → public mapping", () => {
  it("maps every subject the catalogue routes to webhooks, and nothing internal", () => {
    const routed = (Object.keys(SUBJECTS) as Subject[]).filter((s) =>
      (SUBJECTS[s].consumers as readonly string[]).includes("webhooks"),
    );
    // Stage 1: 11 payments/agentpay subjects; Stage 2: 6 refunds, account.updated, review.{opened,closed}
    expect(routed.length).toBe(20);
    expect(publicType("evt.payments.refund.pending")).toBe("refund.pending");
    expect(publicType("evt.identity.account.updated")).toBe("account.updated");
    expect(publicType("evt.compliance.review.closed")).toBe("review.closed");
    for (const s of routed) expect(publicType(s), s).toBe(SUBJECT_TO_WEBHOOK_TYPE[s]);
    for (const s of ["evt.rails.execution.settled", "evt.payments.payment_intent.expired", "toString", "evt.x.y.z"])
      expect(publicType(s), s).toBeNull();
    expect(publicType("evt.payments.checkout_session.completed")).toBe("checkout.session.completed");
    expect(publicType("evt.agentpay.agent_payment.settled")).toBe("agent_payment.settled");
  });
});

const row = (o: Partial<StoredEvent> = {}): StoredEvent => ({
  id: uuidv7(),
  type: "payment_intent.succeeded",
  livemode: false,
  object_sequence: 7,
  data: paymentIntent({ status: "succeeded", sequence: 7 }) as unknown as Record<string, unknown>,
  previous: { status: "processing" },
  request: { id: null, idempotency_key: null },
  created_at: new Date("2026-11-05T10:00:00.000Z"),
  ...o,
});

describe("rendering", () => {
  it("builds the api-conventions §9 envelope and parses with the spec", () => {
    const r = row();
    const e = canonicalEvent(r, API_VERSION);
    expect(e).toMatchObject({
      id: fromUuid("evt", r.id),
      object: "event",
      type: "payment_intent.succeeded",
      api_version: API_VERSION,
      created: Math.floor(Date.parse("2026-11-05T10:00:00.000Z") / 1000),
      livemode: false,
      data: { object: { sequence: 7, status: "succeeded" }, previous_attributes: { status: "processing" } },
      request: { id: null, idempotency_key: null },
    });
    expect(Event.safeParse(e).success).toBe(true);
  });

  it("adds data.object.sequence from the aggregate version when the object has none", () => {
    const cs = checkoutSession({ status: "complete" }) as unknown as Record<string, unknown>;
    const e = canonicalEvent(
      row({ type: "checkout.session.completed", data: cs, object_sequence: 3, previous: null, request: null }),
      API_VERSION,
    );
    expect((e.data.object as { sequence: number }).sequence).toBe(3);
    expect(e.data).not.toHaveProperty("previous_attributes");
    expect(e.request).toEqual({ id: null, idempotency_key: null });
    expect(Event.safeParse(e).success).toBe(true);
    const ap = agentPayment() as unknown as Record<string, unknown>;
    const a = canonicalEvent(row({ type: "agent_payment.settled", data: ap, object_sequence: 2 }), API_VERSION);
    expect((a.data.object as { sequence: number }).sequence).toBe(2);
    expect(Event.safeParse(a).success).toBe(true);
  });

  it("keeps the producer's own sequence on checkout sessions and agent payments (spec 0.1.5)", () => {
    const cs = checkoutSession({ status: "complete", sequence: 9 }) as unknown as Record<string, unknown>;
    const e = canonicalEvent(row({ type: "checkout.session.completed", data: cs, object_sequence: 3 }), API_VERSION);
    expect((e.data.object as { sequence: number }).sequence).toBe(9);
    expect(Event.safeParse(e).success).toBe(true);
    const ap = agentPayment({ sequence: 0 }) as unknown as Record<string, unknown>;
    const a = canonicalEvent(row({ type: "agent_payment.settled", data: ap, object_sequence: 4 }), API_VERSION);
    expect((a.data.object as { sequence: number }).sequence).toBe(0);
  });

  it("stores the object's sequence at ingest, falling back to the aggregate version", () => {
    expect(objectSequence({ sequence: 9 }, 3)).toBe(9);
    expect(objectSequence({ sequence: 0 }, 3)).toBe(0);
    expect(objectSequence({}, 3)).toBe(3);
    expect(objectSequence({ sequence: null }, 3)).toBe(3);
    expect(objectSequence({ sequence: -1 }, 3)).toBe(3);
    expect(objectSequence({ sequence: 1.5 }, 3)).toBe(3);
    expect(objectSequence({ sequence: "9" }, 3)).toBe(3);
    expect(objectSequence(null, 3)).toBe(3);
  });

  it("keeps ping objects as they are and copies the request", () => {
    const ep = uuidv7();
    const e = canonicalEvent(
      row({
        type: "ping",
        data: pingObject(ep),
        previous: null,
        request: { id: "req_01jbz9k3m4n5p6q7r8s9t0v1w2", idempotency_key: "k1" },
      }),
      API_VERSION,
    );
    expect(e.data.object).toEqual({ object: "ping", webhook_endpoint: fromUuid("we", ep) });
    expect(e.request).toEqual({ id: "req_01jbz9k3m4n5p6q7r8s9t0v1w2", idempotency_key: "k1" });
    expect(Event.safeParse(e).success).toBe(true);
  });

  it("renders per endpoint version and refuses unknown versions", () => {
    expect(renderFor(row(), API_VERSION, API_VERSION).api_version).toBe(API_VERSION);
    expect(() => renderFor(row(), "2020-01-01", API_VERSION)).toThrow(/unsupported api version/);
  });

  it("every public type has an object schema", () => {
    for (const t of WEBHOOK_TYPE_NAMES) expect(WEBHOOK_TYPES[t].object).toBeDefined();
  });
});
