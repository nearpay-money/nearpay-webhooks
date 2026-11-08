# nearpay-webhooks

> Public event log, webhook endpoints, signed delivery with retries, replay and delivery logs.

|                                       |                                                                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Group                                 | Services                                                                                                   |
| Kind                                  | service                                                                                                    |
| Ships as                              | image: ghcr.io/nearpay-money/webhooks · routes /v1/events, /v1/webhook_endpoints, /v1/webhook_signing_keys |
| Owns                                  | Event, WebhookEndpoint, Delivery                                                                           |
| Depends on (published artifacts only) | spec, kit, NATS, Valkey, egress proxy                                                                      |
| First built in                        | Stage 1 (step 1.2)                                                                                         |

## Documentation

This repo stays surgical: design docs live in [`nearpay-brain`](../nearpay-brain/README.md), not here.

- `nearpay-brain/lld/webhooks.md` — **low-level design (dev-ready; implement from this)**
- `nearpay-brain/lld/audits/webhooks.md` — audit findings already folded into the LLD
- `nearpay-brain/roadmap/development-plan.md` — stage and step this repo is built in
- `nearpay-brain/architecture/hld.md` — system design
- `nearpay-brain/architecture/repositories.md` — repo topology and dependency rules
- `nearpay-brain/architecture/api-conventions.md#9-webhooks`
- `nearpay-brain/architecture/flows.md#8-event-and-webhook-delivery`

## Layout

```
nearpay-webhooks/
├── migrations/            0001_webhooks.sql (endpoints, transitions, events, deliveries, attempts)
│                          0002_stage2_resend_modeless.sql (deliveries.resend_no, events unique per mode)
│                          0004_event_stream.sql (events.inserted_at + events_stream index, Stage 3)
├── src/
│   ├── api/               spec route bindings (the events stream opens kit `ctx.sse(limits)`)
│   ├── app/               endpoints, events (ingest + API), events stream, views, pagination, process wiring
│   ├── consumers/         domain-event ingest handlers
│   ├── dispatcher/        claim → sign → POST via egress proxy → record
│   ├── domain/
│   │   ├── delivery/      retry schedule, abandonment, endpoint disable, resend planning (pure)
│   │   ├── endpoint/      URL/SSRF policy, subscriptions, secret rotation window (pure)
│   │   ├── event/         domain → public mapping and objects (reviews, modes, invoices), version rendering (pure)
│   │   └── stream/        events stream: types filter, resume outcome, settle-window tail (pure)
│   ├── infra/             db schema, egress client (CONNECT / absolute-form), Valkey semaphore and stream
│   │                      slots, Postgres LISTEN hub
│   ├── ops/               ops CLI
│   ├── signing/           HMAC v1 + Ed25519 v1a, secrets, JWKS
│   └── workers/           jobs (abandon sweep, retention purge, kit purge)
└── test/
    ├── contract/          spec contract (routes, subjects, objects, signature format)
    ├── integration/       Testcontainers (Postgres, NATS, Valkey) + proxy/receiver fixtures
    ├── property/          fast-check (delivery rules, SSRF, rotation window, resend uniqueness, stream tail)
    └── unit/              domain, signing vectors, config
```

## Commands

```sh
pnpm install                 # @nearpay/* from the local registry (nearpay-deploy/scripts/up.sh starts it)
pnpm verify                  # typecheck, lint, unit + property tests (coverage gate), integration, build
pnpm test                    # unit + property only (no Docker)
pnpm test:integration        # Testcontainers (Postgres, NATS, Valkey) + spec contract + egress tests
node dist/main.js api|ingest|dispatcher|migrate|healthcheck
```

Integration tests in the cloud workspace: `TESTCONTAINERS_RYUK_DISABLED=true pnpm test:integration`.

## Configuration

| Variable                          | Process         | Default | Meaning                                                                                     |
| --------------------------------- | --------------- | ------- | ------------------------------------------------------------------------------------------- |
| `NP_DB_URL_FILE`                  | all             | —       | app-role database URL (migrate: migrator role)                                              |
| `NP_ENDPOINT_SECRET_KEK_FILE`     | api, dispatcher | —       | 32-byte KEK: endpoint signing secrets and stored idempotent responses                       |
| `NP_WEBHOOK_SIGNING_KEY_FILE`     | api, dispatcher | —       | platform Ed25519 key (PKCS#8 PEM): `v1a` signatures and the JWKS                            |
| `NP_WEBHOOK_SIGNING_KID`          | api, dispatcher | derived | `kid=`; default `wh-` + 12 hex of SHA-256(raw public key)                                   |
| `NP_JWKS_URL`                     | api             | —       | identity JWKS (request tokens)                                                              |
| `NP_NATS_URL`                     | ingest          | —       | domain events                                                                               |
| `NP_EGRESS_PROXY`                 | dispatcher      | unset   | Smokescreen (`http://egress-proxy:4750`); **required** when `NP_ENV=server`                 |
| `NP_VALKEY_URL`                   | dispatcher      | unset   | per-endpoint semaphore across replicas (else 1 in flight per endpoint per replica)          |
| `NP_DELIVERY_TIMEOUT_MS`          | dispatcher      | 10000   | whole attempt, including connect                                                            |
| `NP_MAX_CONCURRENCY_PER_ENDPOINT` | dispatcher      | 5       | deliveries in flight per endpoint                                                           |
| `NP_DISPATCH_CONCURRENCY`         | dispatcher      | 50      | deliveries in flight per dispatcher replica                                                 |
| `NP_ENV`                          | all             | `local` | `local`/`test` allow `localhost`, `*.localhost`, loopback and `merchant-demo` endpoint URLs |

## Behaviour (Stage 1)

- **Endpoints**: `POST/GET/PATCH/DELETE /v1/webhook_endpoints`, `POST …/{id}/test` (a `ping` event to that endpoint only). The `whsec_…` secret is returned once and stored envelope-encrypted (AAD = endpoint id); idempotent replays of the create come from the encrypted idempotency store. URLs are checked on create and on every change (`url_invalid`): https only in live mode, ports 80/443, no credentials, no private/loopback/link-local/CGNAT/multicast/reserved/ULA/metadata IP literals, no single-label or internal host names; local hosts only off the server stage. `enabled_events` entries must be `*` or a webhook type: since spec 0.1.5 request validation accepts any string (1–100 chars) and the service answers an unknown type, even next to `*`, with `400 event_type_unknown` (`param: enabled_events[i]`). Status changes (merchant disable/enable, delete, 72 h failure disable) write `webhook_endpoint_transitions`; deletes are soft and abandon undelivered deliveries.
- **Delivery log**: `GET /v1/webhook_endpoints/{id}/deliveries` (spec 0.1.5, same auth as reading the endpoint) lists the endpoint's `WebhookDelivery` summaries (`whd_…`: event, type, `pending`/`failed` (retry scheduled)/`succeeded`/`abandoned`, attempts, last status code and error, next attempt, success time) of the last 30 days, newest first, with `starting_after`/`ending_before` cursors (keyset on `created_at, id`, so deliveries created before 1.4 with random UUIDs page correctly).
- **Ingest** (`webhooks-ingest`): the 11 subjects the catalogue routes to webhooks (checkout sessions, payment intents, agent payments) become one public `Event` each (inbox + `source_event_id` dedupe) and one pending delivery (UUIDv7 id) per enabled endpoint subscribed to the type (`*` or explicit). The object's own `sequence` is kept (spec 0.1.5: checkout sessions and agent payments carry it too); only objects without one (producers older than 0.1.5) get the domain event's aggregate version as `data.object.sequence`. Invalid payloads are dead-lettered.
- **Dispatch** (`webhooks-dispatcher`): due deliveries are claimed with `FOR UPDATE SKIP LOCKED` and a 60 s lease; ≤ 5 in flight per endpoint (Valkey sorted set `wh:<endpoint>`, 30 s slot expiry); the event is rendered in the endpoint's API version and signed `t=…,v1=<hmac per active secret>,v1a=<ed25519>,kid=…`; POST through the egress proxy (CONNECT + TLS for https, absolute-form for http), timeout 10 s, no redirects, `User-Agent: NearPay-Webhooks/1.0`, `NearPay-Event-Id`, `NearPay-Event-Type`. 2xx → succeeded; otherwise retried after 1 m, 5 m, 30 m, 2 h, 5 h, 10 h, then every 12 h (± 10 %) and abandoned 72 h after creation. An endpoint failing continuously for more than 72 h is disabled (`disabled_reason: failing`) and `evt.webhooks.endpoint.disabled` goes to the outbox (notify emails the owners). Proxy refusals and timeouts are attempts with no status code. Every attempt is logged (`delivery_attempts`: status, duration, error, 500-character response excerpt).
- **Events API**: `GET /v1/events` (filters `type`, `created[gte/lte]`, cursors) and `GET /v1/events/{id}`, last 30 days; `GET /v1/webhook_signing_keys` (anonymous JWKS).
- **Jobs** (in `webhooks-ingest`): `deliveries.abandon` every 10 min, `secrets.expire` every 10 min (Stage 2: erases rotated-out secrets after their overlap), `events.purge` daily (30-day retention of events, deliveries, attempts), `kit.purge` hourly.
- **Metrics**: `nearpay_webhooks_events_ingested_total{type}`, `…_delivery_latency_seconds`, `…_deliveries_total{outcome,code_class}`, `…_endpoints_disabled_total`, `…_due_backlog`, plus the kit set.

## Behaviour (Stage 2, spec 0.2.0)

- **New event types**: `refund.{created,requires_action,pending,succeeded,failed,canceled}` (object `Refund`, its own `sequence` kept), `review.{opened,closed}` (the bus `Review` rendered with the spec's `toPublicReview()` into `PublicReview` at ingest; an execution review without `payment_intent` is not public: no event, no dead letter) and `account.updated` (public `Account`). Identity sends `account.updated` without a mode (`livemode: null`: an account is neither test nor live), so it becomes **one public event per mode**, each delivered to that mode's endpoints and listed by that mode's events API (`events` is unique on `(source_event_id, livemode)`). Any other event without a mode, and any object whose own `livemode` disagrees with the envelope (INV-8), is dead-lettered.
- **Secret rotation**: `POST /v1/webhook_endpoints/{id}/rotate_secret` `{expire_previous_in_seconds 0–86400, default 86400}` returns the endpoint with the new `secret` (once) and `previous_secret_expires_at`. During the overlap every delivery carries two `v1=` signatures, the new secret first; at the expiry instant the previous secret stops signing; rotating during an overlap replaces the previous secret; `0` drops it at once. Allowed on disabled endpoints. Each rotation writes a `secret_rotated` transition (same status, evidence: the expiry). Reads show `previous_secret_expires_at` (null outside an overlap). The idempotent response is stored encrypted like create's.
- **Resend**: `POST /v1/events/{id}/resend` `{endpoint?}` → `202 EventResend` with one new `pending` delivery (UUIDv7, fresh schedule and 72 h window) per endpoint: the given one (caller's, same mode — else `404` with `param: endpoint`; enabled — else `409 state_conflict`; subscriptions ignored) or every enabled endpoint subscribed to the type (a `ping` only to the endpoint it tested). Deliveries are unique on `(event_id, endpoint_id, resend_no)`: 0 is the original, each resend takes the next number; the event row is locked so concurrent resends never collide. Events past the 30-day window are `404`.

## Ops CLI (Stage 1)

`docker compose -p nearpay exec webhooks-api /nodejs/bin/node dist/ops.js <command>`: `endpoint <we_…>` (no secret; transitions, delivery counts, recent deliveries), `event <evt_…>` (deliveries with their attempt logs), `retry <evt_…> [--endpoint <we_…>]`, `enable <we_…>`, `backlog [--limit N]`.

## Status

Stages 1–2 implemented (step 1.2; spec 0.1.5 in step 1.4; spec 0.2.0 in step 2.2): every Stage 1–2 route of the spec (12, including the delivery log, `rotate_secret` and `resend`), the 20 consumed subjects, the produced `evt.webhooks.endpoint.disabled`. Stage 3 (billing events, `GET /v1/events/stream`) is not started.

## Built with

Fastify, Kysely, pg, NATS (via `@nearpay-internal/*`), ioredis, zod, Node's `http`/`https`/`tls` and `crypto` (HMAC-SHA256, Ed25519); Vitest, fast-check, Testcontainers, Biome. Code and documentation are written with AI assistance (Claude) under human direction and review.
