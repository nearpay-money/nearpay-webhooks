/** Events stream rules (lld/webhooks.md §5.1): types filter, resume outcome, UUIDv7 bounds, tail bookkeeping. */

import { uuidv7 } from "@nearpay-internal/ids";
import { EVENT_STREAM_MAX_CONCURRENT, EVENT_STREAM_MAX_SECONDS } from "@nearpay-money/spec";
import { describe, expect, it } from "vitest";
import {
  MAX_DURATION_MS,
  MAX_STREAMS,
  parseStreamTypes,
  REREAD_MS,
  resumeOutcome,
  TailState,
  typeFilter,
  uuidFloor,
  uuidTimeMs,
} from "../../src/domain/stream/tail.js";
import { v7 } from "../support/tail-sim.js";

const DAY = 86_400_000;

describe("types filter", () => {
  it("defaults to every type and normalises like enabled_events", () => {
    expect(parseStreamTypes(undefined)).toEqual({ ok: ["*"] });
    expect(parseStreamTypes("*")).toEqual({ ok: ["*"] });
    expect(parseStreamTypes("invoice.paid,ping,invoice.paid")).toEqual({ ok: ["invoice.paid", "ping"] });
    expect(parseStreamTypes("customer.subscription.created,*")).toEqual({ ok: ["*"] });
  });

  it("reports the first entry that is not a webhook type (case-sensitive, even next to *)", () => {
    expect(parseStreamTypes("payment_intent.succeeded,Invoice.paid")).toEqual({ unknown: "Invoice.paid", index: 1 });
    expect(parseStreamTypes("*,nope")).toEqual({ unknown: "nope", index: 1 });
    expect(parseStreamTypes("invoice.paid,,invoice.sent")).toEqual({ unknown: "", index: 1 });
    expect(parseStreamTypes("invoice.reminder")).toEqual({ unknown: "invoice.reminder", index: 0 });
  });

  it("filters by type only without *", () => {
    expect(typeFilter(["*"])).toBeNull();
    expect(typeFilter(["invoice.paid"])).toEqual(["invoice.paid"]);
  });
});

describe("resume outcome", () => {
  const now = Date.parse("2026-11-08T12:00:00Z");
  it("replays from an event of this account and mode inside retention", () => {
    expect(resumeOutcome({ created_at: new Date(now - DAY) }, uuidv7(), now, 30 * DAY)).toEqual({ kind: "replay" });
    expect(resumeOutcome({ created_at: new Date(now - 30 * DAY) }, uuidv7(), now, 30 * DAY)).toEqual({
      kind: "replay",
    });
  });
  it("resets with cursor_expired for an old event, or a missing id older than retention (purged)", () => {
    expect(resumeOutcome({ created_at: new Date(now - 31 * DAY) }, uuidv7(), now, 30 * DAY)).toEqual({
      kind: "reset",
      reason: "cursor_expired",
    });
    expect(resumeOutcome(null, v7(now - 40 * DAY, 1), now, 30 * DAY)).toEqual({
      kind: "reset",
      reason: "cursor_expired",
    });
  });
  it("resets with cursor_unknown for any other id (other account or mode, random UUID)", () => {
    expect(resumeOutcome(null, v7(now - DAY, 1), now, 30 * DAY)).toEqual({ kind: "reset", reason: "cursor_unknown" });
    expect(resumeOutcome(null, "4f1c2b3a-0000-4000-8000-000000000000", now, 30 * DAY)).toEqual({
      kind: "reset",
      reason: "cursor_unknown",
    });
  });
});

describe("UUIDv7 bounds", () => {
  it("reads the millisecond time of a v7 id and nothing else", () => {
    const t = Date.parse("2026-11-08T12:00:00.123Z");
    expect(uuidTimeMs(v7(t, 5))).toBe(t);
    expect(uuidTimeMs(v7(t, 5).toUpperCase())).toBe(t);
    expect(uuidTimeMs("4f1c2b3a-0000-4000-8000-000000000000")).toBeNull();
    expect(uuidTimeMs("nope")).toBeNull();
    const id = uuidv7();
    expect(Math.abs((uuidTimeMs(id) as number) - Date.now())).toBeLessThan(60_000);
  });
  it("floors sort at or below every id of that millisecond and above earlier ones", () => {
    const t = Date.parse("2026-11-08T12:00:00.123Z");
    expect(uuidFloor(t) <= v7(t, 0)).toBe(true);
    expect(uuidFloor(t) > v7(t - 1, 0xfff)).toBe(true);
    expect(uuidFloor(-5)).toBe("00000000-0000-0000-0000-000000000000");
    expect(uuidTimeMs(uuidFloor(t).replace("-0000-0000", "-7000-8000"))).toBe(t);
  });
});

describe("TailState", () => {
  const t0 = Date.parse("2026-11-08T12:00:00Z");
  it("sends in id order above the origin, never twice, and advances the cursor", () => {
    const s = new TailState(uuidFloor(t0));
    const [a, b, c] = [v7(t0 + 1, 1), v7(t0 + 2, 2), v7(t0 + 3, 3)];
    expect(s.accept([{ id: b }, { id: a }]).map((r) => r.id)).toEqual([a, b]);
    expect(s.cursor).toBe(b);
    expect(s.accept([{ id: a }, { id: c }, { id: c }]).map((r) => r.id)).toEqual([c]);
    expect(s.accept([{ id: v7(t0 - 1, 0) }])).toEqual([]);
    expect(s.sentAboveFloor).toEqual([a, b, c]);
  });

  it("keeps sent ids only inside the re-read window, and the floor never drops below the origin", () => {
    const origin = v7(t0, 0);
    const s = new TailState(origin);
    expect(s.floor).toBe(origin);
    const early = v7(t0 + 1_000, 1);
    s.accept([{ id: early }]);
    expect(s.floor).toBe(origin);
    const late = v7(t0 + 1_000 + REREAD_MS + 500, 2);
    s.accept([{ id: late }]);
    expect(s.floor).toBe(uuidFloor(t0 + 1_500));
    expect(s.sentAboveFloor).toEqual([late]);
    // a late-committed row inside the window is still sent, once
    const between = v7(t0 + 2_000, 3);
    expect(s.accept([{ id: between }]).map((r) => r.id)).toEqual([between]);
    expect(s.accept([{ id: between }])).toEqual([]);
    expect(s.cursor).toBe(late);
  });

  it("uses the origin as the floor for a non-v7 cursor", () => {
    const s = new TailState("00000000-0000-0000-0000-000000000000");
    expect(s.floor).toBe(s.origin);
  });
});

describe("limits come from the spec", () => {
  it("5 streams per account and mode, 1 h per stream", () => {
    expect(MAX_STREAMS).toBe(EVENT_STREAM_MAX_CONCURRENT);
    expect(MAX_DURATION_MS).toBe(EVENT_STREAM_MAX_SECONDS * 1000);
  });
});
