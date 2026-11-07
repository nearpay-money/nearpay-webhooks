/** Dependencies shared by webhooks use cases (one context per process: api, ingest, dispatcher, ops). */
import type { EnvelopeCipher, Kysely, Transaction } from "@nearpay-internal/db";
import type { Logger, ServiceMetrics } from "@nearpay-internal/service";
import type { Env } from "../domain/endpoint/url.js";
import type { DB } from "../infra/db/schema.js";
import type { WebhookSigningKey } from "../signing/signer.js";

export type Tx = Transaction<DB>;
export type Db = Kysely<DB> | Tx;

export interface WebhooksMetrics {
  ingested(type: string): void;
  /** Event created → first delivery attempt. */
  firstAttemptLatency(seconds: number): void;
  delivery(outcome: string, codeClass: string): void;
  endpointDisabled(): void;
}

export const noMetrics: WebhooksMetrics = {
  ingested() {},
  firstAttemptLatency() {},
  delivery() {},
  endpointDisabled() {},
};

export function webhooksMetrics(m: ServiceMetrics): WebhooksMetrics {
  const ingested = m.counter("events_ingested_total", "Public events created from domain events.", ["type"]);
  const latency = m.histogram(
    "delivery_latency_seconds",
    "Event created to its first delivery attempt.",
    [],
    [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 300],
  );
  const deliveries = m.counter("deliveries_total", "Delivery attempts by outcome and HTTP status class.", [
    "outcome",
    "code_class",
  ]);
  const disabled = m.counter("endpoints_disabled_total", "Endpoints disabled after 72 h of failures.");
  return {
    ingested: (type) => ingested.inc({ type }),
    firstAttemptLatency: (s) => latency.observe(s),
    delivery: (outcome, codeClass) => deliveries.inc({ outcome, code_class: codeClass }),
    endpointDisabled: () => disabled.inc(),
  };
}

export interface Webhooks {
  readonly env: Env;
  readonly db: Kysely<DB>;
  log: Logger;
  metrics: WebhooksMetrics;
  /** Endpoint-secret cipher (api, dispatcher). */
  readonly cipher: EnvelopeCipher | null;
  /** Platform Ed25519 key (api: JWKS; dispatcher: `v1a`). */
  readonly signingKey: WebhookSigningKey | null;
  readonly now: () => number;
  readonly random: () => number;
}

/** The account principal of a merchant route. */
export interface Merchant {
  /** Account UUID. */
  readonly account: string;
  readonly livemode: boolean;
  /** `<ptype>:<sub>` of the caller, for transition rows. */
  readonly actor: string;
  /** `usr_…` of a dashboard session caller; null for API keys (spec 0.2.1 `actor_user_id`). */
  readonly userId: string | null;
}

export function need<T>(v: T | null, what: string): T {
  if (v === null) throw new Error(`${what} is not configured in this process`);
  return v;
}

/** AAD binding an encrypted endpoint secret to its endpoint. */
export const secretAad = (endpointUuid: string) => `we:${endpointUuid}`;
