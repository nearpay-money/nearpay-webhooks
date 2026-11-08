/** Configuration (lld/webhooks.md §9): names, defaults, secrets only from files, server guard. */
import { loadConfig } from "@nearpay-internal/service";
import { describe, expect, it } from "vitest";
import { createDispatcher } from "../../src/app/services.js";
import { apiShape, dispatcherShape, ingestShape } from "../../src/config.js";

const files: Record<string, string> = {
  "/run/secrets/db": "postgres://webhooks_app:pw@postgres:5432/webhooks\n",
  "/run/secrets/kek": `${"A".repeat(43)}=`,
  "/run/secrets/key":
    "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBERERERERERERERERERERERERERERERERERERERERER\n-----END PRIVATE KEY-----\n",
};
const readFile = (p: string) => {
  const v = files[p];
  if (v === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
  return v;
};
const base = {
  NP_ENV: "test",
  NP_DB_URL_FILE: "/run/secrets/db",
  NP_ENDPOINT_SECRET_KEK_FILE: "/run/secrets/kek",
  NP_WEBHOOK_SIGNING_KEY_FILE: "/run/secrets/key",
};

describe("configuration", () => {
  it("reads the dispatcher keys of the LLD with their defaults", () => {
    const c = loadConfig(dispatcherShape, { env: { ...base, NP_EGRESS_PROXY: "http://egress-proxy:4750" }, readFile });
    expect(c).toMatchObject({
      dbUrl: "postgres://webhooks_app:pw@postgres:5432/webhooks",
      egressProxy: "http://egress-proxy:4750",
      deliveryTimeoutMs: 10_000,
      maxConcurrencyPerEndpoint: 5,
      dispatchConcurrency: 50,
    });
    expect(c.webhookSigningKid).toBeUndefined();
  });

  it("accepts secrets only from files", () => {
    expect(() =>
      loadConfig(apiShape, {
        env: { ...base, NP_ENDPOINT_SECRET_KEK_FILE: undefined, NP_ENDPOINT_SECRET_KEK: "x" },
        readFile,
      }),
    ).toThrow(/NP_ENDPOINT_SECRET_KEK: secrets are read from files/);
    expect(() => loadConfig(ingestShape, { env: { NP_ENV: "test", NP_DB_URL_FILE: "/run/secrets/db" }, readFile })).toThrow(
      /NP_NATS_URL: is required/,
    );
    // the api ignores dispatcher-only settings; plain values stay plain (no shared secret schema)
    expect(loadConfig(apiShape, { env: { ...base, NP_WEBHOOK_SIGNING_KID: "wh-1" }, readFile }).webhookSigningKid).toBe(
      "wh-1",
    );
  });

  it("refuses to dispatch without the egress proxy on the server", () => {
    const c = loadConfig(dispatcherShape, { env: { ...base, NP_ENV: "server" }, readFile });
    expect(() => createDispatcher(c)).toThrow(/NP_EGRESS_PROXY is required on the server/);
  });
});
