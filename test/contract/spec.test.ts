/**
 * Contract (foundations §16): every Stage 1–2 webhooks route is bound (and nothing else); every subject
 * the catalogue routes to webhooks is handled; the subject webhooks produces is emitted with a payload
 * the catalogue accepts; the objects webhooks serves and delivers parse with the spec schemas; the
 * signature header is the spec format.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  API_VERSION,
  createWebhookEndpoint,
  Event,
  EventResend,
  ID_PREFIXES,
  listWebhookEndpointDeliveries,
  PUBLIC_ROUTES,
  parseSignatureHeader,
  resendEvent,
  rotateWebhookEndpointSecret,
  SPEC_VERSION,
  SUBJECT_TO_WEBHOOK_TYPE,
  updateWebhookEndpoint,
  WEBHOOK_TYPE_NAMES,
  WEBHOOK_TYPES,
  WebhookDelivery,
  WebhookEndpoint,
} from "@nearpay/spec";
import { unhandledSubjects } from "@nearpay-internal/bus";
import { fromUuid, newId, uuidv7 } from "@nearpay-internal/ids";
import { unimplementedRoutes } from "@nearpay-internal/service";
import { envelopeOf, INTERNAL_ROUTES, SUBJECTS, type Subject } from "@nearpay-internal/spec";
import { account, agentPayment, checkoutSession, paymentIntent } from "@nearpay-internal/testing";
import { describe, expect, it } from "vitest";
import { webhooksRoutes } from "../../src/api/routes.js";
import {
  type DeliveryRow,
  deliveryView,
  type EndpointRow,
  type EventRow,
  endpointView,
  eventView,
} from "../../src/app/views.js";
import { INGESTED, webhooksHandlers } from "../../src/consumers/handlers.js";
import { publicObjectOf } from "../../src/domain/event/public.js";
import { pingObject } from "../../src/domain/event/render.js";
import { newEndpointSecret, signatureHeader, signingKeyFromSeed } from "../../src/signing/signer.js";
import { invoice, refund, review, subscription } from "../support/fixtures.js";

const ALL = [...PUBLIC_ROUTES, ...INTERNAL_ROUTES];

describe("routes and events", () => {
  it("binds every Stage 1–2 webhooks route, and nothing else", () => {
    const bindings = webhooksRoutes({} as never);
    expect(unimplementedRoutes("webhooks", ALL, bindings).map((r) => r.id)).toEqual([]);
    expect(bindings.map((b) => b.route.id).sort()).toEqual(
      ALL.filter((r) => r.service === "webhooks" && r.stage <= 2)
        .map((r) => r.id)
        .sort(),
    );
    expect(bindings).toHaveLength(12);
    expect(bindings.map((b) => b.route.id)).toContain("listWebhookEndpointDeliveries");
    expect(bindings.map((b) => b.route.id)).toEqual(
      expect.arrayContaining(["rotateWebhookEndpointSecret", "resendEvent"]),
    );
  });

  it("is built against spec 0.2.1: rotate_secret and resend as the LLD describes them", () => {
    expect(SPEC_VERSION).toBe("0.2.1");
    expect(rotateWebhookEndpointSecret).toMatchObject({
      method: "POST",
      path: "/v1/webhook_endpoints/{id}/rotate_secret",
      idempotent: true,
      status: 200,
      stage: 2,
    });
    const body = rotateWebhookEndpointSecret.body;
    expect(body?.parse({})).toEqual({ expire_previous_in_seconds: 86_400 });
    expect(body?.safeParse({ expire_previous_in_seconds: 86_401 }).success).toBe(false);
    expect(body?.safeParse({ expire_previous_in_seconds: -1 }).success).toBe(false);
    expect(resendEvent).toMatchObject({
      method: "POST",
      path: "/v1/events/{id}/resend",
      idempotent: true,
      status: 202,
    });
    expect(resendEvent.errors).toContain("state_conflict");
    const write = PUBLIC_ROUTES.find((r) => r.id === "createWebhookEndpoint");
    for (const r of [rotateWebhookEndpointSecret, resendEvent]) {
      expect(r.auth).toEqual(write?.auth);
      expect(r.roles).toEqual(write?.roles);
    }
  });

  it("keeps the spec 0.1.5 pieces: whd_ ids, the deliveries route with the endpoint read auth, open enabled_events", () => {
    expect(ID_PREFIXES.whd).toEqual({ object: "webhook_delivery", owner: "webhooks" });
    expect(listWebhookEndpointDeliveries).toMatchObject({
      method: "GET",
      path: "/v1/webhook_endpoints/{id}/deliveries",
      service: "webhooks",
      stage: 1,
    });
    const read = PUBLIC_ROUTES.find((r) => r.id === "getWebhookEndpoint");
    expect(listWebhookEndpointDeliveries.auth).toEqual(read?.auth);
    expect(listWebhookEndpointDeliveries.roles).toEqual(read?.roles);
    // unknown types reach the service (which answers event_type_unknown); responses stay typed
    for (const r of [createWebhookEndpoint, updateWebhookEndpoint]) {
      expect(r.errors).toContain("event_type_unknown");
      expect(r.body?.shape.enabled_events.safeParse(["payment_intent.done"]).success).toBe(true);
    }
  });

  it("handles every subject the catalogue routes to webhooks (payments, agentpay, identity, compliance, billing), each with a public type", () => {
    const handlers = webhooksHandlers({} as never, {} as never);
    expect(unhandledSubjects("webhooks", handlers)).toEqual([]);
    expect(Object.keys(handlers).sort()).toEqual([...INGESTED].sort());
    expect(INGESTED).toHaveLength(32);
    expect(INGESTED).toEqual(
      expect.arrayContaining([
        "evt.payments.refund.created",
        "evt.payments.refund.requires_action",
        "evt.payments.refund.pending",
        "evt.payments.refund.succeeded",
        "evt.payments.refund.failed",
        "evt.payments.refund.canceled",
        "evt.identity.account.updated",
        "evt.compliance.review.opened",
        "evt.compliance.review.closed",
        "evt.billing.invoice.created",
        "evt.billing.invoice.finalized",
        "evt.billing.invoice.sent",
        "evt.billing.invoice.paid",
        "evt.billing.invoice.payment_failed",
        "evt.billing.invoice.overdue",
        "evt.billing.invoice.voided",
        "evt.billing.invoice.marked_uncollectible",
        "evt.billing.subscription.created",
        "evt.billing.subscription.updated",
        "evt.billing.subscription.deleted",
        "evt.billing.subscription.renewal_upcoming",
      ]),
    );
    expect(INGESTED).not.toContain("evt.billing.invoice.reminder");
    for (const s of INGESTED) {
      expect(SUBJECTS[s].consumers).toContain("webhooks");
      expect(SUBJECT_TO_WEBHOOK_TYPE[s], s).toBeDefined();
    }
    // every public type that comes from a domain subject is ingested
    for (const t of WEBHOOK_TYPE_NAMES) {
      const subject = WEBHOOK_TYPES[t].subject;
      if (subject) expect(INGESTED, t).toContain(subject);
    }
  });

  it("emits every subject webhooks produces, with a payload the catalogue accepts", () => {
    const produced = (Object.keys(SUBJECTS) as Subject[]).filter(
      (k) => SUBJECTS[k].producer === "webhooks" && SUBJECTS[k].stage <= 2,
    );
    expect(produced).toEqual(["evt.webhooks.endpoint.disabled", "evt.webhooks.endpoint.secret_rotated"]);
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
    const src = files(new URL("../../src", import.meta.url).pathname)
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    for (const s of produced) expect(src).toContain(s);
    const we = newId("we");
    const env = {
      id: uuidv7(),
      subject: "evt.webhooks.endpoint.disabled",
      occurred_at: new Date().toISOString(),
      account_id: uuidv7(),
      livemode: false,
      aggregate: { type: "webhook_endpoint", id: we, version: 3 },
      data: {
        object: {
          endpoint_id: we,
          account_id: newId("acct"),
          url: "https://shop.example.com/hook",
          reason: "failing",
          failing_since: new Date().toISOString(),
        },
        previous: { status: "enabled" },
      },
    };
    expect(envelopeOf("evt.webhooks.endpoint.disabled").safeParse(env).success).toBe(true);
  });

  it("evt.webhooks.endpoint.secret_rotated (spec 0.2.1) parses for key and session callers, never with a secret", () => {
    const we = newId("we");
    const base = {
      id: uuidv7(),
      subject: "evt.webhooks.endpoint.secret_rotated",
      occurred_at: new Date().toISOString(),
      account_id: uuidv7(),
      livemode: true,
      aggregate: { type: "webhook_endpoint", id: we, version: 2 },
    };
    const object = {
      endpoint_id: we,
      account_id: newId("acct"),
      url: "https://shop.example.com/hook",
      previous_secret_expires_at: new Date().toISOString(),
      actor_user_id: newId("usr"),
    };
    const schema = envelopeOf("evt.webhooks.endpoint.secret_rotated");
    expect(schema.safeParse({ ...base, data: { object } }).success).toBe(true);
    expect(
      schema.safeParse({
        ...base,
        data: { object: { ...object, previous_secret_expires_at: null, actor_user_id: null } },
      }).success,
    ).toBe(true);
    expect(SUBJECTS["evt.webhooks.endpoint.secret_rotated"].consumers).toEqual(["notify"]);
  });
});

const now = new Date();
const endpointRow = (o: Partial<EndpointRow> = {}): EndpointRow => ({
  id: uuidv7(),
  account_id: uuidv7(),
  livemode: false,
  url: "https://shop.example.com/hook",
  enabled_events: ["*"],
  api_version: API_VERSION,
  description: null,
  secret_enc: Buffer.alloc(0),
  secondary_secret_enc: null,
  secondary_expires_at: null,
  status: "enabled",
  disabled_reason: null,
  last_success_at: null,
  failing_since: null,
  deleted_at: null,
  created_at: now,
  updated_at: now,
  version: 0,
  ...o,
});

const objects: Record<string, () => Record<string, unknown>> = {
  checkout_session: () => checkoutSession() as unknown as Record<string, unknown>,
  payment_intent: () => paymentIntent() as unknown as Record<string, unknown>,
  agent_payment: () => agentPayment() as unknown as Record<string, unknown>,
  refund: () => refund() as unknown as Record<string, unknown>,
  account: () => account() as unknown as Record<string, unknown>,
  // stored as rendered at ingest (toPublicReview)
  review: () => (publicObjectOf("review.opened", review(), false) as { ok: Record<string, unknown> }).ok,
  // stage 3 — billing (`customer.subscription.*` carries a Subscription)
  invoice: () => invoice() as unknown as Record<string, unknown>,
  customer: () => subscription() as unknown as Record<string, unknown>,
};

describe("objects", () => {
  it("webhook endpoints parse (with the secret on create and rotate only; previous_secret_expires_at)", () => {
    const t = now.getTime();
    expect(WebhookEndpoint.safeParse(endpointView(endpointRow(), t)).success).toBe(true);
    const created = endpointView(endpointRow({ description: "x" }), t, newEndpointSecret());
    expect(WebhookEndpoint.parse(created).secret).toMatch(/^whsec_/);
    const off = endpointView(endpointRow({ status: "disabled", disabled_reason: "failing" }), t);
    expect(WebhookEndpoint.safeParse(off).success).toBe(true);
    const rotated = endpointView(
      endpointRow({ secondary_secret_enc: Buffer.from("x"), secondary_expires_at: new Date(t + 86_400_000) }),
      t,
      newEndpointSecret(),
    );
    expect(WebhookEndpoint.parse(rotated).previous_secret_expires_at).toBe(Math.floor((t + 86_400_000) / 1000));
  });

  it("event resends parse", () => {
    const r = EventResend.safeParse({
      object: "event_resend",
      event: fromUuid("evt", uuidv7()),
      deliveries: [
        deliveryView({
          id: uuidv7(),
          event_id: uuidv7(),
          endpoint_id: uuidv7(),
          status: "pending",
          attempts: 0,
          next_attempt_at: now,
          last_status_code: null,
          last_error: null,
          created_at: now,
          succeeded_at: null,
          event_type: "refund.succeeded",
          livemode: false,
        }),
      ],
    });
    expect(r.success, r.success ? "" : r.error.issues[0]?.message).toBe(true);
  });

  it("every public event type parses as the spec Event (rendered for the endpoint version)", () => {
    for (const type of WEBHOOK_TYPE_NAMES) {
      const kind: string =
        type === "ping"
          ? "ping"
          : type.startsWith("checkout.session")
            ? "checkout_session"
            : (type.split(".")[0] as string);
      expect(kind === "ping" || (kind as string) in objects, type).toBe(true);
      const id = uuidv7();
      const row: EventRow = {
        id: uuidv7(),
        account_id: uuidv7(),
        livemode: false,
        type,
        source_event_id: uuidv7(),
        object_type: kind,
        object_id: fromUuid("we", id),
        object_sequence: 5,
        data: kind === "ping" ? pingObject(id) : (objects[kind as string] as () => Record<string, unknown>)(),
        previous: kind === "ping" ? null : { status: "open" },
        request: null,
        created_at: now,
      };
      const r = Event.safeParse(eventView(row));
      expect(r.success, `${type}: ${r.success ? "" : r.error.issues[0]?.message}`).toBe(true);
    }
  });

  it("webhook deliveries parse in every status", () => {
    for (const status of ["pending", "failed", "succeeded", "abandoned"] as const) {
      const row: DeliveryRow = {
        id: uuidv7(),
        event_id: uuidv7(),
        endpoint_id: uuidv7(),
        status,
        attempts: status === "pending" ? 0 : 1,
        next_attempt_at: status === "failed" || status === "pending" ? now : null,
        last_status_code: status === "succeeded" ? 200 : status === "failed" ? 500 : null,
        last_error: status === "failed" ? "HTTP 500" : null,
        created_at: now,
        succeeded_at: status === "succeeded" ? now : null,
        event_type: "checkout.session.completed",
        livemode: false,
      };
      const r = WebhookDelivery.safeParse(deliveryView(row));
      expect(r.success, `${status}: ${r.success ? "" : r.error.issues[0]?.message}`).toBe(true);
    }
  });

  it("signature headers parse with the spec parser", () => {
    const key = signingKeyFromSeed("11".repeat(32), "wh-x");
    const h = signatureHeader({
      timestamp: 1_793_873_400,
      body: "{}",
      secrets: [newEndpointSecret(), newEndpointSecret()],
      key,
    });
    expect(parseSignatureHeader(h)).toMatchObject({ timestamp: 1_793_873_400, kid: "wh-x" });
    expect(parseSignatureHeader(h)?.v1).toHaveLength(2);
  });
});
