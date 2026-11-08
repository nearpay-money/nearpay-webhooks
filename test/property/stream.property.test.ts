/**
 * Events stream live tail (lld/webhooks.md §5.1): over random ingest timings (ids generated in order,
 * transactions committing out of order) and random poll instants, the 2 s settle window and the 10 s
 * re-read behind the cursor give
 * - exactly the committed events, in id order, when every transaction is shorter than the settle window;
 * - every event exactly once (order may differ) when transactions take up to 10 s;
 * - never a duplicate, never an id at or below the origin, whatever the timings.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { REREAD_MS, SETTLE_MS, uuidFloor } from "../../src/domain/stream/tail.js";
import { events, simulate } from "../support/tail-sim.js";

const START = 1_793_800_000_000;

const timeline = (maxTx: number) =>
  fc
    .record({
      steps: fc.array(fc.integer({ min: 0, max: 1_500 }), { minLength: 1, maxLength: 80 }),
      txs: fc.array(fc.integer({ min: 0, max: maxTx }), { minLength: 80, maxLength: 80 }),
      jitter: fc.array(fc.integer({ min: 0, max: 999 }), { minLength: 0, maxLength: 40 }),
      page: fc.integer({ min: 1, max: 7 }),
    })
    .map(({ steps, txs, jitter, page }) => {
      let t = START + 10;
      const gens = steps.map((s) => (t += s));
      const evs = events(gens, txs);
      const end = Math.max(...evs.map((e) => e.commit)) + SETTLE_MS + REREAD_MS + 3_000;
      // a poll every second plus NOTIFY-style early wakes
      const polls: number[] = [];
      for (let p = START; p <= end; p += 1_000) polls.push(p);
      for (const j of jitter) polls.push(START + ((j * 997) % (end - START)));
      polls.sort((a, b) => a - b);
      return { evs, polls, page };
    });

describe("events stream live tail", () => {
  it("streams every event once and in id order while transactions are shorter than the settle window", () => {
    fc.assert(
      fc.property(timeline(SETTLE_MS - 1), ({ evs, polls, page }) => {
        const sent = simulate(evs, polls, uuidFloor(START), page);
        expect(sent).toEqual(evs.map((e) => e.id).sort());
      }),
      { numRuns: 300 },
    );
  });

  it("streams every event exactly once when transactions take up to 10 s", () => {
    fc.assert(
      fc.property(timeline(10_000), ({ evs, polls, page }) => {
        const sent = simulate(evs, polls, uuidFloor(START), page);
        expect(new Set(sent).size).toBe(sent.length);
        expect([...sent].sort()).toEqual(evs.map((e) => e.id).sort());
      }),
      { numRuns: 300 },
    );
  });

  it("never sends an id twice or one at or below the origin, whatever the timings", () => {
    fc.assert(
      fc.property(timeline(60_000), fc.integer({ min: 0, max: 20_000 }), ({ evs, polls, page }, offset) => {
        const origin = uuidFloor(START + offset);
        const sent = simulate(evs, polls, origin, page);
        expect(new Set(sent).size).toBe(sent.length);
        for (const id of sent) expect(id > origin).toBe(true);
        const all = new Set(evs.map((e) => e.id));
        for (const id of sent) expect(all.has(id)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});
