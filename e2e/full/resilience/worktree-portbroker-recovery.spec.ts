import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepos } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { T_LONG } from "../../helpers/timeouts";

// Exercises WorktreePortBroker recovery after a workspace-host crash. Killing
// the host's UtilityProcess (`__daintreeCrashWorkspaceHostForWindow`) drives the
// real exit → auto-restart → `host-restarted` → `reBrokerForHost` path wired in
// windowServices.ts. The view must end up with a live MessagePort again, and the
// per-port webContents listeners (`did-start-navigation`, `destroyed`,
// port-close) must NOT accumulate across the crash — `closePortsForView` runs
// `cleanupListeners()` before each re-broker, so the count returns to baseline.

let ctx: AppContext;
let fixtureCleanups: Array<() => void> = [];

async function getWindowId(app: AppContext["app"]): Promise<number> {
  const id = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    return win?.id ?? null;
  });
  if (id === null) throw new Error("No BrowserWindow found");
  return id;
}

// Find the webContents id the broker actually holds a port for, rather than
// assuming the active view's id — the initial broker target (`appWc` in
// windowServices.ts) is the safest source of truth across the WebContentsView
// architecture.
async function findPortedWebContentsId(app: AppContext["app"]): Promise<number | null> {
  return app.evaluate(() => {
    const g = globalThis as Record<string, unknown>;
    const getPvm = g.__daintreeGetPvm as (() => unknown) | undefined;
    const has = g.__daintreeWorktreeHasPort as ((id: number) => boolean) | undefined;
    const pvm = getPvm?.() as { getAllWebContentsIds?: () => number[] } | null | undefined;
    if (!pvm?.getAllWebContentsIds || !has) return null;
    for (const id of pvm.getAllWebContentsIds()) {
      if (has(id)) return id;
    }
    return null;
  });
}

async function hasPort(app: AppContext["app"], wcId: number): Promise<boolean> {
  return app.evaluate((_electron, id) => {
    const g = globalThis as Record<string, unknown>;
    const fn = g.__daintreeWorktreeHasPort as ((x: number) => boolean) | undefined;
    if (!fn) throw new Error("__daintreeWorktreeHasPort not present");
    return fn(id);
  }, wcId);
}

async function navigationListenerCount(app: AppContext["app"], wcId: number): Promise<number> {
  return app.evaluate(({ webContents }, id) => {
    const wc = webContents.fromId(id);
    return wc && !wc.isDestroyed() ? wc.listenerCount("did-start-navigation") : -1;
  }, wcId);
}

async function crashWorkspaceHost(app: AppContext["app"], windowId: number): Promise<boolean> {
  return app.evaluate((_electron, id) => {
    const g = globalThis as Record<string, unknown>;
    const fn = g.__daintreeCrashWorkspaceHostForWindow as ((x: number) => boolean) | undefined;
    if (!fn) throw new Error("__daintreeCrashWorkspaceHostForWindow not present");
    return fn(id);
  }, windowId);
}

async function crashWorkspaceHostWhenReady(
  app: AppContext["app"],
  windowId: number
): Promise<void> {
  await expect.poll(() => crashWorkspaceHost(app, windowId), { timeout: T_LONG }).toBe(true);
}

async function workspaceHostHasLiveChild(
  app: AppContext["app"],
  windowId: number
): Promise<boolean> {
  return app.evaluate((_electron, id) => {
    const g = globalThis as Record<string, unknown>;
    const fn = g.__daintreeWorkspaceHostHasLiveChildForWindow as
      ((x: number) => boolean) | undefined;
    if (!fn) throw new Error("__daintreeWorkspaceHostHasLiveChildForWindow not present");
    return fn(id);
  }, windowId);
}

async function workspaceHostRestartCount(app: AppContext["app"]): Promise<number> {
  return app.evaluate(() => {
    const g = globalThis as Record<string, unknown>;
    const value = g.__daintreeWorkspaceHostRestartCount;
    return typeof value === "number" ? value : 0;
  });
}

function sidebarWorktreeList(page: AppContext["window"]) {
  return page
    .locator(
      '[data-worktree-branch], [data-worktree-is-main="true"], [aria-label="Worktrees"] a, .worktree-item'
    )
    .first();
}

test.describe.serial("Resilience: worktree port broker recovery after host crash", () => {
  test.beforeAll(async () => {
    test.setTimeout(180_000);
    const [repo] = createFixtureRepos(1);
    fixtureCleanups = [repo.cleanup];
    ctx = await launchApp({ env: { DAINTREE_E2E_FAULT_MODE: "1" } });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "portbroker-project");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    for (const cleanup of fixtureCleanups) cleanup();
  });

  test("the active view keeps a live port and stable listeners across a host crash", async () => {
    test.slow();
    const windowId = await getWindowId(ctx.app);
    const initialRestartCount = await workspaceHostRestartCount(ctx.app);

    // The port is brokered when the view attaches to its host — poll until a
    // ported view appears, then pin that wcId for the rest of the test.
    await expect.poll(() => findPortedWebContentsId(ctx.app), { timeout: T_LONG }).not.toBeNull();
    const wcId = (await findPortedWebContentsId(ctx.app))!;

    expect(await hasPort(ctx.app, wcId)).toBe(true);
    const baselineListeners = await navigationListenerCount(ctx.app, wcId);
    expect(baselineListeners).toBeGreaterThanOrEqual(1);

    // Crash the workspace host's UtilityProcess. A `true` return proves a live
    // child existed and was killed — so the recovery poll below is exercised
    // against a genuine crash, not a no-op.
    await crashWorkspaceHostWhenReady(ctx.app, windowId);

    // After auto-restart + host-restarted, the broker re-establishes a port for
    // the same view. The renderer is unchanged (same wcId), so the worktree
    // store re-hydrates over the fresh port rather than staying stale. We assert
    // the recovered end-state (port present) rather than the transient gap — the
    // host-restarted re-broker path keeps the view's map entry across the crash,
    // so `hasPort` may never observably dip to false in between.
    await expect
      .poll(() => workspaceHostRestartCount(ctx.app), { timeout: T_LONG })
      .toBeGreaterThan(initialRestartCount);
    await expect.poll(() => hasPort(ctx.app, wcId), { timeout: T_LONG }).toBe(true);

    // No listener accumulation: each re-broker removes the prior view's
    // listeners before attaching new ones, so the count must not climb.
    const afterListeners = await navigationListenerCount(ctx.app, wcId);
    expect(afterListeners).toBeLessThanOrEqual(baselineListeners);
    const afterFirstRestartCount = await workspaceHostRestartCount(ctx.app);

    // A second crash must recover identically — proving the recovery path is
    // repeatable and not a one-shot.
    await expect
      .poll(() => workspaceHostHasLiveChild(ctx.app, windowId), { timeout: T_LONG })
      .toBe(true);
    await crashWorkspaceHostWhenReady(ctx.app, windowId);
    await expect
      .poll(() => workspaceHostRestartCount(ctx.app), { timeout: T_LONG })
      .toBeGreaterThan(afterFirstRestartCount);
    await expect.poll(() => hasPort(ctx.app, wcId), { timeout: T_LONG }).toBe(true);
    expect(await navigationListenerCount(ctx.app, wcId)).toBeLessThanOrEqual(baselineListeners);
  });

  test("the sidebar worktree list survives the recovery", async () => {
    // Re-hydration is observable in the UI: the worktree the fixture repo seeds
    // is still listed after the crashes above (the store re-fetched over the
    // re-brokered port instead of being stuck on a loading skeleton).
    await expect(sidebarWorktreeList(ctx.window)).toBeVisible({ timeout: T_LONG });
  });
});
