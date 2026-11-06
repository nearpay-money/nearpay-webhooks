/**
 * Stage 1 ops CLI (platform §3): `docker compose exec webhooks-api /nodejs/bin/node dist/ops.js
 * <command>`. Support tools; every command prints one JSON document (never a signing secret); errors
 * print `{"error": …}` and exit 1 (2: usage).
 */
import { parseArgs } from "node:util";
import { sql } from "@nearpay-internal/db";
import { fromUuid, isId, toUuid } from "@nearpay-internal/ids";
import { ApiError } from "@nearpay-internal/service";
import type { Webhooks } from "../app/context.js";
import { transition } from "../app/endpoints.js";
import { endpointView, eventView } from "../app/views.js";

export const USAGE = `usage: ops.js <command> [arguments]

  endpoint <we_…>                     endpoint (no secret), transitions and recent deliveries
  event <evt_…>                       event with its deliveries and attempts
  retry <evt_…> [--endpoint <we_…>]   send the event again now (deliveries not yet succeeded)
  enable <we_…>                       re-enable a disabled endpoint (clears the failure streak)
  backlog [--limit N]                 due deliveries: count, oldest, busiest endpoints`;

class UsageError extends Error {}

export interface OpsDeps {
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export async function runOps(argv: readonly string[], w: Webhooks, deps: OpsDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => process.stdout.write(`${l}\n`));
  const err = deps.err ?? ((l: string) => process.stderr.write(`${l}\n`));
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: { endpoint: { type: "string" }, limit: { type: "string" } },
    });
    const [cmd, ...args] = positionals;
    const result = await run(w, cmd, args, values);
    out(JSON.stringify(result, null, 2));
    return 0;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (
      e instanceof UsageError ||
      code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ||
      code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" ||
      code === "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL"
    ) {
      err(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
      return 2;
    }
    err(JSON.stringify({ error: e instanceof ApiError ? { code: e.code, message: e.message } : String(e) }));
    return 1;
  }
}

function idArg(v: string | undefined, prefix: "we" | "evt"): string {
  if (!v || !isId(prefix, v)) throw new UsageError(`expected a ${prefix}_… id`);
  return toUuid(v, prefix);
}

async function endpointRow(w: Webhooks, id: string) {
  const row = await w.db.selectFrom("webhook_endpoints").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row) throw ApiError.missing("webhook_endpoint", fromUuid("we", id));
  return row;
}

async function run(
  w: Webhooks,
  cmd: string | undefined,
  args: readonly string[],
  o: { endpoint?: string | undefined; limit?: string | undefined },
): Promise<unknown> {
  switch (cmd) {
    case "endpoint": {
      const id = idArg(args[0], "we");
      const row = await endpointRow(w, id);
      const [transitions, counts, recent] = await Promise.all([
        w.db
          .selectFrom("webhook_endpoint_transitions")
          .selectAll()
          .where("webhook_endpoint_id", "=", id)
          .orderBy("created_at", "asc")
          .execute(),
        w.db
          .selectFrom("deliveries")
          .select(["status", sql<string>`count(*)::text`.as("n")])
          .where("endpoint_id", "=", id)
          .groupBy("status")
          .execute(),
        w.db
          .selectFrom("deliveries")
          .selectAll()
          .where("endpoint_id", "=", id)
          .orderBy("created_at", "desc")
          .limit(10)
          .execute(),
      ]);
      return {
        endpoint: {
          ...endpointView(row),
          account: fromUuid("acct", row.account_id),
          last_success_at: row.last_success_at,
          failing_since: row.failing_since,
          deleted_at: row.deleted_at,
        },
        deliveries: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
        recent,
        transitions,
      };
    }
    case "event": {
      const id = idArg(args[0], "evt");
      const ev = await w.db.selectFrom("events").selectAll().where("id", "=", id).executeTakeFirst();
      if (!ev) throw ApiError.missing("event", args[0] as string);
      const deliveries = await w.db.selectFrom("deliveries").selectAll().where("event_id", "=", id).execute();
      const attempts = deliveries.length
        ? await w.db
            .selectFrom("delivery_attempts")
            .selectAll()
            .where(
              "delivery_id",
              "in",
              deliveries.map((d) => d.id),
            )
            .orderBy("started_at", "asc")
            .execute()
        : [];
      return {
        event: eventView(ev),
        account: fromUuid("acct", ev.account_id),
        source_event_id: ev.source_event_id,
        deliveries: deliveries.map((d) => ({
          ...d,
          endpoint: fromUuid("we", d.endpoint_id),
          attempts_log: attempts.filter((a) => a.delivery_id === d.id),
        })),
      };
    }
    case "retry": {
      const id = idArg(args[0], "evt");
      let q = w.db
        .updateTable("deliveries")
        .set({ status: "pending", next_attempt_at: new Date(w.now()) })
        .where("event_id", "=", id)
        .where("status", "!=", "succeeded");
      if (o.endpoint) q = q.where("endpoint_id", "=", idArg(o.endpoint, "we"));
      const r = await q.executeTakeFirst();
      return { requeued: Number(r.numUpdatedRows) };
    }
    case "enable": {
      const id = idArg(args[0], "we");
      return w.db.transaction().execute(async (tx) => {
        const cur = await tx
          .selectFrom("webhook_endpoints")
          .selectAll()
          .where("id", "=", id)
          .forUpdate()
          .executeTakeFirst();
        if (!cur || cur.deleted_at) throw ApiError.missing("webhook_endpoint", args[0] as string);
        if (cur.status === "enabled") return { endpoint: endpointView(cur), changed: false };
        const row = await tx
          .updateTable("webhook_endpoints")
          .set({
            status: "enabled",
            disabled_reason: null,
            failing_since: null,
            updated_at: new Date(w.now()),
            version: cur.version + 1,
          })
          .where("id", "=", id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await transition(tx, id, cur.status, "enabled", "ops_enabled", "ops:cli");
        return { endpoint: endpointView(row), changed: true };
      });
    }
    case "backlog": {
      const limit = o.limit ? Number(o.limit) : 10;
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new UsageError("--limit must be 1–1000");
      const now = new Date(w.now());
      const total = await sql<{ n: string; oldest: Date | null }>`
        select count(*)::text as n, min(next_attempt_at) as oldest from deliveries
        where status in ('pending', 'failed') and next_attempt_at <= ${now}`.execute(w.db);
      const busiest = await sql<{ endpoint_id: string; n: string }>`
        select endpoint_id, count(*)::text as n from deliveries
        where status in ('pending', 'failed')
        group by endpoint_id order by count(*) desc limit ${limit}`.execute(w.db);
      return {
        due: Number(total.rows[0]?.n ?? 0),
        oldest_due: total.rows[0]?.oldest ?? null,
        undelivered_by_endpoint: busiest.rows.map((r) => ({
          endpoint: fromUuid("we", r.endpoint_id),
          undelivered: Number(r.n),
        })),
      };
    }
    default:
      throw new UsageError(cmd ? `unknown command ${cmd}` : "missing command");
  }
}
