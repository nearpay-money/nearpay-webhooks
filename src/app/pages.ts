/**
 * Cursor pagination (api-conventions §2): newest first by `(created_at desc, id desc)`; ids are
 * UUIDv7, so id order is creation order. `starting_after` pages towards older objects;
 * `ending_before` returns the objects immediately newer than the cursor (still newest first).
 * `created[gte]` / `created[lte]` are unix seconds.
 */
import { isId, toUuid } from "@nearpay-internal/ids";
import { ApiError } from "@nearpay-internal/service";
import { type SelectQueryBuilder, sql } from "kysely";

export interface PageQuery {
  readonly limit: number;
  readonly starting_after?: string | undefined;
  readonly ending_before?: string | undefined;
  readonly "created[gte]"?: number | undefined;
  readonly "created[lte]"?: number | undefined;
}

export interface Page<R> {
  readonly rows: R[];
  readonly hasMore: boolean;
}

interface Keyed {
  id: string;
  created_at: Date;
}

export type IdPrefix = "we" | "evt" | "whd";

// biome-ignore lint/suspicious/noExplicitAny: works over any table with `id` and `created_at`
type Q<R> = SelectQueryBuilder<any, any, R>;

function cursor(v: string, prefix: IdPrefix, param: string): string {
  if (!isId(prefix, v)) throw ApiError.invalid(`${param} must be a ${prefix}_… id`, param);
  return toUuid(v, prefix);
}

/**
 * Keyset pagination on `(created_at desc, id desc)`, for tables whose ids are not all time-ordered
 * (deliveries created before step 1.4 have random UUIDs). The cursor row is looked up in SQL (no
 * millisecond truncation of `created_at`); `exists(uuid)` scopes cursors to the caller's rows.
 */
export async function pageByCreated<R extends Keyed>(
  base: Q<R>,
  q: Pick<PageQuery, "limit" | "starting_after" | "ending_before">,
  prefix: IdPrefix,
  table: string,
  exists: (uuid: string) => Promise<boolean>,
): Promise<Page<R>> {
  const key = sql`(${sql.ref(`${table}.created_at`)}, ${sql.ref(`${table}.id`)})`;
  const at = async (v: string, param: string) => {
    const uuid = cursor(v, prefix, param);
    if (!(await exists(uuid))) throw ApiError.invalid(`${param} is not an object of this list`, param);
    return sql`(select c.created_at, c.id from ${sql.table(table)} c where c.id = ${uuid}::uuid)`;
  };
  if (q.ending_before && !q.starting_after) {
    const after = await at(q.ending_before, "ending_before");
    const rows = (await base
      .where(sql<boolean>`${key} > ${after}`)
      .orderBy(`${table}.created_at`, "asc")
      .orderBy(`${table}.id`, "asc")
      .limit(q.limit + 1)
      .execute()) as R[];
    return { rows: rows.slice(0, q.limit).reverse(), hasMore: rows.length > q.limit };
  }
  let query = base;
  if (q.starting_after) query = query.where(sql<boolean>`${key} < ${await at(q.starting_after, "starting_after")}`);
  const rows = (await query
    .orderBy(`${table}.created_at`, "desc")
    .orderBy(`${table}.id`, "desc")
    .limit(q.limit + 1)
    .execute()) as R[];
  return { rows: rows.slice(0, q.limit), hasMore: rows.length > q.limit };
}

export async function pageOf<R extends Keyed>(
  base: Q<R>,
  q: PageQuery,
  prefix: IdPrefix,
  table: string,
): Promise<Page<R>> {
  let query = base;
  const col = (c: string) => `${table}.${c}`;
  if (q["created[gte]"] !== undefined) query = query.where(col("created_at"), ">=", new Date(q["created[gte]"] * 1000));
  if (q["created[lte]"] !== undefined)
    query = query.where(col("created_at"), "<", new Date((q["created[lte]"] + 1) * 1000));
  if (q.ending_before && !q.starting_after) {
    const rows = (await query
      .where(col("id"), ">", cursor(q.ending_before, prefix, "ending_before"))
      .orderBy(col("id"), "asc")
      .limit(q.limit + 1)
      .execute()) as R[];
    return { rows: rows.slice(0, q.limit).reverse(), hasMore: rows.length > q.limit };
  }
  if (q.starting_after) query = query.where(col("id"), "<", cursor(q.starting_after, prefix, "starting_after"));
  const rows = (await query
    .orderBy(col("id"), "desc")
    .limit(q.limit + 1)
    .execute()) as R[];
  return { rows: rows.slice(0, q.limit), hasMore: rows.length > q.limit };
}
