/**
 * Configuration (lld/webhooks.md §9, foundations §13). `*_FILE` variables carry secrets; `secret()`
 * marks the schema object it wraps, so every secret gets a fresh schema (never a shared one).
 */
import { baseConfigShape, loadConfig, secret, url } from "@nearpay-internal/service";
import { z } from "zod";

const bounded = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);
const dbUrl = () => secret(url(["postgres:", "postgresql:"]));

/** Endpoint signing secrets are envelope-encrypted with this 32-byte KEK (base64 or hex). */
const kek = () => ({ endpointSecretKek: secret() });

/** The platform Ed25519 webhook key (PKCS#8 PEM) and its key id (`kid=` in the signature header). */
const signing = () => ({
  webhookSigningKey: secret(),
  /** Defaults to `wh-` + 12 hex of SHA-256(raw public key). */
  webhookSigningKid: z
    .string()
    .regex(/^[a-z0-9-]{1,64}$/)
    .optional(),
});

export const apiShape = { ...baseConfigShape, dbUrl: dbUrl(), ...kek(), ...signing() };

export const ingestShape = { ...baseConfigShape, dbUrl: dbUrl(), natsUrl: url(["nats:", "tls:"]) };

export const dispatcherShape = {
  ...baseConfigShape,
  dbUrl: dbUrl(),
  ...kek(),
  ...signing(),
  /** Smokescreen (`http://egress-proxy:4750`); required on the server, optional locally and in tests. */
  egressProxy: url(["http:"]).optional(),
  deliveryTimeoutMs: bounded(1_000, 30_000, 10_000),
  maxConcurrencyPerEndpoint: bounded(1, 50, 5),
  /** Deliveries in flight per dispatcher replica. */
  dispatchConcurrency: bounded(1, 500, 50),
  /** Per-endpoint semaphore across replicas; without it, 1 in flight per endpoint per replica. */
  valkeyUrl: url(["redis:", "rediss:"]).optional(),
};

export const opsShape = { ...baseConfigShape, dbUrl: dbUrl() };
export const migrateShape = { ...baseConfigShape, dbUrl: dbUrl() };

export type ApiConfig = z.output<z.ZodObject<typeof apiShape>>;
export type IngestConfig = z.output<z.ZodObject<typeof ingestShape>>;
export type DispatcherConfig = z.output<z.ZodObject<typeof dispatcherShape>>;
export type OpsConfig = z.output<z.ZodObject<typeof opsShape>>;

export const readApiConfig = (): ApiConfig => loadConfig(apiShape);
export const readIngestConfig = (): IngestConfig => loadConfig(ingestShape);
export const readDispatcherConfig = (): DispatcherConfig => loadConfig(dispatcherShape);
export const readOpsConfig = (): OpsConfig => loadConfig(opsShape);
