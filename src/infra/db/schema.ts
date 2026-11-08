/** Kysely table types (migrations/0001_webhooks.sql, 0002_stage2_resend_modeless.sql, 0004_event_stream.sql). */
import type { ColumnType, KitTables } from "@nearpay-internal/db";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type OptTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type Def<T> = ColumnType<T, T | undefined, T>;
type Opt<T> = ColumnType<T | null, T | null | undefined, T | null>;
type Json<T> = ColumnType<T, string, string>;
type OptJson<T> = ColumnType<T | null, string | null | undefined, string | null>;

export type EndpointStatus = "enabled" | "disabled";
export type DisabledReason = "merchant" | "failing";
export type DeliveryStatus = "pending" | "succeeded" | "failed" | "abandoned";

export interface RequestJson {
  id: string | null;
  idempotency_key: string | null;
}

export interface WebhookEndpointsTable {
  id: string;
  account_id: string;
  livemode: boolean;
  url: string;
  enabled_events: string[];
  api_version: string;
  description: Opt<string>;
  secret_enc: Buffer;
  secondary_secret_enc: Opt<Buffer>;
  secondary_expires_at: OptTimestamp;
  status: EndpointStatus;
  disabled_reason: Opt<DisabledReason>;
  last_success_at: OptTimestamp;
  failing_since: OptTimestamp;
  deleted_at: OptTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: Def<number>;
}

export interface WebhookEndpointTransitionsTable {
  id: string;
  webhook_endpoint_id: string;
  from_state: Opt<string>;
  to_state: string;
  cause: string;
  actor: string;
  evidence: OptJson<Record<string, unknown>>;
  created_at: Timestamp;
}

export interface EventsTable {
  id: string;
  account_id: string;
  livemode: boolean;
  type: string;
  source_event_id: string;
  object_type: string;
  object_id: string;
  object_sequence: number;
  data: Json<Record<string, unknown>>;
  previous: OptJson<Record<string, unknown>>;
  request: OptJson<RequestJson>;
  created_at: ColumnType<Date, Date | string, Date | string>;
  /** Insert instant (Stage 3, migration 0004): the events stream's settle window. */
  inserted_at: ColumnType<Date, never, never>;
}

export interface DeliveriesTable {
  id: string;
  event_id: string;
  endpoint_id: string;
  /** 0: the delivery made at ingest (or by `…/test`); 1, 2, …: resends of the event to this endpoint. */
  resend_no: Def<number>;
  status: DeliveryStatus;
  attempts: Def<number>;
  next_attempt_at: OptTimestamp;
  last_status_code: Opt<number>;
  last_error: Opt<string>;
  created_at: Timestamp;
  succeeded_at: OptTimestamp;
}

export interface DeliveryAttemptsTable {
  id: string;
  delivery_id: string;
  attempt_no: number;
  started_at: ColumnType<Date, Date | string, Date | string>;
  duration_ms: Opt<number>;
  status_code: Opt<number>;
  error: Opt<string>;
  response_excerpt: Opt<string>;
}

export interface DB extends KitTables {
  webhook_endpoints: WebhookEndpointsTable;
  webhook_endpoint_transitions: WebhookEndpointTransitionsTable;
  events: EventsTable;
  deliveries: DeliveriesTable;
  delivery_attempts: DeliveryAttemptsTable;
}
