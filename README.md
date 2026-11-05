# nearpay-webhooks

> Public event log, webhook endpoints, signed delivery with retries, replay and delivery logs.

| | |
|---|---|
| Group | Services |
| Kind | service |
| Ships as | image: ghcr.io/nearpay-money/webhooks · routes /v1/events, /v1/webhook_endpoints, /v1/webhook_signing_keys |
| Owns | Event, WebhookEndpoint, Delivery |
| Depends on (published artifacts only) | spec, kit, NATS, egress proxy |
| Roadmap phase | P1 Core payments |

## Documentation

This repo stays surgical: design docs live in [`nearpay-brain`](../nearpay-brain/README.md), not here.

- `nearpay-brain/architecture/hld.md` — system design
- `nearpay-brain/architecture/repositories.md` — repo topology and dependency rules
- `nearpay-brain/architecture/api-conventions.md#9-webhooks`
- `nearpay-brain/architecture/flows.md#8-event-and-webhook-delivery`

## Layout

```
nearpay-webhooks/
├── migrations/
├── src/
│   ├── api/
│   ├── app/
│   ├── consumers/
│   ├── dispatcher/
│   ├── domain/
│   │   ├── delivery/
│   │   ├── endpoint/
│   │   └── event/
│   ├── infra/
│   │   ├── bus/
│   │   ├── clients/
│   │   └── db/
│   ├── signing/
│   └── workers/
├── test/
│   ├── contract/
│   ├── integration/
│   ├── property/
│   └── unit/
└── .github/
    └── workflows/
```

## Status

Scaffold only. Implementation starts in phase **P1 Core payments** (`nearpay-brain/roadmap/roadmap.md`).
