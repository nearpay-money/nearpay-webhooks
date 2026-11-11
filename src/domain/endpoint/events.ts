/** Event subscriptions of an endpoint (lld/webhooks.md §5–§6). */
import { WEBHOOK_TYPE_NAMES } from "@nearpay-money/spec";

const KNOWN = new Set<string>(WEBHOOK_TYPE_NAMES);

/** Public types a merchant may subscribe to (`ping` is sent by `…/test` regardless of subscriptions). */
export const SUBSCRIBABLE: readonly string[] = WEBHOOK_TYPE_NAMES.filter((t) => t !== "ping");

export type EnabledEvents = { ok: string[] } | { unknown: string; index: number };

/**
 * Validates and normalises `enabled_events`: every entry must be `*` or a webhook type (since spec
 * 0.1.5 request validation lets any string through, so this is the only check; the first unknown entry
 * is reported, even next to `*`); `*` anywhere means all events (stored as `["*"]`); duplicates are
 * dropped; the order is kept.
 */
export function normalizeEnabledEvents(list: readonly string[]): EnabledEvents {
  const index = list.findIndex((t) => t !== "*" && !KNOWN.has(t));
  if (index >= 0) return { unknown: list[index] as string, index };
  if (list.includes("*")) return { ok: ["*"] };
  return { ok: [...new Set(list)] };
}

/** True when an endpoint with these subscriptions receives `type`. */
export function subscribes(enabled: readonly string[], type: string): boolean {
  return enabled.includes("*") || enabled.includes(type);
}
