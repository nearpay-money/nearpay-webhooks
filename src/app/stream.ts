/**
 * `GET /v1/events/stream` (`streamEvents`, lld/webhooks.md §5.1, spec 0.3.0): public events of the caller's
 * account and mode as server-sent events, for `nearpay listen` and the dashboard live tail.
 *
 * - Mode (INV-8) is the credential's: API keys stream test mode only (a live key is `403
 *   livemode_forbidden`), dashboard sessions the mode of `NearPay-Mode`. Every query filters by account
 *   and mode.
 * - Frames: `ready` once, `event` per public event (byte-for-byte `GET /v1/events/{id}`, id `evt_…`),
 *   `reset` when a resume cursor cannot be honoured; heartbeat and `retry:` come from the kit.
 * - Resume (`Last-Event-ID` / `starting_after`): replay every later event of the last 30 days in id order,
 *   pages of 100 with `drain()` between pages, then live. Live: poll every 1 s (woken early by
 *   `NOTIFY events_<mode>`) for rows past the 2 s settle window, and re-read 10 s behind the cursor
 *   (`TailState`); at-least-once, in id order per page.
 * - Limits: ≤ 5 streams per (account, mode) (`429 rate_limited`, `Retry-After: 5`), 1 h per stream,
 *   slow readers (> 1 MiB unsent for 30 s) closed; shutdown ends every stream (kit).
 *
 * Streamed events are not deliveries: nothing is signed, retried or written.
 */
import { fromUuid, toUuid } from "@nearpay-internal/ids";
import { ApiError, type ServiceMetrics } from "@nearpay-internal/service";
import { sql } from "kysely";
import type { EventStreamSink, SseLimits } from "../api/sse.js";
import {
  MAX_BUFFERED_BYTES,
  MAX_DURATION_MS,
  PAGE_SIZE,
  POLL_MS,
  parseStreamTypes,
  RETRY_AFTER_S,
  resumeOutcome,
  SETTLE_MS,
  SLOW_CLIENT_MS,
  TailState,
  typeFilter,
  uuidFloor,
} from "../domain/stream/tail.js";
import type { NotifyHub } from "../infra/notify-hub.js";
import type { StreamSlots } from "../infra/stream-slots.js";
import type { Merchant, Webhooks } from "./context.js";
import { RETENTION_DAYS } from "./events.js";
import { type EventRow, eventView } from "./views.js";

export type CloseReason = "client" | "max_duration" | "slow_client" | "shutdown" | "error";

export interface StreamMetrics {
  opened(livemode: boolean): void;
  closed(livemode: boolean, reason: CloseReason): void;
  sent(n: number): void;
}

export const noStreamMetrics: StreamMetrics = { opened() {}, closed() {}, sent() {} };

/** `…_event_streams{mode}`, `…_event_stream_events_total`, `…_event_stream_closed_total{reason}` (§5.1). */
export function streamMetrics(m: ServiceMetrics): StreamMetrics {
  const open = m.gauge("event_streams", "Open events streams in this replica.", ["mode"]);
  open.set({ mode: "test" }, 0);
  open.set({ mode: "live" }, 0);
  const events = m.counter("event_stream_events_total", "Events sent on events streams.");
  const closed = m.counter("event_stream_closed_total", "Events streams closed, by reason.", ["reason"]);
  const mode = (l: boolean) => (l ? "live" : "test");
  return {
    opened: (l) => open.inc({ mode: mode(l) }),
    closed: (l, reason) => {
      open.dec({ mode: mode(l) });
      closed.inc({ reason });
    },
    sent: (n) => events.inc(n),
  };
}

export interface StreamSettings {
  readonly settleMs: number;
  readonly pollMs: number;
  readonly pageSize: number;
  readonly maxDurationMs: number;
  readonly maxBufferedBytes: number;
  readonly slowClientMs: number;
  /** Slot refresh (and slow-reader sampling) interval: the heartbeat. */
  readonly refreshMs: number;
}

export const DEFAULT_STREAM_SETTINGS: StreamSettings = {
  settleMs: SETTLE_MS,
  pollMs: POLL_MS,
  pageSize: PAGE_SIZE,
  maxDurationMs: MAX_DURATION_MS,
  maxBufferedBytes: MAX_BUFFERED_BYTES,
  slowClientMs: SLOW_CLIENT_MS,
  refreshMs: 15_000,
};

export interface Streams {
  readonly slots: StreamSlots;
  readonly hub: NotifyHub;
  metrics: StreamMetrics;
  readonly settings: StreamSettings;
  /** True once the service is shutting down (close reason `shutdown`). */
  draining(): boolean;
}

export interface StreamCaller extends Merchant {
  /** Principal type: `secret_key`, `restricted_key` or `session`. */
  readonly ptype: string;
}

export interface StreamRequest {
  readonly types?: string | undefined;
  /** `Last-Event-ID` or `starting_after` (already validated as an `evt_…` id). */
  readonly cursor?: string | undefined;
}

const API_KEYS = new Set(["secret_key", "restricted_key"]);

/**
 * Validates the request, takes a concurrency slot and opens the stream (`open`, the kit's `ctx.sse`).
 * Errors before `open` are ordinary HTTP errors; afterwards the stream runs in the background until the
 * client leaves, a limit closes it or the service stops.
 */
export async function startEventStream(
  w: Webhooks,
  s: Streams,
  caller: StreamCaller,
  req: StreamRequest,
  open: (limits: SseLimits) => EventStreamSink,
): Promise<void> {
  if (API_KEYS.has(caller.ptype) && caller.livemode) throw new ApiError("livemode_forbidden");
  const parsed = parseStreamTypes(req.types);
  if ("unknown" in parsed)
    throw new ApiError("event_type_unknown", { params: { type: parsed.unknown }, param: `types[${parsed.index}]` });
  const types = parsed.ok;

  const slot = await s.slots.acquire(caller.account, caller.livemode);
  if (!slot)
    throw new ApiError("rate_limited", {
      params: { retry_after: String(RETRY_AFTER_S) },
      headers: { "Retry-After": String(RETRY_AFTER_S) },
    });

  let stream: EventStreamSink;
  let origin: string;
  let reset: { reason: "cursor_unknown" | "cursor_expired"; cursor: string } | null = null;
  try {
    const openedAt = w.now();
    origin = uuidFloor(openedAt);
    if (req.cursor) {
      const cursorUuid = toUuid(req.cursor, "evt");
      const found = await w.db
        .selectFrom("events")
        .select("created_at")
        .where("id", "=", cursorUuid)
        .where("account_id", "=", caller.account)
        .where("livemode", "=", caller.livemode)
        .executeTakeFirst();
      const outcome = resumeOutcome(found ?? null, cursorUuid, openedAt, RETENTION_DAYS * 86_400_000);
      if (outcome.kind === "replay") origin = cursorUuid;
      else reset = { reason: outcome.reason, cursor: req.cursor };
    }
    stream = open({
      maxDurationMs: s.settings.maxDurationMs,
      maxBufferedBytes: s.settings.maxBufferedBytes,
      slowClientMs: s.settings.slowClientMs,
    });
    stream.send("ready", {
      object: "event_stream",
      livemode: caller.livemode,
      account: fromUuid("acct", caller.account),
      types: [...types],
      resumed_after: req.cursor && !reset ? req.cursor : null,
      expires_at: Math.floor((openedAt + s.settings.maxDurationMs) / 1000),
    });
    if (reset) stream.send("reset", { object: "event_stream_reset", ...reset });
  } catch (e) {
    await slot.release();
    throw e;
  }
  s.metrics.opened(caller.livemode);
  void runTail(w, s, caller, typeFilter(types), new TailState(origin), stream, slot);
}

/** The replay + live loop of one open stream. Never throws; always releases the slot. */
async function runTail(
  w: Webhooks,
  s: Streams,
  caller: StreamCaller,
  types: readonly string[] | null,
  state: TailState,
  stream: EventStreamSink,
  slot: { refresh(): Promise<void>; release(): Promise<void> },
): Promise<void> {
  const cfg = s.settings;
  const started = Date.now();
  let wake: (() => void) | null = null;
  let notifyTimer: NodeJS.Timeout | null = null;
  let slowSampled = false;
  let failed = false;

  const unsubscribe = s.hub.subscribe(caller.account, caller.livemode, () => {
    // the notified row is hidden for the settle window: wake right after it
    if (notifyTimer) return;
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      wake?.();
    }, cfg.settleMs + 50);
    notifyTimer.unref();
  });
  const refresher = setInterval(() => {
    slowSampled = stream.buffered > cfg.maxBufferedBytes;
    void slot.refresh();
  }, cfg.refreshMs);
  refresher.unref();
  stream.onClose(() => wake?.());

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      if (stream.closed) return resolve();
      const done = () => {
        clearTimeout(t);
        wake = null;
        resolve();
      };
      const t = setTimeout(done, ms);
      wake = done;
    });

  const base = () => {
    let q = w.db
      .selectFrom("events")
      .selectAll()
      .where("account_id", "=", caller.account)
      .where("livemode", "=", caller.livemode)
      .where("created_at", ">=", new Date(w.now() - RETENTION_DAYS * 86_400_000))
      .where(sql<boolean>`inserted_at < now() - make_interval(secs => ${cfg.settleMs / 1000})`);
    if (types) q = q.where("type", "in", [...types]);
    return q.orderBy("id").limit(cfg.pageSize);
  };

  /** One read of late rows behind the cursor and new rows above it; true when a page was full. */
  const tick = async (): Promise<boolean> => {
    const floor = state.floor;
    const late: EventRow[] =
      floor < state.cursor
        ? await base()
            .where("id", ">", floor)
            .where("id", "<=", state.cursor)
            .where(sql<boolean>`not (id = any(${[...state.sentAboveFloor]}::uuid[]))`)
            .execute()
        : [];
    const forward: EventRow[] = await base().where("id", ">", state.cursor).execute();
    let sent = 0;
    for (const row of state.accept([...late, ...forward])) {
      if (stream.closed) break;
      let view: ReturnType<typeof eventView>;
      try {
        view = eventView(row);
        if (!stream.send("event", view, view.id)) break;
        sent++;
      } catch (e) {
        // A stored event that no longer renders is a bug; skip it rather than wedge every reconnect.
        w.log.error({ err: e, event: row.id, type: row.type }, "ALERT event cannot be streamed");
      }
    }
    if (sent) s.metrics.sent(sent);
    await stream.drain();
    return late.length === cfg.pageSize || forward.length === cfg.pageSize;
  };

  try {
    while (!stream.closed) {
      let full = false;
      try {
        full = await tick();
      } catch (e) {
        w.log.warn({ err: e instanceof Error ? e.message : String(e) }, "events stream read failed; retrying");
      }
      if (!full && !stream.closed) await sleep(cfg.pollMs);
    }
  } catch (e) {
    failed = true;
    w.log.error({ err: e }, "events stream failed");
  } finally {
    unsubscribe();
    clearInterval(refresher);
    if (notifyTimer) clearTimeout(notifyTimer);
    stream.close();
    await slot.release().catch(() => {});
    const reason: CloseReason = failed
      ? "error"
      : s.draining()
        ? "shutdown"
        : Date.now() - started >= cfg.maxDurationMs - 1_000
          ? "max_duration"
          : slowSampled
            ? "slow_client"
            : "client";
    s.metrics.closed(caller.livemode, reason);
  }
}
