/**
 * Kit adapter for the events stream (lld/webhooks.md §5.1) — the only file that knows which kit SSE API
 * is available. Kit 0.3.0 adds `ctx.sse(limits)` (`maxDurationMs`, `maxBufferedBytes`, `slowClientMs`),
 * `SseStream.buffered` / `drain()` and `resumeCursor(headers, query)`; until it is published this file
 * provides the same behaviour on top of kit 0.2.1's `ctx.sse()`.
 *
 * Switching to kit 0.3.0: open with `ctx.sse(limits)` (dropping the local duration and slow-reader timers),
 * keep this file's `drain()` (kit 0.3.0's waits for 'drain' whenever `writableLength > 0`, which never
 * comes for a write that returned true) and the `onClose` socket destroy for slow readers, and re-export
 * `resumeCursor` / `SseLimits` from `@nearpay-internal/service`; nothing outside this file changes.
 */
import type { streamEvents } from "@nearpay/spec";
import type { RequestContext, SseStream } from "@nearpay-internal/service";

/** Limits for long-lived streams (kit 0.3.0 `SseLimits`). */
export interface SseLimits {
  /** Close the stream after this long (clients reconnect with `Last-Event-ID`). */
  readonly maxDurationMs?: number;
  /** A client is slow while more than this many bytes are unsent… */
  readonly maxBufferedBytes?: number;
  /** …and is closed once it stays slow this long (checked with the heartbeat). Default 30 s. */
  readonly slowClientMs?: number;
}

type StreamEvent = "ready" | "event" | "reset";

/** The kit 0.3.0 stream surface the events stream uses. */
export interface EventStreamSink {
  send(event: StreamEvent, data: unknown, id?: string): boolean;
  close(): void;
  readonly closed: boolean;
  readonly done: Promise<void>;
  onClose(fn: () => void): void;
  /** Bytes written but not yet flushed to the client. */
  readonly buffered: number;
  /** Resolves once the socket buffer is below its high-water mark again (immediately when it is, or closed). */
  drain(): Promise<void>;
}

/**
 * Resume cursor of an SSE request (kit 0.3.0 `resumeCursor`): the `Last-Event-ID` header wins over the
 * query cursor (`starting_after`); blank values count as absent.
 */
export function resumeCursor(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  queryCursor?: string,
): string | undefined {
  const raw = headers["last-event-id"];
  const header = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (header) return header;
  const q = queryCursor?.trim();
  return q ? q : undefined;
}

/** Opens the route's stream with `limits` (kit 0.3.0 `ctx.sse(limits)`). */
export function openEventStream(ctx: RequestContext<typeof streamEvents>, limits: SseLimits): EventStreamSink {
  const s = ctx.sse() as SseStream<StreamEvent>;
  const res = ctx.reply.raw;
  const heartbeatMs = (ctx.route.stream?.heartbeatSeconds ?? 15) * 1000;
  let slowSince: number | undefined;
  const watch = setInterval(() => {
    if (s.closed || limits.maxBufferedBytes === undefined) return;
    if (res.writableLength > limits.maxBufferedBytes) {
      slowSince ??= Date.now();
      if (Date.now() - slowSince >= (limits.slowClientMs ?? 30_000)) s.close();
    } else slowSince = undefined;
  }, heartbeatMs);
  watch.unref();
  const lifetime = limits.maxDurationMs !== undefined ? setTimeout(() => s.close(), limits.maxDurationMs) : undefined;
  lifetime?.unref();
  s.onClose(() => {
    clearInterval(watch);
    if (lifetime) clearTimeout(lifetime);
    // `end()` cannot flush to a client that does not read: drop the socket instead of keeping megabytes
    // queued for it (kit 0.3.0 only ends the response; kept here for both kit versions).
    if (limits.maxBufferedBytes !== undefined && res.writableLength > limits.maxBufferedBytes) res.destroy();
  });
  return {
    send: (event, data, id) => s.send(event, data, id),
    close: () => s.close(),
    get closed() {
      return s.closed;
    },
    done: s.done,
    onClose: (fn) => s.onClose(fn),
    get buffered() {
      return res.writableLength;
    },
    drain() {
      // Only a write that returned false emits 'drain' (`writableNeedDrain`); bytes merely queued below the
      // high-water mark never do, so waiting on `writableLength > 0` would hang (kit 0.3.0 does that: CR).
      if (s.closed || !res.writableNeedDrain) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const done = () => {
          res.off("drain", done);
          res.off("close", done);
          resolve();
        };
        res.on("drain", done);
        res.on("close", done);
      });
    },
  };
}
