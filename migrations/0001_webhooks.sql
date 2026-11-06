-- nearpay-webhooks, Stage 1 (lld/webhooks.md §3, §12). Kit tables (outbox, inbox, idempotency_keys, jobs,
-- dead_letters) come from @nearpay-internal/db migrations.
-- Deviations from §3 (brain notes): endpoints are soft-deleted (`deleted_at`) because deliveries keep a
-- foreign key to them; status changes of an endpoint are recorded in `webhook_endpoint_transitions`;
-- delivery attempts carry `attempt_no` unique per delivery.

create table webhook_endpoints (
  id uuid primary key,
  account_id uuid not null,
  livemode boolean not null,
  url text not null,
  enabled_events text[] not null,                 -- ['*'] or explicit public types
  api_version text not null,
  description text,
  secret_enc bytea not null,                      -- envelope-encrypted `whsec_…` (aad = endpoint id)
  secondary_secret_enc bytea,                     -- previous secret during a rotation (Stage 2 API)
  secondary_expires_at timestamptz,
  status text not null check (status in ('enabled','disabled')),
  disabled_reason text check (disabled_reason in ('merchant','failing')),
  last_success_at timestamptz,
  failing_since timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 0,
  check ((status = 'disabled') = (disabled_reason is not null)));
create index we_account on webhook_endpoints (account_id, livemode) where status = 'enabled' and deleted_at is null;
create index we_list on webhook_endpoints (account_id, livemode, id desc) where deleted_at is null;

create table webhook_endpoint_transitions (
  id uuid primary key,
  webhook_endpoint_id uuid not null references webhook_endpoints(id),
  from_state text,
  to_state text not null,
  cause text not null,
  actor text not null,
  evidence jsonb,
  created_at timestamptz not null default now());
create index wet_endpoint on webhook_endpoint_transitions (webhook_endpoint_id, created_at);

create table events (
  id uuid primary key,
  account_id uuid not null,
  livemode boolean not null,
  type text not null,
  source_event_id uuid not null unique,           -- domain event id (ingest idempotency)
  object_type text not null,
  object_id text not null,
  object_sequence integer not null,
  data jsonb not null,                            -- canonical object snapshot (latest API version shape)
  previous jsonb,
  request jsonb,
  created_at timestamptz not null);
create index events_account on events (account_id, livemode, created_at desc);
create index events_type on events (account_id, livemode, type, created_at desc);
create index events_created on events (created_at);

create table deliveries (
  id uuid primary key,
  event_id uuid not null references events(id),
  endpoint_id uuid not null references webhook_endpoints(id),
  status text not null check (status in ('pending','succeeded','failed','abandoned')),
  attempts smallint not null default 0,
  next_attempt_at timestamptz,
  last_status_code smallint,
  last_error text,
  created_at timestamptz not null default now(),
  succeeded_at timestamptz,
  unique (event_id, endpoint_id));
create index deliveries_due on deliveries (next_attempt_at) where status in ('pending','failed');
create index deliveries_endpoint on deliveries (endpoint_id, created_at desc);

create table delivery_attempts (
  id uuid primary key,
  delivery_id uuid not null references deliveries(id),
  attempt_no smallint not null,
  started_at timestamptz not null,
  duration_ms integer,
  status_code smallint,
  error text,
  response_excerpt text,
  unique (delivery_id, attempt_no));

-- Transitions are append-only (INV-9).
create function webhooks_append_only() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name;
end $$;
create trigger webhook_endpoint_transitions_append_only before update or delete on webhook_endpoint_transitions
  for each row execute function webhooks_append_only();
