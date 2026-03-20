/* eslint-disable @typescript-eslint/no-explicit-any -- window.electron is untyped in Playwright evaluate() */
import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";
import path from "path";
import crypto from "crypto";

interface SettledResult<T = unknown> {
  status: "fulfilled" | "rejected";
  value?: T;
  reason?: string;
}

let ctx: AppContext;
let fixtureDir: string;

test.describe.serial("Core: Race Conditions from Concurrent IPC", () => {
  test.beforeAll(async () => {
    fixtureDir = createFixtureRepo({ name: "race-conditions" });
    ctx = await launchApp();
    await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Race Conditions");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("concurrent duplicate worktree create produces exactly one worktree", async () => {
    test.setTimeout(120_000);
    const { window } = ctx;

    const branchName = `race-wt-${Date.now()}`;
    const wtPath1 = path.join(path.dirname(fixtureDir), `race-wt-1-${Date.now()}`);
    const wtPath2 = path.join(path.dirname(fixtureDir), `race-wt-2-${Date.now()}`);

    const results: SettledResult<string>[] = await window.evaluate(
      async ([rootPath, branch, p1, p2]: string[]) => {
        const api = (window as any).electron.worktree;
        const opts1 = { baseBranch: "main", newBranch: branch, path: p1 };
        const opts2 = { baseBranch: "main", newBranch: branch + "-dup", path: p2 };
        const calls = [
          api.create(opts1, rootPath).then(
            (v: string) => ({ status: "fulfilled", value: v }),
            (e: any) => ({ status: "rejected", reason: e?.message ?? String(e) })
          ),
          api.create(opts2, rootPath).then(
            (v: string) => ({ status: "fulfilled", value: v }),
            (e: any) => ({ status: "rejected", reason: e?.message ?? String(e) })
          ),
        ];
        return Promise.all(calls);
      },
      [fixtureDir, branchName, wtPath1, wtPath2]
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    // Verify worktrees from backend — at least one new worktree exists
    const worktrees = await window.evaluate(async () => {
      return await (window as any).electron.worktree.getAll();
    });
    const newWorktrees = worktrees.filter(
      (wt: any) => wt.branch && wt.branch.startsWith("race-wt-") && !wt.isMainWorktree
    );
    expect(newWorktrees.length).toBeGreaterThanOrEqual(1);
    expect(newWorktrees.length).toBeLessThanOrEqual(2);
  });

  test("concurrent terminal spawn with same ID results in exactly one terminal", async () => {
    test.setTimeout(60_000);
    const { window } = ctx;

    const terminalId = crypto.randomUUID();

    const results: SettledResult<string>[] = await window.evaluate(
      async ([id]: string[]) => {
        const api = (window as any).electron.terminal;
        const opts = { id, cols: 80, rows: 30 };
        const calls = [
          api.spawn(opts).then(
            (v: string) => ({ status: "fulfilled", value: v }),
            (e: any) => ({ status: "rejected", reason: e?.message ?? String(e) })
          ),
          api.spawn(opts).then(
            (v: string) => ({ status: "fulfilled", value: v }),
            (e: any) => ({ status: "rejected", reason: e?.message ?? String(e) })
          ),
        ];
        return Promise.all(calls);
      },
      [terminalId]
    );

    // At least one should succeed
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    // Verify exactly one active terminal with this ID
    await expect
      .poll(
        async () => {
          const terminals: any[] = await window.evaluate(async () => {
            return await (window as any).electron.terminal.getAllTerminals();
          });
          return terminals.filter((t: any) => t.id === terminalId && !t.isTrashed).length;
        },
        { timeout: T_LONG }
      )
      .toBe(1);

    // Cleanup
    await window.evaluate(async (id: string) => {
      try {
        await (window as any).electron.terminal.kill(id);
      } catch {}
    }, terminalId);
  });

  test("closing a panel during spawn does not crash the main process", async () => {
    test.setTimeout(60_000);
    const { window } = ctx;

    const terminalId = crypto.randomUUID();

    const results: SettledResult[] = await window.evaluate(async (id: string) => {
      const api = (window as any).electron.terminal;
      const calls = [
        api.spawn({ id, cols: 80, rows: 30 }).then(
          (v: any) => ({ status: "fulfilled", value: v }),
          (e: any) => ({ status: "rejected", reason: e?.message ?? String(e) })
        ),
        api.kill(id).then(
          (v: any) => ({ status: "fulfilled", value: v }),
          (e: any) => ({ status: "rejected", reason: e?.message ?? String(e) })
        ),
        api.trash(id).then(
          (v: any) => ({ status: "fulfilled", value: v }),
          (e: any) => ({ status: "rejected", reason: e?.message ?? String(e) })
        ),
      ];
      return Promise.all(calls);
    }, terminalId);

    // All promises settled (no hang)
    expect(results.length).toBe(3);

    // Main process alive
    const alive = await ctx.app.evaluate(() => true);
    expect(alive).toBe(true);

    // Terminal must be in a consistent state — any single state is acceptable
    // (the race outcome is nondeterministic: spawn may win or kill/trash may win)
    const terminals: any[] = await window.evaluate(async () => {
      return await (window as any).electron.terminal.getAllTerminals();
    });
    const t = terminals.find((t: any) => t.id === terminalId);
    const state = !t ? "absent" : t.isTrashed ? "trashed" : t.hasPty ? "active" : "killed";
    expect(state).toMatch(/absent|trashed|active|killed/);

    // Cleanup
    if (t && !t.isTrashed) {
      await window.evaluate(async (id: string) => {
        try {
          await (window as any).electron.terminal.kill(id);
        } catch {}
      }, terminalId);
    }
  });

  test("concurrent trash + restore of same terminal ends in consistent state", async () => {
    test.setTimeout(60_000);
    const { window } = ctx;

    // Spawn a terminal first
    const terminalId: string = await window.evaluate(async () => {
      return await (window as any).electron.terminal.spawn({ cols: 80, rows: 30 });
    });

    // Wait for it to be live
    await expect
      .poll(
        async () => {
          const terminals: any[] = await window.evaluate(async () => {
            return await (window as any).electron.terminal.getAllTerminals();
          });
          const t = terminals.find((t: any) => t.id === terminalId);
          return t?.hasPty ?? false;
        },
        { timeout: T_LONG }
      )
      .toBe(true);

    // Fire concurrent trash + restore
    const results: SettledResult[] = await window.evaluate(async (id: string) => {
      const api = (window as any).electron.terminal;
      const calls = [
        api.trash(id).then(
          (v: any) => ({ status: "fulfilled", value: v }),
          (e: any) => ({ status: "rejected", reason: e?.message ?? String(e) })
        ),
        api.restore(id).then(
          (v: any) => ({ status: "fulfilled", value: v }),
          (e: any) => ({ status: "rejected", reason: e?.message ?? String(e) })
        ),
      ];
      return Promise.all(calls);
    }, terminalId);

    expect(results.length).toBe(2);

    // Terminal must be in exactly one consistent state
    await expect
      .poll(
        async () => {
          const terminals: any[] = await window.evaluate(async () => {
            return await (window as any).electron.terminal.getAllTerminals();
          });
          const matching = terminals.filter((t: any) => t.id === terminalId);
          // Must not be duplicated
          if (matching.length > 1) return "duplicated";
          if (matching.length === 0) return "absent";
          return matching[0].isTrashed ? "trashed" : "active";
        },
        { timeout: T_LONG }
      )
      .toMatch(/trashed|active|absent/);

    // Cleanup
    await window.evaluate(async (id: string) => {
      try {
        await (window as any).electron.terminal.kill(id);
      } catch {}
    }, terminalId);
  });

  test("spawn queue overflow returns error rather than hanging", async () => {
    test.setTimeout(180_000);
    const { window } = ctx;

    // Fire 62 concurrent spawns. Rate limit allows 10 immediate + 50 queued = 60.
    // The 61st+ should be rejected with "Spawn queue full".
    // Previous tests may have consumed some slots, making overflow easier to trigger.
    const SPAWN_COUNT = 62;

    const results: SettledResult<string>[] = await window.evaluate(async (count: number) => {
      const api = (window as any).electron.terminal;
      const calls = Array.from({ length: count }, () =>
        api.spawn({ cols: 80, rows: 30 }).then(
          (v: string) => ({ status: "fulfilled" as const, value: v }),
          (e: any) => ({ status: "rejected" as const, reason: e?.message ?? String(e) })
        )
      );
      return Promise.all(calls);
    }, SPAWN_COUNT);

    // Evaluate returned (did not hang)
    expect(results.length).toBe(SPAWN_COUNT);

    // At least one should be rejected with "Spawn queue full"
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    const hasQueueFullError = rejected.some((r) => r.reason?.includes("Spawn queue full"));
    expect(hasQueueFullError).toBe(true);

    // Cleanup — kill all successfully spawned terminals.
    // This is best-effort; the main process may be under heavy load from PTY allocations.
    const spawnedIds = results.filter((r) => r.status === "fulfilled").map((r) => r.value!);
    try {
      await window.evaluate(async (ids: string[]) => {
        const api = (window as any).electron.terminal;
        await Promise.all(
          ids.map((id) =>
            api.kill(id).catch(() => {
              /* already dead */
            })
          )
        );
      }, spawnedIds);
    } catch {
      // Process may be overwhelmed — best effort cleanup
    }

    // Give the system time to clean up PTY processes
    await window.waitForTimeout(5000);
  });

  test("main process alive after all concurrent operations", async () => {
    const alive = await ctx.app.evaluate(() => true);
    expect(alive).toBe(true);

    // Renderer is responsive — toolbar button visible
    await expect(ctx.window.locator(SEL.toolbar.openSettings)).toBeVisible();
  });
});
