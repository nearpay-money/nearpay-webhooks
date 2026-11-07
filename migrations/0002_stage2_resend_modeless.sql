-- nearpay-webhooks, Stage 2 (lld/webhooks.md §3, §5, §6; spec 0.2.0). Forward-only.
--
-- 1. Resend (`POST /v1/events/{id}/resend`): an event may be delivered to the same endpoint more than once.
--    `resend_no` = 0 for the delivery created at ingest (or by `…/test`), 1, 2, … for each resend of the
--    event to that endpoint. `unique (event_id, endpoint_id)` becomes `unique (event_id, endpoint_id, resend_no)`.
-- 2. Mode-less domain events (`evt.identity.account.updated` carries `livemode: null`; an account is not
--    test or live) become one public event per mode, so `events.source_event_id` is unique per mode.
--
-- Deploy note: ingest of the previous image uses `on conflict (event_id, endpoint_id)` and
-- `on conflict (source_event_id)`, which no longer match a unique constraint after this migration. Run it
-- together with the new image (Compose: migrate, then restart ingest); until then the old ingest fails and
-- NATS redelivers (nothing is lost).

alter table deliveries
  add column resend_no smallint not null default 0 check (resend_no >= 0);
alter table deliveries
  drop constraint deliveries_event_id_endpoint_id_key,
  add constraint deliveries_event_endpoint_resend_key unique (event_id, endpoint_id, resend_no);

alter table events
  drop constraint events_source_event_id_key,
  add constraint events_source_event_mode_key unique (source_event_id, livemode);
