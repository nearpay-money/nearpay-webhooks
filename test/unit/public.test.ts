/**
 * Domain → public objects (lld/webhooks.md §4): Stage 2 refunds, reviews, account.updated; Stage 3 billing
 * invoices and subscriptions; Stage 4 mandates.
 */

import { newId, uuidv7 } from "@nearpay-internal/ids";
import { InvoiceEvent, SUBJECTS } from "@nearpay-internal/spec";
import { account } from "@nearpay-internal/testing";
import { API_VERSION, Event, PublicReview, Refund, SUBJECT_TO_WEBHOOK_TYPE, WEBHOOK_TYPES } from "@nearpay-money/spec";
import { describe, expect, it } from "vitest";
import { objectSequence } from "../../src/app/events.js";
import {
  INVOICE_TYPES,
  ingestModes,
  livemodeConflict,
  MODELESS_TYPES,
  publicObjectOf,
} from "../../src/domain/event/public.js";
import { canonicalEvent, publicType } from "../../src/domain/event/render.js";
import { invoice, mandate, refund, review, subscription } from "../support/fixtures.js";

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
      invalid: expect.stringMatching(/data\.object\.livemode disagrees with the envelope \(livemode true\)/),
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

describe("Stage 3 billing types", () => {
  const INVOICE_EVENTS = [
    "created",
    "finalized",
    "sent",
    "paid",
    "payment_failed",
    "overdue",
    "voided",
    "marked_uncollectible",
  ] as const;
  const SUBSCRIPTION_EVENTS = ["created", "updated", "deleted", "renewal_upcoming"] as const;

  it("maps the 12 billing subjects to invoice.* and customer.subscription.*, never invoice.reminder", () => {
    for (const e of INVOICE_EVENTS) expect(publicType(`evt.billing.invoice.${e}`)).toBe(`invoice.${e}`);
    for (const e of SUBSCRIPTION_EVENTS)
      expect(publicType(`evt.billing.subscription.${e}`)).toBe(`customer.subscription.${e}`);
    expect(publicType("evt.billing.invoice.reminder")).toBeNull();
    const billing = Object.keys(SUBJECT_TO_WEBHOOK_TYPE).filter(
      (s) => s.startsWith("evt.billing.") && !s.startsWith("evt.billing.mandate."),
    );
    expect(billing).toHaveLength(12);
    for (const s of billing) expect(SUBJECTS[s as keyof typeof SUBJECTS].consumers).toContain("webhooks");
    expect([...INVOICE_TYPES].sort()).toEqual(INVOICE_EVENTS.map((e) => `invoice.${e}`).sort());
  });

  it("passes a bus InvoiceEvent through as the public Invoice in its mode, keeping its sequence", () => {
    for (const e of INVOICE_EVENTS) {
      const inv = invoice({ livemode: true, sequence: 4 });
      expect(InvoiceEvent.safeParse(inv).success).toBe(true);
      const p = publicObjectOf(`invoice.${e}`, inv, true);
      expect(p, e).toEqual({ ok: inv });
      expect(objectSequence((p as { ok: unknown }).ok, 1)).toBe(4);
    }
  });

  it("refuses an invoice that carries its hosted URL (the invoice secret never leaves billing)", () => {
    const leaked = { ...invoice(), hosted_invoice_url: "https://pay.nearpay.money/i/in_x#secret" };
    expect(publicObjectOf("invoice.finalized", leaked, false)).toEqual({
      invalid: "data.object.hosted_invoice_url must be null on the bus (it embeds the invoice secret)",
    });
    expect(publicObjectOf("invoice.paid", invoice({ livemode: false }), true)).toMatchObject({
      invalid: expect.stringMatching(/livemode disagrees/),
    });
    expect(publicObjectOf("invoice.paid", { ...invoice(), total: -1 }, false)).toMatchObject({
      invalid: expect.stringMatching(/not a valid invoice.paid object: total/),
    });
  });

  it("passes subscriptions through; a nested price in the other mode is refused (INV-8)", () => {
    for (const e of SUBSCRIPTION_EVENTS) {
      const sub = subscription({ livemode: true });
      expect(publicObjectOf(`customer.subscription.${e}`, sub, true)).toEqual({ ok: sub });
    }
    const sub = subscription({ livemode: true });
    const mixed = { ...sub, items: [{ ...sub.items[0], price: { ...sub.items[0]?.price, livemode: false } }] };
    expect(publicObjectOf("customer.subscription.updated", mixed, true)).toEqual({
      invalid: "data.object.items[0].price.livemode disagrees with the envelope (livemode true)",
    });
  });

  it("renders every billing type as a spec Event", () => {
    const types = Object.keys(WEBHOOK_TYPES).filter((t) => t.startsWith("invoice.") || t.startsWith("customer."));
    expect(types).toHaveLength(12);
    for (const type of types) {
      const data = type.startsWith("invoice.") ? invoice({ sequence: 2 }) : subscription({ sequence: 2 });
      const e = canonicalEvent(
        {
          id: uuidv7(),
          type,
          livemode: false,
          object_sequence: 2,
          data: data as unknown as Record<string, unknown>,
          previous: type.endsWith(".updated") ? { status: "trialing" } : null,
          request: null,
          created_at: new Date(),
        },
        API_VERSION,
      );
      const r = Event.safeParse(e);
      expect(r.success, `${type}: ${r.success ? "" : r.error.issues[0]?.message}`).toBe(true);
    }
  });
});

describe("Stage 4 mandate types", () => {
  const MANDATE_EVENTS = [
    "activated",
    "collected",
    "insufficient_funds",
    "canceled",
    "exhausted",
    "updated",
    "unlinked",
    "released",
  ] as const;

  it("maps the 8 mandate subjects to mandate.* (the vault's raw events stay internal)", () => {
    for (const e of MANDATE_EVENTS) expect(publicType(`evt.billing.mandate.${e}`)).toBe(`mandate.${e}`);
    const mandates = Object.keys(SUBJECT_TO_WEBHOOK_TYPE).filter((s) => s.startsWith("evt.billing.mandate."));
    expect(mandates.sort()).toEqual(MANDATE_EVENTS.map((e) => `evt.billing.mandate.${e}`).sort());
    for (const s of mandates) expect(SUBJECTS[s as keyof typeof SUBJECTS].consumers).toContain("webhooks");
    expect(publicType("evt.rails.vault.event")).toBeNull();
  });

  it("passes a Mandate through in its mode, keeping its sequence", () => {
    for (const livemode of [false, true])
      for (const e of MANDATE_EVENTS) {
        const m = mandate({ livemode, sequence: 9 });
        const p = publicObjectOf(`mandate.${e}`, m, livemode);
        expect(p, e).toEqual({ ok: m });
        expect(objectSequence((p as { ok: unknown }).ok, 1)).toBe(9);
      }
  });

  it("refuses a mandate in the other mode than its envelope (nested-livemode guard, INV-8) or off-contract", () => {
    expect(publicObjectOf("mandate.activated", mandate({ livemode: false }), true)).toEqual({
      invalid: "data.object.livemode disagrees with the envelope (livemode true)",
    });
    expect(publicObjectOf("mandate.collected", { ...mandate(), balance: "-1" }, false)).toMatchObject({
      invalid: expect.stringMatching(/not a valid mandate.collected object: balance/),
    });
    expect(publicObjectOf("mandate.updated", { ...mandate(), object: "invoice" }, false)).toMatchObject({
      invalid: expect.stringMatching(/not a valid mandate.updated object/),
    });
  });

  it("renders every mandate type as a spec Event (with previous attributes for updates)", () => {
    const types = Object.keys(WEBHOOK_TYPES).filter((t) => t.startsWith("mandate."));
    expect(types.sort()).toEqual(MANDATE_EVENTS.map((e) => `mandate.${e}`).sort());
    for (const type of types) {
      const e = canonicalEvent(
        {
          id: uuidv7(),
          type,
          livemode: true,
          object_sequence: 2,
          data: mandate({ livemode: true }) as unknown as Record<string, unknown>,
          previous: type === "mandate.updated" ? { balance: "75000000" } : null,
          request: null,
          created_at: new Date(),
        },
        API_VERSION,
      );
      const r = Event.safeParse(e);
      expect(r.success, `${type}: ${r.success ? "" : r.error.issues[0]?.message}`).toBe(true);
    }
  });
});

describe("livemodeConflict", () => {
  it("finds the first nested livemode that disagrees, ignoring non-boolean values", () => {
    expect(livemodeConflict({ livemode: true }, true)).toBeNull();
    expect(livemodeConflict({ livemode: "no" }, true)).toBeNull();
    expect(livemodeConflict({ a: [{ b: { livemode: false } }] }, true)).toBe("a[0].b.livemode");
    expect(livemodeConflict([{ livemode: true }, { livemode: false }], true)).toBe("[1].livemode");
    expect(livemodeConflict(null, true)).toBeNull();
    expect(livemodeConflict("x", false)).toBeNull();
  });
});
