/**
 * Process wiring (lld/webhooks.md §2):
 * - `api`         endpoints, events and signing-key routes, with automatic idempotency (2 replicas)
 * - `ingest`      domain-event consumers, the outbox relay and the jobs (1 replica)
 * - `dispatcher`  signed deliveries through the egress proxy (2 replicas)
 */
import { hostname } from "node:os";
import type { KeySource } from "@nearpay-internal/auth";
import {
  type Bus,
  busReady,
  connectBus,
  consumerLag,
  domainConsumersTask,
  durablesOf,
  ensureStreams,
  publish,
} from "@nearpay-internal/bus";
import {
  createDb,
  createEnvelopeCipher,
  type Database,
  deadLettersOpen,
  type EnvelopeCipher,
  idempotencyStore,
  jobsDue,
  jobWorkerTask,
  migrationStatus,
  outboxLagSeconds,
  outboxRelayTask,
  parseKek,
  recurringJobsTask,
  sql,
} from "@nearpay-internal/db";
import { createService, type Logger, type Service } from "@nearpay-internal/service";
import { STREAMS, type Subject } from "@nearpay-internal/spec";
import { webhooksRoutes } from "../api/routes.js";
import type { ApiConfig, DispatcherConfig, IngestConfig, OpsConfig } from "../config.js";
import { deadLetters, webhooksHandlers } from "../consumers/handlers.js";
import { type Dispatcher, dispatcherTask, dueBacklog } from "../dispatcher/dispatcher.js";
import type { Env } from "../domain/endpoint/url.js";
import { MIGRATIONS_DIR } from "../infra/db/migrations.js";
import type { DB } from "../infra/db/schema.js";
import { type Egress, egressClient } from "../infra/egress.js";
import { type Semaphore, valkeySemaphore } from "../infra/semaphore.js";
import { loadSigningKey, type WebhookSigningKey } from "../signing/signer.js";
import { jobHandlers, RECURRING } from "../workers/jobs.js";
import { noMetrics, type Webhooks, webhooksMetrics } from "./context.js";

export interface ServiceDeps {
  database?: Database<DB>;
  keys?: KeySource;
  cipher?: EnvelopeCipher;
  signingKey?: WebhookSigningKey;
  now?: () => number;
  random?: () => number;
}

interface Built {
  w: Webhooks;
  database: Database<DB>;
}

function build(
  config: { env: Env; dbUrl: string },
  deps: ServiceDeps,
  app: string,
  keys: { kek?: string; signingKey?: string; kid?: string | undefined },
): Built {
  const database = deps.database ?? createDb<DB>({ url: config.dbUrl, applicationName: `webhooks-${app}` });
  const w: Webhooks = {
    env: config.env,
    db: database.db,
    log: undefined as unknown as Logger,
    metrics: noMetrics,
    cipher: deps.cipher ?? (keys.kek ? createEnvelopeCipher(parseKek(keys.kek)) : null),
    signingKey: deps.signingKey ?? (keys.signingKey ? loadSigningKey(keys.signingKey, keys.kid) : null),
    now: deps.now ?? Date.now,
    random: deps.random ?? Math.random,
  };
  return { w, database };
}

function readiness(b: Built) {
  return {
    db: () => sql`select 1`.execute(b.database.db),
    migrations: async () => {
      const s = await migrationStatus(b.database.db, MIGRATIONS_DIR);
      if (s.pending.length || s.drift.length)
        throw new Error(`pending ${s.pending.join(",") || "-"} drift ${s.drift.join(",") || "-"}`);
    },
  };
}

function attach(b: Built, service: Service, deps: ServiceDeps) {
  b.w.log = service.log;
  b.w.metrics = webhooksMetrics(service.metrics);
  service.onShutdown(async () => {
    if (!deps.database) await b.database.close();
  });
}

export function createApi(config: ApiConfig, deps: ServiceDeps = {}): { service: Service; webhooks: Webhooks } {
  const b = build(config, deps, "api", {
    kek: config.endpointSecretKek,
    signingKey: config.webhookSigningKey,
    kid: config.webhookSigningKid,
  });
  const service = createService({
    name: "webhooks",
    config,
    ...(deps.keys ? { keys: deps.keys } : {}),
    routes: webhooksRoutes(b.w),
    idempotency: idempotencyStore(b.database.db, b.w.cipher as EnvelopeCipher),
    readiness: readiness(b),
  });
  attach(b, service, deps);
  return { service, webhooks: b.w };
}

export interface IngestDeps extends ServiceDeps {
  bus?: Bus;
  tickMs?: number;
}

export async function createIngest(
  config: IngestConfig,
  deps: IngestDeps = {},
): Promise<{ service: Service; webhooks: Webhooks }> {
  const b = build(config, deps, "ingest", {});
  const w = b.w;
  const service = createService({ name: "webhooks", config, readiness: readiness(b) });
  attach(b, service, deps);
  const db = b.database;

  const bus = deps.bus ?? (await connectBus({ url: config.natsUrl, name: `webhooks-ingest@${hostname()}` }));
  await ensureStreams(bus, [STREAMS.webhooks]);
  service.addReadiness("bus", () => {
    if (!busReady(bus)) throw new Error("NATS connection is closed");
  });
  const handlers = webhooksHandlers(w, db.db);
  const durables = durablesOf("webhooks", Object.keys(handlers) as Subject[]);
  service.metrics.collectConsumerLag(async () =>
    Object.fromEntries(
      await Promise.all(durables.map(async (d) => [d.durable, await consumerLag(bus, d.stream, d.durable)])),
    ),
  );
  service.metrics.collectOutboxLag(() => outboxLagSeconds(db.db));
  service.metrics.collectJobsDue(() => jobsDue(db.db));
  service.metrics.collectDeadLettersOpen(() => deadLettersOpen(db.db));

  const onError = (e: unknown) => service.log.error({ err: e }, "background error");
  service.addBackground(
    outboxRelayTask({
      db: db.db,
      pool: db.pool,
      publish: (sub, e, mid) => publish(bus, sub, e, mid).then(() => {}),
      onError,
    }),
  );
  service.addBackground(
    domainConsumersTask({ bus, consumer: "webhooks", handlers, onDeadLetter: deadLetters(db.db), onError }),
  );
  service.addBackground(
    jobWorkerTask({
      db: db.db,
      workerId: `webhooks-ingest@${hostname()}:${process.pid}`,
      handlers: jobHandlers(w),
      onError: (e, job) => service.log.warn({ err: e instanceof Error ? e.message : String(e), job }, "job failed"),
      onDeadLetter: (j) => service.log.error({ job: j }, "ALERT job dead-lettered"),
      ...(deps.tickMs ? { pollMs: deps.tickMs } : {}),
    }),
  );
  service.addBackground(
    recurringJobsTask({
      db: db.db,
      pool: db.pool,
      name: "webhooks:recurring-jobs",
      jobs: RECURRING,
      onError,
      ...(deps.tickMs ? { tickMs: deps.tickMs } : {}),
    }),
  );
  if (!deps.bus) service.onShutdown(() => bus.close());
  return { service, webhooks: w };
}

export interface DispatcherDeps extends ServiceDeps {
  egress?: Egress;
  semaphore?: Semaphore;
  pollMs?: number;
  /** Extra CA for https endpoints (tests). */
  ca?: string;
}

export function createDispatcher(
  config: DispatcherConfig,
  deps: DispatcherDeps = {},
): { service: Service; webhooks: Webhooks; dispatcher: Dispatcher } {
  if (config.env === "server" && !config.egressProxy && !deps.egress)
    throw new Error("NP_EGRESS_PROXY is required on the server (deliveries must leave through the egress proxy)");
  const b = build(config, deps, "dispatcher", {
    kek: config.endpointSecretKek,
    signingKey: config.webhookSigningKey,
    kid: config.webhookSigningKid,
  });
  const service = createService({ name: "webhooks", config, readiness: readiness(b) });
  attach(b, service, deps);
  const egress = deps.egress ?? egressClient({ proxy: config.egressProxy, ca: deps.ca });
  if (!egress.viaProxy) service.log.warn("NP_EGRESS_PROXY is not set: deliveries go direct (local/test only)");
  const semaphore = deps.semaphore ?? valkeySemaphore(config.valkeyUrl, config.maxConcurrencyPerEndpoint, b.w.now);
  const dispatcher: Dispatcher = {
    w: b.w,
    egress,
    semaphore,
    settings: {
      timeoutMs: config.deliveryTimeoutMs,
      concurrency: config.dispatchConcurrency,
      leaseMs: config.deliveryTimeoutMs + 50_000,
      pollMs: deps.pollMs ?? 1_000,
    },
  };
  service.metrics.gauge("due_backlog", "Deliveries due and not yet sent.", [], async (g) => {
    g.set(await dueBacklog(b.w));
  });
  service.addBackground(dispatcherTask(dispatcher));
  if (!deps.semaphore) service.onShutdown(() => semaphore.close());
  return { service, webhooks: b.w, dispatcher };
}

/** The webhooks context for the ops CLI (no listener, no background tasks). */
export function createOpsContext(
  config: OpsConfig,
  log: Logger,
  deps: ServiceDeps = {},
): { webhooks: Webhooks; close(): Promise<void> } {
  const b = build(config, deps, "ops", {});
  b.w.log = log;
  return {
    webhooks: b.w,
    async close() {
      if (!deps.database) await b.database.close();
    },
  };
}
