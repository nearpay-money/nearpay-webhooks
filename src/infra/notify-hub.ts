/**
 * Postgres LISTEN hub for the events stream (lld/webhooks.md §5.1): one dedicated connection per `api`
 * process listens on `events_true` / `events_false` (sent by ingest after commit, payload = account
 * UUID) and wakes the streams of that account and mode. A lost connection is re-established every
 * second; while it is down streams still poll (the poll is the source of truth), so the hub never fails
 * a stream.
 */
import type { BackgroundTask } from "@nearpay-internal/service";

/** The part of a `pg` pool client the hub uses. */
interface Client {
  query(text: string): Promise<unknown>;
  on(event: "notification", fn: (m: { channel: string; payload?: string }) => void): unknown;
  on(event: "error", fn: (e: Error) => void): unknown;
  removeAllListeners(event: string): unknown;
  release(err?: Error | boolean): void;
}
/** The part of a `pg` pool the hub uses (kit `Database.pool`). */
export interface ListenPool {
  connect(): Promise<Client>;
}
type Wake = () => void;

export interface NotifyHub {
  /** Calls `fn` on every notification for (account, livemode); returns the unsubscribe function. */
  subscribe(account: string, livemode: boolean, fn: Wake): () => void;
  /** True while the LISTEN connection is up. */
  listening(): boolean;
}

const CHANNELS = { events_true: true, events_false: false } as const;
const key = (account: string, livemode: boolean) => `${livemode}:${account}`;

/** A hub without a connection (tests, processes without streams): subscribers rely on polling. */
export function pollingOnlyHub(): NotifyHub {
  return { subscribe: () => () => {}, listening: () => false };
}

export interface PgNotifyHub extends NotifyHub {
  /** Dispatches a notification as if it came from Postgres (also used by the connection handler). */
  dispatch(channel: string, payload: string | undefined): void;
  readonly task: BackgroundTask;
}

export function pgNotifyHub(pool: ListenPool, onError: (e: unknown) => void = () => {}, retryMs = 1_000): PgNotifyHub {
  const subs = new Map<string, Set<Wake>>();
  let client: Client | null = null;
  let stopped = true;
  let retry: NodeJS.Timeout | null = null;

  const dispatch = (channel: string, payload: string | undefined) => {
    if (!Object.hasOwn(CHANNELS, channel) || !payload) return;
    const set = subs.get(key(payload, CHANNELS[channel as keyof typeof CHANNELS]));
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn();
      } catch (e) {
        onError(e);
      }
    }
  };

  const drop = (c: Client, err?: unknown) => {
    c.removeAllListeners("notification");
    c.removeAllListeners("error");
    c.on("error", () => {}); // a late socket error must not crash the process
    try {
      c.release(err instanceof Error ? err : true); // never back into the pool (it LISTENs)
    } catch {
      // already released
    }
    if (client === c) client = null;
  };

  const schedule = () => {
    if (stopped || retry) return;
    retry = setTimeout(() => {
      retry = null;
      void connect();
    }, retryMs);
    retry.unref();
  };

  const connect = async () => {
    if (stopped || client) return;
    let c: Client | null = null;
    try {
      c = await pool.connect();
      const held = c;
      held.on("notification", (m) => dispatch(m.channel, m.payload));
      held.on("error", (e) => {
        onError(e);
        drop(held, e);
        schedule();
      });
      await held.query("listen events_true");
      await held.query("listen events_false");
      if (stopped) {
        drop(held);
        return;
      }
      client = held;
    } catch (e) {
      if (c) drop(c, e);
      onError(e);
      schedule();
    }
  };

  return {
    subscribe(account, livemode, fn) {
      const k = key(account, livemode);
      const set = subs.get(k) ?? new Set<Wake>();
      subs.set(k, set);
      set.add(fn);
      return () => {
        const s = subs.get(k);
        if (!s) return;
        s.delete(fn);
        if (!s.size) subs.delete(k);
      };
    },
    listening: () => client !== null,
    dispatch,
    task: {
      name: "webhooks:events-notify",
      async start() {
        stopped = false;
        await connect();
        return {
          async stop() {
            stopped = true;
            if (retry) clearTimeout(retry);
            retry = null;
            if (client) drop(client);
          },
        };
      },
    },
  };
}
