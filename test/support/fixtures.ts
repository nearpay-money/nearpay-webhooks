/**
 * Test objects the kit has no factory for: the public `Refund`, the bus `Review` (Stage 2) and the public
 * `Invoice` / `Subscription` (Stage 3). Each is
 * parsed by its spec schema, so a test cannot build an object that violates the contract.
 */
import { Invoice, Refund, Subscription } from "@nearpay/spec";
import { newId } from "@nearpay-internal/ids";
import { Review } from "@nearpay-internal/spec";
import { USDC_BASE, USDC_NEAR } from "@nearpay-internal/testing";
import type { z } from "zod";

type RefundT = z.infer<typeof Refund>;
type ReviewT = z.input<typeof Review>;

const unix = () => Math.floor(Date.now() / 1000);

export function refund(over: Partial<RefundT> = {}): RefundT {
  return Refund.parse({
    id: newId("re"),
    object: "refund",
    created: unix(),
    livemode: false,
    status: "requires_action",
    payment_intent: newId("pi"),
    payment_attempt: newId("pa"),
    amount: "2000000",
    asset_id: USDC_NEAR,
    decimals: 6,
    fee_mode: "payer_absorbs",
    reason: "requested_by_customer",
    method: "route_quote",
    recipient: {
      address: "0x1111111111111111111111111111111111111111",
      asset_id: USDC_BASE,
      chain: "eip155:8453",
      type: "origin_chain",
      overridden: false,
    },
    next_action: null,
    legs: [],
    amount_received: null,
    evidence: null,
    extra_amount_sent: "0",
    source: "api",
    failure_code: null,
    succeeded_at: null,
    canceled_at: null,
    sequence: 1,
    metadata: {},
    ...over,
  });
}

/** A bus `Review` (`evt.compliance.review.*`), before webhooks renders it with `toPublicReview`. */
export function review(over: Partial<ReviewT> = {}): z.output<typeof Review> {
  return Review.parse({
    id: newId("case"),
    object: "review",
    account_id: newId("acct"),
    subject: { type: "payment_intent", id: newId("pi") },
    reason: "post_screen_hit",
    status: "open",
    opened_at: "2026-11-07T10:00:00.000Z",
    closed_at: null,
    ...over,
  });
}

// stage 3 — billing: the public `Invoice` (as billing's `InvoiceEvent`, `hosted_invoice_url` null) and
// `Subscription`, parsed by their spec schemas.
type InvoiceT = z.infer<typeof Invoice>;
type SubscriptionT = z.infer<typeof Subscription>;

export function invoice(over: Partial<InvoiceT> = {}): InvoiceT {
  const created = unix();
  const id = over.id ?? newId("in");
  return Invoice.parse({
    id,
    object: "invoice",
    created,
    livemode: false,
    status: "open",
    number: "ACME-00001",
    customer: newId("cus"),
    subscription: null,
    billing_reason: "manual",
    collection_method: "send_invoice",
    currency: "usd",
    asset_id: null,
    description: null,
    footer: null,
    lines: [
      {
        id: newId("il"),
        object: "line_item",
        type: "invoiceitem",
        price: null,
        product: null,
        subscription_item: null,
        description: "Consulting",
        quantity: 2,
        unit_amount: 5000,
        amount: 10000,
        amount_excluding_tax: 10000,
        tax_rates: [],
        tax_amounts: [],
        period: null,
      },
    ],
    default_tax_rates: [],
    subtotal: 10000,
    tax: 0,
    total: 10000,
    total_excluding_tax: 10000,
    total_tax_amounts: [],
    amount_due: 10000,
    amount_paid: 0,
    amount_remaining: 10000,
    days_until_due: 30,
    due_date: created + 30 * 86_400,
    period_start: null,
    period_end: null,
    settlement_destination: null,
    reminder_days: [-3, 0, 1, 3, 7],
    reminders_sent: 0,
    next_reminder_at: null,
    hosted_invoice_url: null,
    invoice_pdf: `https://api.nearpay.money/v1/invoices/${id}/pdf`,
    checkout_session: null,
    payment_intent: null,
    payment_intents: [],
    status_transitions: {
      finalized_at: created,
      sent_at: null,
      paid_at: null,
      voided_at: null,
      marked_uncollectible_at: null,
    },
    uncollectible_reason: null,
    metadata: {},
    sequence: 1,
    ...over,
  });
}

export function subscription(over: Partial<SubscriptionT> = {}): SubscriptionT {
  const created = unix();
  const livemode = over.livemode ?? false;
  return Subscription.parse({
    id: newId("sub"),
    object: "subscription",
    created,
    livemode,
    customer: newId("cus"),
    status: "active",
    collection_method: "send_invoice",
    items: [
      {
        id: newId("si"),
        object: "subscription_item",
        price: {
          id: newId("price"),
          object: "price",
          created,
          livemode,
          product: newId("prod"),
          active: true,
          type: "recurring",
          unit_amount: 2000,
          currency: "usd",
          asset_id: null,
          recurring: { interval: "month", interval_count: 1 },
          nickname: null,
          metadata: {},
        },
        quantity: 1,
        tax_rates: null,
      },
    ],
    currency: "usd",
    asset_id: null,
    recurring: { interval: "month", interval_count: 1 },
    billing_cycle_anchor: created,
    current_period_start: created,
    current_period_end: created + 30 * 86_400,
    days_until_due: 7,
    default_tax_rates: [],
    dunning: { reminder_days: [-3, 0, 1, 3, 7], on_exhausted: "cancel" },
    trial_start: null,
    trial_end: null,
    cancel_at_period_end: false,
    canceled_at: null,
    ended_at: null,
    cancellation_reason: null,
    latest_invoice: null,
    settlement_destination: null,
    description: null,
    metadata: {},
    sequence: 1,
    ...over,
  });
}
