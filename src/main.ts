/**
 * Process entry (foundations §15, lld/webhooks.md §2): `node dist/main.js api|ingest|dispatcher|migrate|healthcheck`.
 * - `api`         endpoints, events and signing keys (`webhooks-api`, 2 replicas)
 * - `ingest`      domain-event consumers, outbox relay, jobs (`webhooks-ingest`, 1 replica)
 * - `dispatcher`  signed deliveries via the egress proxy (`webhooks-dispatcher`, 2 replicas)
 * - `migrate`     applies kit + webhooks migrations with the migrator role (one-shot)
 */
import { createDb, migrate } from "@nearpay-internal/db";
import { loadConfig, runMain } from "@nearpay-internal/service";
import { migrateShape, readApiConfig, readDispatcherConfig, readIngestConfig } from "./config.js";
import { MIGRATIONS_DIR } from "./infra/db/migrations.js";

await runMain({
  api: async () => {
    const { createApi } = await import("./app/services.js");
    return createApi(readApiConfig()).service;
  },
  ingest: async () => {
    const { createIngest } = await import("./app/services.js");
    return (await createIngest(readIngestConfig())).service;
  },
  dispatcher: async () => {
    const { createDispatcher } = await import("./app/services.js");
    return createDispatcher(readDispatcherConfig()).service;
  },
  migrate: async () => {
    const config = loadConfig(migrateShape);
    const database = createDb({ url: config.dbUrl, applicationName: "webhooks-migrate" });
    try {
      const applied = await migrate(database.db, MIGRATIONS_DIR, (m) => process.stdout.write(`${m}\n`));
      process.stdout.write(`migrations up to date (${applied.length} applied)\n`);
    } finally {
      await database.close();
    }
    return undefined;
  },
});
