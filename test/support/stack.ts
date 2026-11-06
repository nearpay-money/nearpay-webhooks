/**
 * Integration harness: Postgres provisioned like nearpay-deploy's `postgres-init` (migrator owns the
 * database, the app role has DML only); the real `api`, `ingest` and `dispatcher` from the factories
 * `main.ts` uses; NATS for domain events; optionally Valkey for the per-endpoint semaphore; a forward
 * proxy in front of every delivery (like Smokescreen) and a recording merchant endpoint.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { type Bus, connectBus, type Envelope, publish } from "@nearpay-internal/bus";
import { createDb, type Database, migrate } from "@nearpay-internal/db";
import { newId, toUuid } from "@nearpay-internal/ids";
import type { Service } from "@nearpay-internal/service";
import {
  type EventProbe,
  eventProbe,
  mintTestToken,
  provisionServiceDatabase,
  type Started,
  startNats,
  startPostgres,
  startValkey,
  testKeySource,
} from "@nearpay-internal/testing";
import type { Webhooks } from "../../src/app/context.js";
import { createApi, createDispatcher, createIngest } from "../../src/app/services.js";
import type { DispatcherConfig } from "../../src/config.js";
import type { Dispatcher } from "../../src/dispatcher/dispatcher.js";
import { MIGRATIONS_DIR } from "../../src/infra/db/migrations.js";
import type { DB } from "../../src/infra/db/schema.js";
import { loadSigningKey, type WebhookSigningKey } from "../../src/signing/signer.js";
import { type Receiver, startProxy, startReceiver, type TestProxy } from "./net.js";

export interface Merchant {
  readonly account: `acct_${string}`;
  readonly uuid: string;
}

export interface Stack {
  readonly pg: Started;
  readonly nats: Started & { monitorUrl: string };
  readonly valkey: Started | null;
  readonly admin: Database<DB>;
  readonly url: string;
  readonly api: { service: Service; webhooks: Webhooks };
  readonly ingest: { service: Service; webhooks: Webhooks };
  readonly dispatcher: { service: Service; webhooks: Webhooks; dispatcher: Dispatcher };
  readonly proxy: TestProxy;
  readonly receiver: Receiver;
  readonly signingKey: WebhookSigningKey;
  merchant(): Merchant;
  token(
    m: Merchant,
    o?: { livemode?: boolean; ptype?: "secret_key" | "restricted_key"; scp?: string[] },
  ): Promise<string>;
  call(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    o?: { body?: unknown; token?: string | null; headers?: Record<string, string> },
    // biome-ignore lint/suspicious/noExplicitAny: responses are asserted structurally in tests
  ): Promise<{ status: number; body: any; headers: Headers }>;
  publishEvent(e: Envelope): Promise<void>;
  probe(filter?: string): Promise<EventProbe>;
  stop(): Promise<void>;
}

export interface StackOptions {
  valkey?: boolean;
  dispatcher?: Partial<DispatcherConfig>;
}

export async function startStack(o: StackOptions = {}): Promise<Stack> {
  const [pg, nats, valkey] = await Promise.all([
    startPostgres({ database: "postgres" }),
    startNats(),
    o.valkey ? startValkey() : null,
  ]);
  const { migratorUrl, appUrl } = await provisionServiceDatabase(pg.url, "webhooks");
  const migrator = createDb<DB>({ url: migratorUrl });
  await migrate(migrator.db, MIGRATIONS_DIR);
  await migrator.close();
  const admin = createDb<DB>({ url: appUrl, applicationName: "webhooks-test" });

  const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const signingKey = loadSigningKey(pem);
  const base = {
    env: "test" as const,
    logLevel: "silent" as const,
    host: "127.0.0.1",
    port: 0,
    metricsPort: 0,
    dbUrl: appUrl,
  };
  const keys = { endpointSecretKek: randomBytes(32).toString("base64"), webhookSigningKey: pem };
  const db = (app: string) => createDb<DB>({ url: appUrl, applicationName: `webhooks-${app}-test` });

  const api = createApi({ ...base, ...keys }, { keys: testKeySource(), database: db("api") });
  const { port } = await api.service.start();
  const ingest = await createIngest({ ...base, natsUrl: nats.url }, { database: db("ingest"), tickMs: 50 });
  await ingest.service.start();
  const proxy = await startProxy();
  proxy.deny.add("shop.example.com"); // tests never reach the internet
  const receiver = await startReceiver();
  const dispatcher = createDispatcher(
    {
      ...base,
      ...keys,
      egressProxy: proxy.url,
      deliveryTimeoutMs: 2_000,
      maxConcurrencyPerEndpoint: 5,
      dispatchConcurrency: 20,
      ...(valkey ? { valkeyUrl: valkey.url } : {}),
      ...o.dispatcher,
    },
    { database: db("dispatcher"), pollMs: 50 },
  );
  await dispatcher.service.start();
  const bus: Bus = await connectBus({ url: nats.url, name: "webhooks-test-publisher" });
  const url = `http://127.0.0.1:${port}`;

  return {
    pg,
    nats,
    valkey,
    admin,
    url,
    api,
    ingest,
    dispatcher,
    proxy,
    receiver,
    signingKey,
    merchant() {
      const account = newId("acct");
      return { account, uuid: toUuid(account, "acct") };
    },
    token: (m, t = {}) =>
      mintTestToken({
        sub: newId("key"),
        acct: m.account,
        lm: t.livemode ?? false,
        ptype: t.ptype ?? "secret_key",
        scp: t.scp ?? [],
      }),
    async call(method, path, c = {}) {
      const res = await fetch(`${url}${path}`, {
        method,
        headers: {
          ...(c.token ? { "x-nearpay-token": c.token } : {}),
          ...(c.body !== undefined ? { "content-type": "application/json" } : {}),
          ...c.headers,
        },
        body: c.body === undefined ? undefined : JSON.stringify(c.body),
      });
      const text = await res.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = text;
      }
      // biome-ignore lint/suspicious/noExplicitAny: responses are asserted structurally in tests
      return { status: res.status, body: body as any, headers: res.headers };
    },
    async publishEvent(e) {
      await publish(bus, e.subject, e, e.id);
    },
    probe: (filter = "evt.webhooks.>") => eventProbe(nats.url, filter),
    async stop() {
      await dispatcher.service.stop().catch(() => {});
      await ingest.service.stop().catch(() => {});
      await api.service.stop().catch(() => {});
      await bus.close().catch(() => {});
      await proxy.stop().catch(() => {});
      await receiver.stop().catch(() => {});
      await admin.close();
      await valkey?.stop().catch(() => {});
      await nats.stop().catch(() => {});
      await pg.stop().catch(() => {});
    },
  };
}

export async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 100));
  }
}
