/** Domain → public objects of the Stage 2 types (lld/webhooks.md §4): refunds, reviews, account.updated. */
import { API_VERSION, Event, PublicReview, Refund } from "@nearpay/spec";
import { newId, uuidv7 } from "@nearpay-internal/ids";
import { account } from "@nearpay-internal/testing";
import { describe, expect, it } from "vitest";
import { objectSequence } from "../../src/app/events.js";
import { ingestModes, MODELESS_TYPES, publicObjectOf } from "../../src/domain/event/public.js";
import { canonicalEvent } from "../../src/domain/event/render.js";
import { refund, review } from "../support/fixtures.js";

describe("modes", () => {
  it("keeps the envelope's mode; only mode-less types without one go to both modes", () => {
    expect(ingestModes("refund.created", false)).toEqual([false]);
    expect(ingestModes("refund.created", true)).toEqual([true]);
    expect(ingestModes("refund.created", null)).toBeNull();
    expect(ingestModes("review.opened", null)).toBeNull();
    expect(ingestModes("account.updated", null)).toEqual([false, true]);
    expect(ingestModes("account.updated", true)).toEqual([true]);
    expect([...MODELESS_TYPES]).toEqual(["account.updated"]);
  });
});

describe("refunds", () => {
  it("passes every refund status through as the public Refund, keeping its sequence", () => {
    for (const status of ["requires_action", "pending", "succeeded", "failed", "canceled"] as const) {
      const r = refund({ status, sequence: 6 });
      const p = publicObjectOf(`refund.${status}`, r, false);
      expect(p).toEqual({ ok: r });
      expect(objectSequence((p as { ok: unknown }).ok, 2)).toBe(6);
    }
    expect(publicObjectOf("refund.created", refund(), false)).toMatchObject({ ok: { object: "refund" } });
  });

  it("refuses an invalid refund and one whose mode disagrees with the envelope (INV-8)", () => {
    expect(publicObjectOf("refund.created", { ...refund(), amount: 5 }, false)).toMatchObject({
      invalid: expect.stringMatching(/not a valid refund.created object: amount/),
    });
    expect(publicObjectOf("refund.succeeded", refund({ livemode: false }), true)).toMatchObject({
      invalid: expect.stringMatching(/livemode \(false\) disagrees with the envelope \(true\)/),
    });
  });
});

describe("reviews (toPublicReview)", () => {
  it("renders a bus Review into PublicReview with unix times and the envelope's mode", () => {
    const rv = review({ status: "closed", closed_at: "2026-11-07T11:00:00.000Z" });
    const p = publicObjectOf("review.closed", rv, true);
    expect(p).toEqual({
      ok: {
        id: rv.id,
        object: "review",
        created: Math.floor(Date.parse("2026-11-07T10:00:00.000Z") / 1000),
        livemode: true,
        subject: rv.subject,
        reason: "post_screen_hit",
        status: "closed",
        closed_at: Math.floor(Date.parse("2026-11-07T11:00:00.000Z") / 1000),
      },
    });
    expect(PublicReview.safeParse((p as { ok: unknown }).ok).success).toBe(true);
    expect((p as { ok: object }).ok).not.toHaveProperty("account_id");
  });

  it("shows an execution review as one of its payment intent; without one it is not public", () => {
    const pi = newId("pi");
    expect(
      publicObjectOf(
        "review.opened",
        review({ subject: { type: "execution", id: newId("ex") }, payment_intent: pi }),
        false,
      ),
    ).toMatchObject({ ok: { subject: { type: "payment_intent", id: pi } } });
    expect(
      publicObjectOf("review.opened", review({ subject: { type: "execution", id: newId("ex") } }), false),
    ).toMatchObject({ skip: expect.stringMatching(/is not public/) });
  });

  it("refuses an object that is not a bus Review (a PublicReview included)", () => {
    expect(publicObjectOf("review.opened", { id: "nope" }, false)).toMatchObject({
      invalid: expect.stringMatching(/not a valid bus Review/),
    });
    const already = publicObjectOf("review.opened", review(), false) as { ok: unknown };
    expect(publicObjectOf("review.opened", already.ok, false)).toHaveProperty("invalid");
  });
});

describe("account.updated", () => {
  it("passes the public Account through in either mode (it has no livemode of its own)", () => {
    const a = account({ kyb_status: "approved", live_enabled: true });
    expect(publicObjectOf("account.updated", a, false)).toEqual({ ok: a });
    expect(publicObjectOf("account.updated", a, true)).toEqual({ ok: a });
    expect(publicObjectOf("account.updated", { ...a, status: 7 }, true)).toHaveProperty("invalid");
  });
});

describe("rendering of the Stage 2 types", () => {
  it("builds events that parse with the spec Event (sequence injected where the object has none)", () => {
    const cases = [
      { type: "refund.pending", data: refund({ status: "pending", sequence: 3 }), seq: 3 },
      { type: "account.updated", data: account(), seq: 8 },
      { type: "review.opened", data: (publicObjectOf("review.opened", review(), false) as { ok: object }).ok, seq: 2 },
    ];
    for (const c of cases) {
      const e = canonicalEvent(
        {
          id: uuidv7(),
          type: c.type,
          livemode: false,
          object_sequence: c.seq,
          data: c.data as Record<string, unknown>,
          previous: null,
          request: null,
          created_at: new Date(),
        },
        API_VERSION,
      );
      expect((e.data.object as { sequence: number }).sequence, c.type).toBe(c.seq);
      const r = Event.safeParse(e);
      expect(r.success, `${c.type}: ${r.success ? "" : r.error.issues[0]?.message}`).toBe(true);
    }
    expect(Refund.safeParse(refund()).success).toBe(true);
  });
});
