/**
 * Per-endpoint concurrency (lld/webhooks.md §6): at most `max` deliveries in flight per endpoint across
 * dispatcher replicas, held in Valkey sorted set `wh:<endpoint>` (members expire after 30 s, so a
 * crashed dispatcher cannot hold slots). When Valkey is unavailable each replica falls back to one
 * delivery in flight per endpoint.
 */
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";

export interface Semaphore {
  /** Returns a release function, or null when the endpoint is at its limit. */
  acquire(endpointId: string): Promise<(() => Promise<void>) | null>;
  /** True while slots are shared across replicas (Valkey reachable). */
  shared(): boolean;
  close(): Promise<void>;
}

export const SLOT_TTL_MS = 30_000;

const ACQUIRE = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[3]) then
  redis.call('ZADD', KEYS[1], tonumber(ARGV[1]) + tonumber(ARGV[2]), ARGV[4])
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0`;

/** In-process limiter: `max` per endpoint in this process. */
export function localSemaphore(max: number): Semaphore {
  const held = new Map<string, number>();
  return {
    async acquire(ep) {
      const n = held.get(ep) ?? 0;
      if (n >= max) return null;
      held.set(ep, n + 1);
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        const left = (held.get(ep) ?? 1) - 1;
        if (left <= 0) held.delete(ep);
        else held.set(ep, left);
      };
    },
    shared: () => false,
    async close() {},
  };
}

export function valkeySemaphore(url: string | undefined, max: number, now: () => number = Date.now): Semaphore {
  const fallback = localSemaphore(1);
  if (!url) return fallback;
  const redis = new Redis(url, {
    lazyConnect: false,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    connectTimeout: 1_000,
    commandTimeout: 1_000,
  });
  redis.on("error", () => {});
  return {
    async acquire(ep) {
      if (redis.status !== "ready") return fallback.acquire(ep);
      const key = `wh:${ep}`;
      const token = randomUUID();
      let got: unknown;
      try {
        got = await redis.eval(ACQUIRE, 1, key, String(now()), String(SLOT_TTL_MS), String(max), token);
      } catch {
        return fallback.acquire(ep);
      }
      if (Number(got) !== 1) return null;
      return async () => {
        await redis.zrem(key, token).catch(() => {});
      };
    },
    shared: () => redis.status === "ready",
    async close() {
      redis.disconnect();
    },
  };
}
