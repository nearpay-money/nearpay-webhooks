/**
 * Spec route bindings (lld/webhooks.md §5, Stages 1–2). Authentication, scopes, session roles and automatic
 * idempotency (POSTs with `Idempotency-Key`; responses stored envelope-encrypted because the create
 * response carries the signing secret) are enforced from the spec by the service bootstrap.
 */
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  getEvent as getEventRoute,
  getWebhookEndpoint,
  listEvents as listEventsRoute,
  listWebhookEndpointDeliveries,
  listWebhookEndpoints,
  listWebhookSigningKeys,
  resendEvent as resendEventRoute,
  rotateWebhookEndpointSecret,
  testWebhookEndpoint,
  updateWebhookEndpoint,
} from "@nearpay/spec";
import { toUuid } from "@nearpay-internal/ids";
import { ApiError, implement, type RequestContext, type RouteBinding, respond } from "@nearpay-internal/service";
import { type Merchant, need, type Webhooks } from "../app/context.js";
import { listDeliveries } from "../app/deliveries.js";
import {
  createEndpoint,
  deleteEndpoint,
  getEndpoint,
  listEndpoints,
  rotateEndpointSecret,
  testEndpoint,
  updateEndpoint,
} from "../app/endpoints.js";
import { getEvent, listEvents } from "../app/events.js";
import { resendEvent } from "../app/resend.js";
import { publicJwk } from "../signing/signer.js";

/** The account principal of a merchant route (secret/restricted key or dashboard session). */
export function merchant(ctx: RequestContext): Merchant {
  const p = ctx.principal;
  if (!p?.acct) throw new ApiError("authentication_required");
  return { account: toUuid(p.acct, "acct"), livemode: ctx.livemode, actor: `${p.ptype}:${p.sub}` };
}

export function webhooksRoutes(w: Webhooks): RouteBinding[] {
  return [
    implement(createWebhookEndpoint, async (ctx) => createEndpoint(w, merchant(ctx), ctx.body)),
    implement(listWebhookEndpoints, async (ctx) => listEndpoints(w, merchant(ctx), ctx.query)),
    implement(getWebhookEndpoint, async (ctx) => getEndpoint(w, merchant(ctx), ctx.params.id)),
    implement(updateWebhookEndpoint, async (ctx) => updateEndpoint(w, merchant(ctx), ctx.params.id, ctx.body)),
    implement(deleteWebhookEndpoint, async (ctx) => {
      await deleteEndpoint(w, merchant(ctx), ctx.params.id);
      return respond(204, undefined);
    }),
    implement(listWebhookEndpointDeliveries, async (ctx) => listDeliveries(w, merchant(ctx), ctx.params.id, ctx.query)),
    implement(testWebhookEndpoint, async (ctx) =>
      testEndpoint(w, merchant(ctx), ctx.params.id, { id: ctx.requestId, idempotency_key: ctx.idempotencyKey ?? null }),
    ),
    implement(rotateWebhookEndpointSecret, async (ctx) =>
      rotateEndpointSecret(w, merchant(ctx), ctx.params.id, ctx.body),
    ),
    implement(resendEventRoute, async (ctx) => resendEvent(w, merchant(ctx), ctx.params.id, ctx.body)),
    implement(listEventsRoute, async (ctx) => listEvents(w, merchant(ctx), ctx.query)),
    implement(getEventRoute, async (ctx) => getEvent(w, merchant(ctx), ctx.params.id)),
    implement(listWebhookSigningKeys, async () => ({
      keys: [publicJwk(need(w.signingKey, "the webhook signing key"))],
    })),
  ];
}
