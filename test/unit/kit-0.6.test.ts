import { describe, expect, it } from "vitest";
import type { Webhooks } from "../../src/app/context.js";
import { DISPATCHER_MAX_SILENCE_MS, type Dispatcher, dispatcherTask } from "../../src/dispatcher/dispatcher.js";
import { runOps } from "../../src/ops/cli.js";

describe("kit 0.6.0 adoption", () => {
  it("the dispatcher declares a liveness budget and beats every iteration, failed claims included", async () => {
    const quiet = { error() {}, warn() {}, info() {} };
    const d = {
      w: { log: quiet, now: () => Date.now() },
      settings: { concurrency: 2, pollMs: 5, timeoutMs: 1_000, leaseMs: 1_000 },
    } as unknown as Dispatcher;
    const task = dispatcherTask(d);
    expect(task.maxSilenceMs).toBe(DISPATCHER_MAX_SILENCE_MS);
    let beats = 0;
    const running = await task.start({ beat: () => void beats++, idle: () => {} });
    await new Promise((r) => setTimeout(r, 60));
    await running.stop();
    expect(beats).toBeGreaterThan(1);
  });

  it("ops CLI routes dead-letters/outbox to the kit and prints its usage on a bad sub-command", async () => {
    const errs: string[] = [];
    const w = { db: {} } as unknown as Webhooks;
    expect(await runOps(["dead-letters", "replay"], w, { err: (l) => errs.push(l), out: () => {} })).toBe(2);
    expect(await runOps(["outbox", "skip", "x"], w, { err: (l) => errs.push(l), out: () => {} })).toBe(2);
    expect(errs.join("\n")).toContain("outbox show [--limit <n>]");
  });
});
