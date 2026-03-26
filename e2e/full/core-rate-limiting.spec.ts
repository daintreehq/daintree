/* eslint-disable @typescript-eslint/no-explicit-any -- window.electron is untyped in Playwright evaluate() */
import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";

let ctx: AppContext;
let repoPath: string;

async function resetRateLimits(app: AppContext["app"]): Promise<void> {
  await app.evaluate(() => {
    const fn = (globalThis as any).__canopyResetRateLimits;
    if (!fn)
      throw new Error("Rate limit reset not available — launch with CANOPY_E2E_FAULT_MODE=1");
    fn();
  });
}

async function killTerminals(page: AppContext["window"], ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await page.evaluate(async (terminalIds) => {
    for (const id of terminalIds) {
      try {
        await (window as any).electron.terminal.kill(id);
      } catch {
        // already dead
      }
    }
  }, ids);
}

test.describe.serial("Core: Rate Limiting", () => {
  test.beforeAll(async () => {
    repoPath = createFixtureRepo({ name: "rate-limit-test" });
    ctx = await launchApp({ env: { CANOPY_E2E_FAULT_MODE: "1" } });
    await openAndOnboardProject(ctx.app, ctx.window, repoPath, "RateLimitTest");
  });

  test.afterEach(async () => {
    await resetRateLimits(ctx.app);
    // Brief settle for pending rejections
    await ctx.window.waitForTimeout(200);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("spawn queue overflow returns 'Spawn queue full' error", async () => {
    test.slow();

    // Fire 61 concurrent terminal spawn calls from the renderer.
    // - First 10 consume rate limit slots (succeed immediately)
    // - Next 50 queue (pending promises)
    // - 61st overflows the queue → immediate "Spawn queue full" rejection
    //
    // We store the Promise.allSettled result on a window global so we can
    // drain the queue from the main process and then collect results.
    await ctx.window.evaluate((cwd) => {
      const calls = Array.from({ length: 61 }, () =>
        (window as any).electron.terminal
          .spawn({ cols: 80, rows: 24, cwd })
          .then((id: string) => ({ status: "fulfilled" as const, id }))
          .catch((err: Error) => ({ status: "rejected" as const, message: err.message }))
      );
      (window as any).__rateLimitTestResults = Promise.all(calls);
    }, repoPath);

    // Drain queued requests from the main process so the 50 pending promises
    // reject with "App is shutting down" and Promise.all can settle.
    await resetRateLimits(ctx.app);

    // Collect results
    const results: Array<
      { status: "fulfilled"; id: string } | { status: "rejected"; message: string }
    > = await ctx.window.evaluate(async () => {
      return await (window as any).__rateLimitTestResults;
    });

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    // Exactly 10 should succeed (rate limit slots)
    expect(fulfilled.length).toBe(10);

    // At least 1 rejection should be "Spawn queue full" (the overflow)
    const queueFullErrors = rejected.filter((r) => r.message.includes("Spawn queue full"));
    expect(queueFullErrors.length).toBe(1);

    // The remaining rejections are "App is shutting down" from drainRateLimitQueues
    const shutdownErrors = rejected.filter((r) => r.message.includes("App is shutting down"));
    expect(shutdownErrors.length + queueFullErrors.length).toBe(rejected.length);

    // Clean up spawned terminals
    const spawnedIds = fulfilled.map((r) => (r as any).id as string);
    await killTerminals(ctx.window, spawnedIds);
  });

  test("operations recover after rate limit state is reset", async () => {
    // Exhaust the 10-slot rate limit
    const initialIds: string[] = await ctx.window.evaluate(async (cwd) => {
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        const id = await (window as any).electron.terminal.spawn({
          cols: 80,
          rows: 24,
          cwd,
        });
        ids.push(id);
      }
      return ids;
    }, repoPath);

    expect(initialIds.length).toBe(10);

    // Next spawn would queue (not reject) — verify it doesn't resolve immediately
    // by racing it against a short timeout.
    const queuedResult = await ctx.window.evaluate(async (cwd) => {
      const spawnPromise = (window as any).electron.terminal
        .spawn({ cols: 80, rows: 24, cwd })
        .then((id: string) => ({ resolved: true as const, id }));
      // Prevent unhandled rejection when resetRateLimits drains this promise
      spawnPromise.catch(() => {});
      const raceResult = await Promise.race([
        spawnPromise,
        new Promise<{ resolved: false }>((resolve) =>
          setTimeout(() => resolve({ resolved: false }), 500)
        ),
      ]);
      return raceResult;
    }, repoPath);

    expect(queuedResult.resolved).toBe(false);

    // Reset rate limit state (simulates the 30s window expiring)
    await resetRateLimits(ctx.app);

    // Now a spawn should succeed immediately
    const recoveryId: string = await ctx.window.evaluate(async (cwd) => {
      return await (window as any).electron.terminal.spawn({
        cols: 80,
        rows: 24,
        cwd,
      });
    }, repoPath);

    expect(typeof recoveryId).toBe("string");
    expect(recoveryId.length).toBeGreaterThan(0);

    // Clean up
    await killTerminals(ctx.window, [...initialIds, recoveryId]);
  });

  test("drainRateLimitQueues rejects pending requests with shutdown message", async () => {
    test.slow();

    // Fill 10 rate limit slots
    const slotIds: string[] = await ctx.window.evaluate(async (cwd) => {
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        const id = await (window as any).electron.terminal.spawn({
          cols: 80,
          rows: 24,
          cwd,
        });
        ids.push(id);
      }
      return ids;
    }, repoPath);

    // Start 5 additional spawns that will queue (won't resolve until slots open)
    await ctx.window.evaluate((cwd) => {
      const calls = Array.from({ length: 5 }, () =>
        (window as any).electron.terminal
          .spawn({ cols: 80, rows: 24, cwd })
          .then((id: string) => ({ status: "fulfilled" as const, id }))
          .catch((err: Error) => ({ status: "rejected" as const, message: err.message }))
      );
      (window as any).__drainTestResults = Promise.all(calls);
    }, repoPath);

    // Drain queues — this rejects all pending with "App is shutting down"
    await resetRateLimits(ctx.app);

    const results: Array<
      { status: "fulfilled"; id: string } | { status: "rejected"; message: string }
    > = await ctx.window.evaluate(async () => {
      return await (window as any).__drainTestResults;
    });

    // All 5 queued requests should have been rejected
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected.length).toBe(5);

    // Each rejection should mention "App is shutting down"
    for (const r of rejected) {
      expect(r.message).toContain("App is shutting down");
    }

    // Clean up the 10 successfully spawned terminals
    await killTerminals(ctx.window, slotIds);
  });
});
