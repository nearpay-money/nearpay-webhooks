/**
 * Ingest consumers (lld/webhooks.md §4, §6), run by `webhooks-ingest`: every subject the event catalogue
 * routes to webhooks (payments checkout sessions and payment intents, agentpay agent payments) becomes
 * a public event plus one pending delivery per subscribed endpoint, in the inbox transaction of the
 * domain event (duplicates are skipped twice over: inbox and `events.source_event_id`).
 *
 * | Subject                                           | Public type                     |
 * |---------------------------------------------------|---------------------------------|
 * | evt.payments.checkout_session.{completed,expired} | checkout.session.<same>         |
 * | evt.payments.payment_intent.{created,processing,  | payment_intent.<same>           |
 * |   succeeded,payment_failed,requires_review,       |                                 |
 * |   overpaid,canceled}                              |                                 |
 * | evt.agentpay.agent_payment.{settled,failed}       | agent_payment.<same>            |
 */
import type { Envelope, EventHandler } from "@nearpay-internal/bus";
import { deadLetterSink, inboxHandler, type Kysely } from "@nearpay-internal/db";
import { SUBJECTS, type Subject } from "@nearpay-internal/spec";
import type { Tx, Webhooks } from "../app/context.js";
import { ingest } from "../app/events.js";
import { publicType } from "../domain/event/render.js";
import type { DB } from "../infra/db/schema.js";

/** Catalogue subjects consumed by webhooks (Stage 1). */
export const INGESTED: readonly Subject[] = (Object.keys(SUBJECTS) as Subject[]).filter(
  (s) => (SUBJECTS[s].consumers as readonly string[]).includes("webhooks") && SUBJECTS[s].stage <= 1,
);

export function webhooksHandlers(w: Webhooks, db: Kysely<DB> = w.db): Partial<Record<Subject, EventHandler>> {
  const handler = inboxHandler(db, async (tx: Tx, e: Envelope) => {
    await ingest(w, tx, e);
  });
  const handlers: Partial<Record<Subject, EventHandler>> = {};
  for (const s of INGESTED) {
    if (!publicType(s)) throw new Error(`${s} is routed to webhooks but has no public event type`);
    handlers[s] = handler;
  }
  return handlers;
}

export const deadLetters = (db: Kysely<DB>) => deadLetterSink(db, "consumer:webhooks");
