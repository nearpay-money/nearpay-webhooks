/**
 * Concurrent events streams per (account, mode) (lld/webhooks.md §5.1): at most `max` across `api`
 * replicas, held in the Valkey sorted set `wh:stream:<mode>:<account>`. Each stream is one member whose
 * score is its expiry (now + 30 s), refreshed on every heartbeat, so a crashed replica's streams free
 * their slots within 30 s. Without Valkey (unset or unreachable) the limit applies per replica.
 */
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";

export interface StreamSlot {
  /** Extends the slot's expiry (call at least every `ttlMs / 2`). */
  refresh(): Promise<void>;
  /** Frees the slot (idempotent). */
  release(): Promise<void>;
}

export interface StreamSlots {
  /** A slot for (account, mode), or null when `max` streams are already open. */
  acquire(account: string, livemode: boolean): Promise<StreamSlot | null>;
  /** True while slots are shared across replicas (Valkey reachable). */
  shared(): boolean;
  close(): Promise<void>;
}

const ACQUIRE = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[3]) then
  redis.call('ZADD', KEYS[1], tonumber(ARGV[1]) + tonumber(ARGV[2]), ARGV[4])
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0`;

const REFRESH = `
redis.call('ZADD', KEYS[1], tonumber(ARGV[1]) + tonumber(ARGV[2]), ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1`;

const slotKey = (account: string, livemode: boolean) => `wh:stream:${livemode ? "live" : "test"}:${account}`;

/** In-process limit: `max` streams per (account, mode) in this replica. */
export function localStreamSlots(max: number): StreamSlots {
  const held = new Map<string, number>();
  return {
    async acquire(account, livemode) {
      const k = slotKey(account, livemode);
      const n = held.get(k) ?? 0;
      if (n >= max) return null;
      held.set(k, n + 1);
      let released = false;
      return {
        async refresh() {},
        async release() {
          if (released) return;
          released = true;
          const left = (held.get(k) ?? 1) - 1;
          if (left <= 0) held.delete(k);
          else held.set(k, left);
        },
      };
    },
    shared: () => false,
    async close() {},
  };
}

export function valkeyStreamSlots(
  url: string | undefined,
  max: number,
  ttlMs: number,
  now: () => number = Date.now,
): StreamSlots {
  const local = localStreamSlots(max);
  if (!url) return local;
  const redis = new Redis(url, {
    lazyConnect: false,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    connectTimeout: 1_000,
    commandTimeout: 1_000,
  });
  redis.on("error", () => {});
  return {
    async acquire(account, livemode) {
      if (redis.status !== "ready") return local.acquire(account, livemode);
      const k = slotKey(account, livemode);
      const token = randomUUID();
      let got: unknown;
      try {
        got = await redis.eval(ACQUIRE, 1, k, String(now()), String(ttlMs), String(max), token);
      } catch {
        return local.acquire(account, livemode);
      }
      if (Number(got) !== 1) return null;
      let released = false;
      return {
        async refresh() {
          if (released) return;
          // Re-adds the member if Valkey lost it (restart): an open stream keeps its slot.
          await redis.eval(REFRESH, 1, k, String(now()), String(ttlMs), token).catch(() => {});
        },
        async release() {
          if (released) return;
          released = true;
          await redis.zrem(k, token).catch(() => {});
        },
      };
    },
    shared: () => redis.status === "ready",
    async close() {
      redis.disconnect();
    },
  };
}
