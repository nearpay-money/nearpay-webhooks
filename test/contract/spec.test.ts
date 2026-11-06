/**
 * Contract (foundations §16): every Stage-1 webhooks route is bound (and nothing else); every subject
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
  ID_PREFIXES,
  listWebhookEndpointDeliveries,
  PUBLIC_ROUTES,
  parseSignatureHeader,
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
import { agentPayment, checkoutSession, paymentIntent } from "@nearpay-internal/testing";
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
import { pingObject } from "../../src/domain/event/render.js";
import { newEndpointSecret, signatureHeader, signingKeyFromSeed } from "../../src/signing/signer.js";

const ALL = [...PUBLIC_ROUTES, ...INTERNAL_ROUTES];

describe("routes and events", () => {
  it("binds every Stage-1 webhooks route, and nothing else", () => {
    const bindings = webhooksRoutes({} as never);
    expect(unimplementedRoutes("webhooks", ALL, bindings).map((r) => r.id)).toEqual([]);
    expect(bindings.map((b) => b.route.id).sort()).toEqual(
      ALL.filter((r) => r.service === "webhooks" && r.stage <= 1)
        .map((r) => r.id)
        .sort(),
    );
    expect(bindings).toHaveLength(10);
    expect(bindings.map((b) => b.route.id)).toContain("listWebhookEndpointDeliveries");
  });

  it("is built against spec 0.1.5: whd_ ids, the deliveries route with the endpoint read auth, open enabled_events", () => {
    expect(SPEC_VERSION).toBe("0.1.5");
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

  it("handles every subject the catalogue routes to webhooks (payments + agentpay), each with a public type", () => {
    const handlers = webhooksHandlers({} as never, {} as never);
    expect(unhandledSubjects("webhooks", handlers)).toEqual([]);
    expect(Object.keys(handlers).sort()).toEqual([...INGESTED].sort());
    expect(INGESTED).toHaveLength(11);
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
      (k) => SUBJECTS[k].producer === "webhooks" && SUBJECTS[k].stage <= 1,
    );
    expect(produced).toEqual(["evt.webhooks.endpoint.disabled"]);
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
};

describe("objects", () => {
  it("webhook endpoints parse (with the secret on create only)", () => {
    expect(WebhookEndpoint.safeParse(endpointView(endpointRow())).success).toBe(true);
    const created = endpointView(endpointRow({ description: "x" }), newEndpointSecret());
    expect(WebhookEndpoint.parse(created).secret).toMatch(/^whsec_/);
    const off = endpointView(endpointRow({ status: "disabled", disabled_reason: "failing" }));
    expect(WebhookEndpoint.safeParse(off).success).toBe(true);
  });

  it("every public event type parses as the spec Event (rendered for the endpoint version)", () => {
    for (const type of WEBHOOK_TYPE_NAMES) {
      const kind = type.startsWith("checkout.session")
        ? "checkout_session"
        : type.startsWith("payment_intent")
          ? "payment_intent"
          : type.startsWith("agent_payment")
            ? "agent_payment"
            : "ping";
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
        data: kind === "ping" ? pingObject(id) : (objects[kind] as () => Record<string, unknown>)(),
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
