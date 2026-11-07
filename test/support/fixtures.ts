/**
 * Stage 2 test objects kit 0.1.2 has no factory for: the public `Refund` and the bus `Review`. Each is
 * parsed by its spec schema, so a test cannot build an object that violates the contract.
 */
import { Refund } from "@nearpay/spec";
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
