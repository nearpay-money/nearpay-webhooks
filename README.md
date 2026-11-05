# nearpay-webhooks

> Public event log, webhook endpoints, signed delivery with retries, replay and delivery logs.

| | |
|---|---|
| Group | Services |
| Kind | service |
| Ships as | image: ghcr.io/nearpay-money/webhooks · routes /v1/events, /v1/webhook_endpoints, /v1/webhook_signing_keys |
| Owns | Event, WebhookEndpoint, Delivery |
| Depends on (published artifacts only) | spec, kit, NATS, egress proxy |
| First built in | Stage 1 (step 1.2) |

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

Scaffold only. Implementation starts in **Stage 1 (step 1.2)** (`nearpay-brain/roadmap/development-plan.md`).

## Built with

Libraries are listed here as they are added (hackathon rule Q-005). Code and documentation are written with AI assistance (Claude) under human direction and review.
