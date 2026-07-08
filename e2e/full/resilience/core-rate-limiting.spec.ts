/* eslint-disable @typescript-eslint/no-explicit-any -- window.electron is untyped in Playwright evaluate() */
import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { T_SETTLE } from "../../helpers/timeouts";

let ctx: AppContext;
let repoPath: string;
let fixtureCleanup: (() => void) | undefined;

const TERMINAL_SPAWN_BURST = 6;
const MAX_QUEUE_DEPTH = 50;

async function resetRateLimits(app: AppContext["app"]): Promise<void> {
  await app.evaluate(() => {
    const fn = (globalThis as any).__daintreeResetRateLimits;
    if (!fn)
      throw new Error("Rate limit reset not available — launch with DAINTREE_E2E_FAULT_MODE=1");
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
    ({ dir: repoPath, cleanup: fixtureCleanup } = createFixtureRepo({ name: "rate-limit-test" }));
    ctx = await launchApp({ env: { DAINTREE_E2E_FAULT_MODE: "1" } });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, repoPath, "RateLimitTest");
  });

  test.beforeEach(async () => {
    // The onboarding flow consumes spawn slots and leaves the rate limiter in
    // a non-empty state. Reset before each test so the slot-count assertions
    // start from a clean baseline.
    await resetRateLimits(ctx.app);
    await ctx.window.waitForTimeout(T_SETTLE);
  });

  test.afterEach(async () => {
    await resetRateLimits(ctx.app);
    // Brief settle for pending rejections
    await ctx.window.waitForTimeout(T_SETTLE);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("spawn queue overflow returns 'Spawn queue full' error", async () => {
    test.slow();

    // Fire enough concurrent terminal spawn calls from the renderer to exceed
    // the burst-token-bucket limit:
    // - Requests 1–6: consume the interactive burst immediately
    // - Requests 7–56: queue up as pending (MAX_QUEUE_DEPTH = 50)
    // - Request 57: overflows the queue -> immediate "Spawn queue full" rejection
    //
    // resetRateLimits below drains the 50 pending so Promise.all can settle.
    await ctx.window.evaluate((cwd) => {
      const calls = Array.from({ length: 57 }, () =>
        (window as any).electron.terminal
          .spawn({ cols: 80, rows: 24, cwd })
          .then((id: string) => ({ status: "fulfilled" as const, id }))
          .catch((err: Error) => ({ status: "rejected" as const, message: err.message }))
      );
      (window as any).__rateLimitTestResults = Promise.all(calls);
    }, repoPath);

    // Drain queued requests from the main process so the pending promises
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

    // At least the burst calls should succeed immediately.
    expect(fulfilled.length).toBeGreaterThanOrEqual(TERMINAL_SPAWN_BURST);

    // At least 1 rejection should be "Spawn queue full" (the overflow).
    const queueFullErrors = rejected.filter((r) => r.message.includes("Spawn queue full"));
    expect(queueFullErrors.length).toBeGreaterThanOrEqual(1);

    // Every rejection should be either the overflow or a shutdown drain.
    const shutdownErrors = rejected.filter((r) => r.message.includes("App is shutting down"));
    expect(shutdownErrors.length + queueFullErrors.length).toBe(rejected.length);

    // Clean up spawned terminals
    const spawnedIds = fulfilled.map((r) => (r as any).id as string);
    await killTerminals(ctx.window, spawnedIds);
  });

  test("operations recover after rate limit state is reset", async () => {
    test.slow();

    // Start seven spawns concurrently. The first six consume the interactive
    // burst; the seventh must queue behind the strict 1s interval.
    const queuedResult = await ctx.window.evaluate(
      async ({ cwd, raceMs }) => {
        const burstSpawns = Array.from({ length: 6 }, () =>
          (window as any).electron.terminal.spawn({
            cols: 80,
            rows: 24,
            cwd,
          })
        );
        const queuedSpawn = (window as any).electron.terminal
          .spawn({ cols: 80, rows: 24, cwd })
          .then((id: string) => ({ resolved: true as const, id }));
        // Prevent unhandled rejection when resetRateLimits drains this promise
        queuedSpawn.catch(() => {});
        (window as any).__rateLimitRecoveryInitialSpawns = Promise.allSettled([
          ...burstSpawns,
          queuedSpawn,
        ]);
        const raceResult = await Promise.race([
          queuedSpawn,
          new Promise<{ resolved: false }>((resolve) =>
            setTimeout(() => resolve({ resolved: false }), raceMs)
          ),
        ]);
        return raceResult;
      },
      { cwd: repoPath, raceMs: 250 }
    );

    expect(queuedResult.resolved).toBe(false);

    // Reset rate limit state (simulates the 30s window expiring)
    await resetRateLimits(ctx.app);

    const initialIds: string[] = await ctx.window.evaluate(async () => {
      const results = await (window as any).__rateLimitRecoveryInitialSpawns;
      return results
        .filter((r: PromiseSettledResult<string>) => r.status === "fulfilled")
        .map((r: PromiseFulfilledResult<string>) => r.value);
    });

    // Now a spawn should succeed immediately
    const recoveryId: string = await ctx.window.evaluate(async (cwd) => {
      return await (window as any).electron.terminal.spawn({
        cols: 80,
        rows: 24,
        cwd,
      });
    }, repoPath);

    expect(recoveryId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    // Clean up
    await killTerminals(ctx.window, [...initialIds, recoveryId]);
  });

  test("drainRateLimitQueues rejects pending requests with shutdown message", async () => {
    test.slow();

    // Consume the six-call burst.
    const slotIds: string[] = await ctx.window.evaluate(async (cwd) => {
      return await Promise.all(
        Array.from({ length: 6 }, () =>
          (window as any).electron.terminal.spawn({
            cols: 80,
            rows: 24,
            cwd,
          })
        )
      );
    }, repoPath);

    // Start 5 additional spawns that will queue (won't resolve until slots open)
    await ctx.window.evaluate((cwd) => {
      const calls = Array.from({ length: 5 }, () =>
        (window as any).electron.terminal
          .spawn({
            cols: 80,
            rows: 24,
            cwd,
          })
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

    // Clean up the successfully spawned burst terminals
    await killTerminals(ctx.window, slotIds);
  });
});
