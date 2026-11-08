/**
 * A model of ingest + the events stream's live tail (lld/webhooks.md §5.1) on a virtual clock, for the
 * property tests: ingest gives each event a UUIDv7 id when it builds the row (`gen`), inserts it at once
 * (`inserted_at = gen`) and commits `tx` ms later; the stream polls the way `src/app/stream.ts` does
 * (rows past the settle window: `late` behind the cursor minus already-sent ids, `forward` above it).
 */
import { SETTLE_MS, TailState, uuidFloor } from "../../src/domain/stream/tail.js";

export interface SimEvent {
  readonly id: string;
  readonly gen: number;
  readonly commit: number;
}

/** A UUIDv7-shaped id at `ms`; `seq` orders ids of the same millisecond. */
export function v7(ms: number, seq: number): string {
  const h = uuidFloor(ms).replace(/-/g, "").slice(0, 12);
  const c = seq.toString(16).padStart(15, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${c.slice(0, 3)}-8${c.slice(3, 6)}-${c.slice(3, 15)}`;
}

export function events(gens: readonly number[], txs: readonly number[]): SimEvent[] {
  return gens.map((gen, i) => ({ id: v7(gen, i), gen, commit: gen + (txs[i] ?? 0) }));
}

/** Runs polls at `polls` (ascending virtual ms) from `origin`; returns the ids sent, in send order. */
export function simulate(evs: readonly SimEvent[], polls: readonly number[], origin: string, page = 100): string[] {
  const state = new TailState(origin);
  const out: string[] = [];
  const byId = [...evs].sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const t of polls) {
    for (let guard = 0; guard < 10_000; guard++) {
      const visible = byId.filter((e) => e.commit <= t && e.gen < t - SETTLE_MS);
      const floor = state.floor;
      const sent = new Set(state.sentAboveFloor);
      const late =
        floor < state.cursor
          ? visible.filter((e) => e.id > floor && e.id <= state.cursor && !sent.has(e.id)).slice(0, page)
          : [];
      const forward = visible.filter((e) => e.id > state.cursor).slice(0, page);
      for (const e of state.accept([...late, ...forward])) out.push(e.id);
      if (late.length < page && forward.length < page) break;
    }
  }
  return out;
}
