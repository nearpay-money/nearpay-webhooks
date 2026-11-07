/**
 * Domain object → public object (lld/webhooks.md §4, §6 ingest). Pure.
 *
 * - Most types carry the domain object as it is; it must parse with the type's public schema.
 * - `review.opened` / `review.closed`: the bus `Review` is rendered with the spec's `toPublicReview()`
 *   into `PublicReview`; a review the spec does not make public (an execution review without
 *   `payment_intent`) is skipped (no public event, not a dead letter).
 * - Modes: a domain event carries its mode, except mode-less objects (`account.updated`: an account is
 *   neither test nor live; identity sends `livemode: null`), which become one public event per mode so
 *   test-mode and live-mode endpoints both receive them. Any other event without a mode is refused.
 * - INV-8: an object that states its own `livemode` must agree with the envelope's.
 */
import { WEBHOOK_TYPES, type WebhookType } from "@nearpay/spec";
import { Review, toPublicReview } from "@nearpay-internal/spec";

/** Public types whose object has no mode; delivered in both modes. */
export const MODELESS_TYPES: ReadonlySet<WebhookType> = new Set<WebhookType>(["account.updated"]);

/** Modes a domain event becomes public events in, or null when it must be refused. */
export function ingestModes(type: WebhookType, livemode: boolean | null): readonly boolean[] | null {
  if (livemode !== null) return [livemode];
  return MODELESS_TYPES.has(type) ? [false, true] : null;
}

export type PublicObject =
  | { readonly ok: Record<string, unknown> }
  | { readonly skip: string }
  | { readonly invalid: string };

const firstIssue = (e: { issues: readonly { message: string; path: readonly PropertyKey[] }[] }) => {
  const i = e.issues[0];
  return i ? `${i.path.map(String).join(".") || "(root)"}: ${i.message}` : "invalid";
};

/** The public object of a domain event's `data.object` in one mode. */
export function publicObjectOf(type: WebhookType, object: unknown, livemode: boolean): PublicObject {
  let candidate: unknown = object;
  if (type === "review.opened" || type === "review.closed") {
    const review = Review.safeParse(object);
    if (!review.success) return { invalid: `data.object is not a valid bus Review: ${firstIssue(review.error)}` };
    const rendered = toPublicReview(review.data, livemode);
    if (!rendered) return { skip: `review ${review.data.id} of a ${review.data.subject.type} is not public` };
    candidate = rendered;
  }
  const parsed = WEBHOOK_TYPES[type].object.safeParse(candidate);
  if (!parsed.success) return { invalid: `data.object is not a valid ${type} object: ${firstIssue(parsed.error)}` };
  const own = (candidate as { livemode?: unknown }).livemode;
  if (typeof own === "boolean" && own !== livemode)
    return { invalid: `data.object.livemode (${own}) disagrees with the envelope (${livemode})` };
  return { ok: candidate as Record<string, unknown> };
}
