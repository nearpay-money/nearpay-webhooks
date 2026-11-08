-- nearpay-webhooks, Stage 3 (lld/webhooks.md §5.1; spec 0.3.0 `GET /v1/events/stream`). Forward-only, additive.
--
-- The events stream reads `events` in id order (UUIDv7 generated at ingest) and only returns rows inserted
-- more than 2 s ago (the settle window), so a lower id that commits a little later is not skipped.
-- `inserted_at` is the insert instant (clock_timestamp(), not the transaction start); existing rows get the
-- migration instant, which only matters for the first 2 s after deploy.
-- Ingest (and `POST /v1/webhook_endpoints/{id}/test`) send `pg_notify('events_' || livemode, account_id)` in the
-- inserting transaction (delivered at commit) to wake streams early; the 1 s poll stays the source of truth.
--
-- Number 0003 is unused (the LLD names this migration 0004).

alter table events add column inserted_at timestamptz not null default clock_timestamp();
create index events_stream on events (account_id, livemode, id);
