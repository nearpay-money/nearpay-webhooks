/** Event subscriptions of an endpoint (lld/webhooks.md §5–§6). */
import { WEBHOOK_TYPE_NAMES } from "@nearpay/spec";

const KNOWN = new Set<string>(WEBHOOK_TYPE_NAMES);

/** Public types a merchant may subscribe to (`ping` is sent by `…/test` regardless of subscriptions). */
export const SUBSCRIBABLE: readonly string[] = WEBHOOK_TYPE_NAMES.filter((t) => t !== "ping");

export type EnabledEvents = { ok: string[] } | { unknown: string };

/**
 * Validates and normalises `enabled_events`: `*` anywhere means all events (stored as `["*"]`);
 * duplicates are dropped; the order is kept. An entry that is not a webhook type is reported.
 */
export function normalizeEnabledEvents(list: readonly string[]): EnabledEvents {
  if (list.includes("*")) return { ok: ["*"] };
  const out: string[] = [];
  for (const t of list) {
    if (!KNOWN.has(t)) return { unknown: t };
    if (!out.includes(t)) out.push(t);
  }
  return { ok: out };
}

/** True when an endpoint with these subscriptions receives `type`. */
export function subscribes(enabled: readonly string[], type: string): boolean {
  return enabled.includes("*") || enabled.includes(type);
}
