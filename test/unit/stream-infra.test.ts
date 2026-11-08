/**
 * Events stream infrastructure (lld/webhooks.md §5.1): the kit SSE stream the route opens with
 * `ctx.sse(limits)` (kit ≥ 0.3.1: limits, slow-reader destroy, `drain()`), per-replica slots, LISTEN hub
 * dispatch.
 */
import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { openSse, resumeCursor, type SseLimits } from "@nearpay-internal/service";
import { describe, expect, it } from "vitest";
import type { EventStreamSink } from "../../src/app/stream.js";
import { type ListenPool, pgNotifyHub, pollingOnlyHub } from "../../src/infra/notify-hub.js";
import { localStreamSlots, valkeyStreamSlots } from "../../src/infra/stream-slots.js";

/** A response whose client reads nothing unless the test says so. */
class FakeRes extends EventEmitter {
  writableLength = 0;
  writableNeedDrain = false;
  destroyed = false;
  ended = false;
  writes: string[] = [];
  writeHead() {
    return this;
  }
  write(chunk: string) {
    this.writes.push(chunk);
    return true;
  }
  end() {
    this.ended = true;
    this.emit("close");
  }
  destroy() {
    this.destroyed = true;
    this.emit("close");
  }
}

const any = { safeParse: (data: unknown) => ({ success: true as const, data }) };

/** What the route does: `ctx.sse(limits)` → kit `openSse` on the raw response. */
function open(limits: SseLimits, heartbeatSeconds = 0.02): { s: EventStreamSink; res: FakeRes } {
  const res = new FakeRes();
  const def = { heartbeatSeconds, retryMs: 3000, events: { ready: any, event: any, reset: any } };
  const s = openSse(res as never, def as never, {}, limits) as EventStreamSink;
  return { s, res };
}

describe("resumeCursor (kit)", () => {
  it("prefers Last-Event-ID over starting_after and ignores blanks", () => {
    expect(resumeCursor({ "last-event-id": "evt_a" }, "evt_b")).toBe("evt_a");
    expect(resumeCursor({ "last-event-id": "  " }, "evt_b")).toBe("evt_b");
    expect(resumeCursor({ "last-event-id": ["evt_c"] })).toBe("evt_c");
    expect(resumeCursor({}, " ")).toBeUndefined();
    expect(resumeCursor({})).toBeUndefined();
  });
});

describe("kit event stream with the stream's limits", () => {
  it("passes frames through and closes after maxDurationMs", async () => {
    const { s, res } = open({ maxDurationMs: 30 });
    expect(s.send("ready", { x: 1 })).toBe(true);
    expect(res.writes.some((w) => w.includes("event: ready"))).toBe(true);
    await s.done;
    expect(s.closed).toBe(true);
    expect(res.ended).toBe(true);
    expect(s.send("event", {}, "evt_1")).toBe(false);
  });

  it("closes (destroys) a client that stays slow, keeps one that catches up", async () => {
    const slow = open({ maxBufferedBytes: 10, slowClientMs: 40 });
    slow.res.writableLength = 100;
    expect(slow.s.buffered).toBe(100);
    await sleep(150);
    expect(slow.s.closed).toBe(true);
    expect(slow.res.destroyed).toBe(true);

    const ok = open({ maxBufferedBytes: 10, slowClientMs: 80 });
    ok.res.writableLength = 100;
    await sleep(40);
    ok.res.writableLength = 0;
    await sleep(120);
    expect(ok.s.closed).toBe(false);
    ok.s.close();
    expect(ok.s.closed).toBe(true);
    expect(ok.res.destroyed).toBe(false);
    expect(ok.res.ended).toBe(true);
  });

  it("a close with more than maxBufferedBytes unsent (duration, shutdown) destroys instead of ending", async () => {
    const { s, res } = open({ maxBufferedBytes: 10, maxDurationMs: 30 }, 10);
    res.writableLength = 100;
    await s.done;
    expect(res.destroyed).toBe(true);
    expect(res.ended).toBe(false);
  });

  it("drain waits only after a write that needs draining: resolves on drain or on close", async () => {
    const { s, res } = open({}, 10);
    await s.drain();
    res.writableLength = 5; // queued below the high-water mark: no 'drain' will come
    await s.drain();
    res.writableNeedDrain = true;
    const p = s.drain();
    res.writableNeedDrain = false;
    res.emit("drain");
    await p;
    res.writableNeedDrain = true;
    const q = s.drain();
    s.close();
    await q;
    await s.drain(); // closed
    let called = false;
    s.onClose(() => {
      called = true;
    });
    expect(called).toBe(true);
  });
});

describe("stream slots", () => {
  it("allows max streams per (account, mode) in a replica and frees them on release", async () => {
    const slots = localStreamSlots(2);
    const a = await slots.acquire("acc", false);
    const b = await slots.acquire("acc", false);
    expect(a && b).toBeTruthy();
    expect(await slots.acquire("acc", false)).toBeNull();
    expect(await slots.acquire("acc", true)).not.toBeNull(); // other mode
    expect(await slots.acquire("other", false)).not.toBeNull();
    await a?.refresh();
    await a?.release();
    await a?.release(); // idempotent
    expect(await slots.acquire("acc", false)).not.toBeNull();
    expect(await slots.acquire("acc", false)).toBeNull();
    expect(slots.shared()).toBe(false);
    await slots.close();
  });

  it("falls back to the per-replica limit without a Valkey URL", async () => {
    const slots = valkeyStreamSlots(undefined, 1, 30_000);
    expect(await slots.acquire("acc", false)).not.toBeNull();
    expect(await slots.acquire("acc", false)).toBeNull();
  });
});

describe("LISTEN hub", () => {
  it("wakes the subscribers of the notified account and mode only", () => {
    const pool: ListenPool = { connect: () => Promise.reject(new Error("no db")) };
    const hub = pgNotifyHub(pool);
    const calls: string[] = [];
    const off = hub.subscribe("acc", false, () => calls.push("test"));
    hub.subscribe("acc", true, () => calls.push("live"));
    hub.subscribe("other", false, () => calls.push("other"));
    hub.dispatch("events_false", "acc");
    hub.dispatch("events_true", "acc");
    hub.dispatch("events_maybe", "acc");
    hub.dispatch("events_false", undefined);
    expect(calls).toEqual(["test", "live"]);
    off();
    off();
    hub.dispatch("events_false", "acc");
    expect(calls).toEqual(["test", "live"]);
    expect(hub.listening()).toBe(false);
  });

  it("listens on both channels, retries a failed connection and stops cleanly", async () => {
    const queries: string[] = [];
    let attempts = 0;
    const client = new EventEmitter() as EventEmitter & { query(q: string): Promise<void>; release(): void };
    client.query = async (q: string) => {
      queries.push(q);
    };
    let released = 0;
    client.release = () => {
      released++;
    };
    const pool = {
      connect: async () => {
        attempts++;
        if (attempts === 1) throw new Error("down");
        return client;
      },
    } as unknown as ListenPool;
    const errors: unknown[] = [];
    const hub = pgNotifyHub(pool, (e) => errors.push(e), 10);
    const woke: number[] = [];
    hub.subscribe("acc", true, () => woke.push(1));
    const task = await hub.task.start();
    expect(errors).toHaveLength(1);
    await sleep(50);
    expect(hub.listening()).toBe(true);
    expect(queries).toEqual(["listen events_true", "listen events_false"]);
    client.emit("notification", { channel: "events_true", payload: "acc" });
    expect(woke).toEqual([1]);
    client.emit("error", new Error("reset"));
    expect(hub.listening()).toBe(false);
    expect(released).toBe(1);
    await sleep(50);
    expect(hub.listening()).toBe(true);
    await task.stop();
    expect(hub.listening()).toBe(false);
    expect(pollingOnlyHub().subscribe("a", false, () => {})).toBeTypeOf("function");
    expect(pollingOnlyHub().listening()).toBe(false);
  });
});
