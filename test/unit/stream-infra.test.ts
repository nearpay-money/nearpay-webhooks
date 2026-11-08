/** Events stream adapters (lld/webhooks.md §5.1): kit SSE adapter, per-replica slots, LISTEN hub dispatch. */
import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import type { RequestContext, SseStream } from "@nearpay-internal/service";
import { describe, expect, it } from "vitest";
import { openEventStream, resumeCursor } from "../../src/api/sse.js";
import { type ListenPool, pgNotifyHub, pollingOnlyHub } from "../../src/infra/notify-hub.js";
import { localStreamSlots, valkeyStreamSlots } from "../../src/infra/stream-slots.js";

class FakeRes extends EventEmitter {
  writableLength = 0;
  writableNeedDrain = false;
  destroyed = false;
  destroy() {
    this.destroyed = true;
  }
}

function fakeCtx(heartbeatSeconds = 0.02) {
  const res = new FakeRes();
  const listeners: (() => void)[] = [];
  let closed = false;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });
  const sent: unknown[] = [];
  const sse: SseStream = {
    send(event, data, id) {
      if (closed) return false;
      sent.push({ event, data, id });
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const fn of listeners.splice(0)) fn();
      res.emit("close");
      resolveDone();
    },
    get closed() {
      return closed;
    },
    done,
    onClose(fn) {
      if (closed) fn();
      else listeners.push(fn);
    },
  };
  const ctx = {
    sse: () => sse,
    reply: { raw: res },
    route: { stream: { heartbeatSeconds } },
  } as unknown as RequestContext<never>;
  return { ctx, res, sse, sent };
}

describe("resumeCursor (kit 0.3.0 semantics)", () => {
  it("prefers Last-Event-ID over starting_after and ignores blanks", () => {
    expect(resumeCursor({ "last-event-id": "evt_a" }, "evt_b")).toBe("evt_a");
    expect(resumeCursor({ "last-event-id": "  " }, "evt_b")).toBe("evt_b");
    expect(resumeCursor({ "last-event-id": ["evt_c"] })).toBe("evt_c");
    expect(resumeCursor({}, " ")).toBeUndefined();
    expect(resumeCursor({})).toBeUndefined();
  });
});

describe("openEventStream (kit 0.3.0 limits on kit 0.2.1)", () => {
  it("passes frames through and closes after maxDurationMs", async () => {
    const { ctx, sent } = fakeCtx();
    const s = openEventStream(ctx, { maxDurationMs: 30 });
    expect(s.send("ready", { x: 1 })).toBe(true);
    expect(sent).toHaveLength(1);
    await s.done;
    expect(s.closed).toBe(true);
    expect(s.send("event", {}, "evt_1")).toBe(false);
  });

  it("closes a client that stays slow, keeps one that catches up", async () => {
    const slow = fakeCtx();
    const a = openEventStream(slow.ctx, { maxBufferedBytes: 10, slowClientMs: 40 });
    slow.res.writableLength = 100;
    expect(a.buffered).toBe(100);
    await sleep(150);
    expect(a.closed).toBe(true);
    expect(slow.res.destroyed).toBe(true);

    const ok = fakeCtx();
    const b = openEventStream(ok.ctx, { maxBufferedBytes: 10, slowClientMs: 80 });
    ok.res.writableLength = 100;
    await sleep(40);
    ok.res.writableLength = 0;
    await sleep(120);
    expect(b.closed).toBe(false);
    b.close();
    expect(b.closed).toBe(true);
    expect(ok.res.destroyed).toBe(false);
  });

  it("drain waits only after a write that needs draining: resolves on drain or on close", async () => {
    const { ctx, res } = fakeCtx(10);
    const s = openEventStream(ctx, {});
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
