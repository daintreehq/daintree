/* eslint-disable @typescript-eslint/no-explicit-any -- window.electron is untyped in Playwright evaluate() */
import { test, expect } from "@playwright/test";
import {
  launchApp,
  closeApp,
  mockOpenDialog,
  refreshActiveWindow,
  type AppContext,
} from "../../helpers/launch";
import { createFixtureRepos } from "../../helpers/fixtures";
import { openAndOnboardProject, dismissTelemetryConsent } from "../../helpers/project";
import { injectDelay, clearAllFaults } from "../../helpers/ipcFaults";
import { getGridPanelCount, openTerminal } from "../../helpers/panels";
import { SEL } from "../../helpers/selectors";
import { T_MEDIUM, T_LONG, T_SETTLE } from "../../helpers/timeouts";

let ctx: AppContext;
let fixtureCleanups: Array<() => void> = [];
const PROJECT_A_NAME = "project-A";
const PROJECT_B_NAME = "project-B";

interface TerminalInfo {
  id: string;
  projectId?: string;
  isTrashed?: boolean;
  hasPty?: boolean;
  kind?: string;
}

interface ProjectInfo {
  id: string;
  name: string;
}

async function getAllTerminals(page: typeof ctx.window): Promise<TerminalInfo[]> {
  return page.evaluate(async () => {
    return await (window as any).electron.terminal.getAllTerminals();
  });
}

async function getCurrentProject(page: typeof ctx.window): Promise<ProjectInfo | null> {
  return page.evaluate(async () => {
    return await (window as any).electron.project.getCurrent();
  });
}

async function switchToProject(
  page: typeof ctx.window,
  projectName: string
): Promise<typeof ctx.window> {
  // Skip if already on the target project
  const current = await getCurrentProject(page);
  if (current?.name === projectName) return page;

  await page.locator(SEL.toolbar.projectSwitcherTrigger).click();
  const palette = page.locator(SEL.projectSwitcher.palette);
  await expect(palette).toBeVisible({ timeout: T_MEDIUM });
  await page.waitForTimeout(T_SETTLE);

  // Use evaluate to click — immune to DOM detachment from React re-renders
  await page.evaluate((name) => {
    const el = document.querySelector('[data-testid="project-switcher-palette"]');
    if (!el) throw new Error("Palette not in DOM");
    const options = el.querySelectorAll('[role="option"]');
    for (const opt of options) {
      if (opt.textContent?.includes(name)) {
        (opt as HTMLElement).click();
        return;
      }
    }
    throw new Error(`Project "${name}" not found in palette`);
  }, projectName);

  // Don't fail if the outgoing view's React tree never closes its palette
  // before we swap; the visible/attached view changes anyway.
  await expect(palette)
    .not.toBeVisible({ timeout: T_LONG })
    .catch(() => undefined);

  // Re-acquire the now-active project view's CDP page so subsequent
  // locator queries don't go to the cached outgoing view.
  const refreshed = await refreshActiveWindow(ctx.app, page);
  await refreshed.waitForTimeout(T_SETTLE);
  ctx.window = refreshed;
  return refreshed;
}

test.describe.serial("Core: Project Switch Race Conditions", () => {
  test.beforeAll(async () => {
    const fixtures = createFixtureRepos(2);
    fixtureCleanups = fixtures.map((f) => f.cleanup);
    const [repoA, repoB] = fixtures.map((f) => f.dir);

    ctx = await launchApp({ env: { DAINTREE_E2E_FAULT_MODE: "1" } });

    // Open and onboard Project A
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, repoA, PROJECT_A_NAME);

    // Add Project B via project switcher
    await mockOpenDialog(ctx.app, repoB);
    await ctx.window.locator(SEL.toolbar.projectSwitcherTrigger).click();
    const palette = ctx.window.locator(SEL.projectSwitcher.palette);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });
    await ctx.window.locator(SEL.projectSwitcher.addButton).click({ force: true });

    // Re-acquire window after the WebContentsView swap, then dismiss the
    // telemetry consent dialog if it appears.
    ctx.window = await refreshActiveWindow(ctx.app, ctx.window);
    await dismissTelemetryConsent(ctx.window);

    // Switch back to Project A as the starting baseline
    await switchToProject(ctx.window, PROJECT_A_NAME);
  });

  test.afterEach(async () => {
    await clearAllFaults(ctx.app);
  });

  test.afterAll(async () => {
    await clearAllFaults(ctx.app);
    if (ctx?.app) await closeApp(ctx.app);
    for (const cleanup of fixtureCleanups) cleanup();
  });

  test("delayed spawn assigns terminal to originating project", async () => {
    test.slow();

    // Capture Project A's ID
    const projectA = await getCurrentProject(ctx.window);
    expect(projectA).not.toBeNull();

    // Open a terminal in Project A to confirm normal flow works
    await openTerminal(ctx.window);
    await expect(ctx.window.locator(SEL.panel.gridPanel).first()).toBeVisible({
      timeout: T_LONG,
    });

    // Inject 3-second delay on terminal:spawn
    await injectDelay(ctx.app, "terminal:spawn", 3000);

    // Trigger a second terminal spawn (this one will be delayed)
    await openTerminal(ctx.window);

    // openTerminal returns once the click is delivered, not once React has
    // dispatched terminal:spawn. addPanel commits the pane to the store before
    // any async work (#5789 commit-then-spawn), so a second grid pane is proof
    // the spawn is genuinely in-flight — and it lands in milliseconds, well
    // inside the 3s delay. Without this gate a loaded runner can switch away
    // before the spawn is ever sent, and addPanel's async tail then drops the
    // pane on the project switch (see panelStore.addPanel), leaving one
    // terminal instead of two.
    await expect(ctx.window.locator(SEL.panel.gridPanel)).toHaveCount(2, {
      timeout: T_LONG,
    });

    // Immediately switch to Project B — the spawn is still in-flight
    await switchToProject(ctx.window, PROJECT_B_NAME);

    // Clear the fault before polling
    await clearAllFaults(ctx.app);

    // Poll while Project B is still active until the delayed terminal exists.
    // The inactive Project A renderer can hydrate project metadata later, so
    // gate first on terminal creation and then assert any resolved terminals
    // did not leak to the currently active Project B.
    await expect
      .poll(() => getAllTerminals(ctx.window).then((ts) => ts.filter((t) => !t.isTrashed).length), {
        timeout: T_LONG,
      })
      .toBeGreaterThanOrEqual(2);

    // Poll until at least one terminal has resolved its projectId. The key
    // invariant is no resolved terminal may be stamped with Project B while the
    // delayed spawn completes.
    await expect
      .poll(
        () =>
          getAllTerminals(ctx.window).then(
            (ts) => ts.filter((t) => !t.isTrashed && t.projectId !== undefined).length
          ),
        { timeout: T_LONG }
      )
      .toBeGreaterThanOrEqual(1);

    // Re-query for assertions after the poll gate has passed.
    const settled = await getAllTerminals(ctx.window);
    const activeTerminals = settled.filter((t: TerminalInfo) => !t.isTrashed);

    // Every resolved terminal must belong to Project A — none must have leaked.
    const withProject = activeTerminals.filter((t: TerminalInfo) => t.projectId !== undefined);
    expect(withProject.length).toBeGreaterThanOrEqual(1);
    for (const t of withProject) {
      expect(t.projectId).toBe(projectA!.id);
    }
  });

  test("panel grid is clean after switching — no cross-project panels", async () => {
    test.slow();

    // Ensure faults are cleared from previous test before spawning
    await clearAllFaults(ctx.app);
    // The prior `delayed spawn` test leaves an in-flight terminal
    // that may still be settling into the cached Project A view when
    // this test starts. Give the main process time to drain queued
    // PTY-attach IPCs against the cached view before reactivating it
    // — without this, the cached view's IPC handlers race with
    // unregister-on-deactivate and the renderer can crash uncaughtly.
    const drainMs = 2_000 * (process.env.CI ? (process.platform === "win32" ? 5 : 3) : 1);
    await ctx.window.waitForTimeout(drainMs);

    // Ensure we're on Project A with a fresh terminal fully spawned
    await switchToProject(ctx.window, PROJECT_A_NAME);
    await openTerminal(ctx.window);
    const panel = ctx.window.locator(SEL.panel.gridPanel).first();
    // CI VMs are slow after fault-injection tests; double T_LONG for headroom
    await expect(panel).toBeVisible({ timeout: T_LONG * 2 });
    // Wait for shell prompt so the terminal is fully initialized
    await ctx.window.waitForTimeout(3000);

    // Verify grid has at least 1 panel before switching
    const countBeforeSwitch = await getGridPanelCount(ctx.window);
    expect(countBeforeSwitch).toBeGreaterThanOrEqual(1);

    // Switch to Project B then back — the key invariant is that A's panels survive
    await switchToProject(ctx.window, PROJECT_B_NAME);
    // The previous test (`delayed spawn`) left a terminal mid-spawn that
    // arrives in Project A AFTER its WebContentsView was deactivated. The
    // cached view's IPC handlers continue draining queued messages for a
    // short period — switching back too soon races handler unregistration
    // against the activation flow and the renderer crashes uncaughtly. Wait
    // long enough for those messages to drain before reactivating A.
    await ctx.window.waitForTimeout(drainMs);

    // Switch back to Project A — its panels should reappear
    await switchToProject(ctx.window, PROJECT_A_NAME);
    await expect
      .poll(() => getGridPanelCount(ctx.window), { timeout: T_LONG })
      .toBeGreaterThanOrEqual(1);
  });

  test("no orphaned terminals after rapid switching", async () => {
    test.slow();

    // Record baseline terminal count
    const baselineTerminals = await getAllTerminals(ctx.window);
    const baselineCount = baselineTerminals.filter((t: TerminalInfo) => !t.isTrashed).length;

    // Switch to Project A to spawn from there
    await switchToProject(ctx.window, PROJECT_A_NAME);
    const projectA = await getCurrentProject(ctx.window);
    expect(projectA).not.toBeNull();

    // Inject delay and trigger a spawn
    await injectDelay(ctx.app, "terminal:spawn", 2000);
    await openTerminal(ctx.window);

    // Rapid switch: A -> B -> A (settle between switches to avoid palette detach)
    await switchToProject(ctx.window, PROJECT_B_NAME);
    await ctx.window.waitForTimeout(T_SETTLE);
    await switchToProject(ctx.window, PROJECT_A_NAME);

    await clearAllFaults(ctx.app);

    // Poll until the delayed spawn has landed and its projectId is resolved.
    // Gate on count first, then on at least one resolved projectId.
    await expect
      .poll(() => getAllTerminals(ctx.window).then((ts) => ts.filter((t) => !t.isTrashed).length), {
        timeout: T_LONG,
      })
      .toBeGreaterThanOrEqual(baselineCount + 1);
    await expect
      .poll(
        () =>
          getAllTerminals(ctx.window).then(
            (ts) => ts.filter((t) => !t.isTrashed && t.projectId !== undefined).length
          ),
        { timeout: T_LONG }
      )
      .toBeGreaterThanOrEqual(1);

    // Re-query for assertions after the poll gates have passed.
    const finalTerminals = await getAllTerminals(ctx.window);
    const activeTerminals = finalTerminals.filter((t: TerminalInfo) => !t.isTrashed);

    // Should have exactly baseline + 1 (the one we spawned), not more
    expect(activeTerminals.length).toBe(baselineCount + 1);

    // Every resolved terminal must belong to Project A — none must have leaked.
    const withProject = activeTerminals.filter((t: TerminalInfo) => t.projectId !== undefined);
    expect(withProject.length).toBeGreaterThanOrEqual(1);
    for (const t of withProject) {
      expect(t.projectId).toBe(projectA!.id);
    }
  });

  test("backgrounded view's file browser queries its own project (#11366)", async () => {
    test.slow();

    // Start on Project A and capture its page + main worktree id while active.
    await switchToProject(ctx.window, PROJECT_A_NAME);
    const pageA = ctx.window;
    await expect
      .poll(
        () =>
          pageA
            .evaluate(() => (window as any).electron.worktree.getAll())
            .then((wts: Array<{ id: string }>) => wts.length),
        { timeout: T_LONG }
      )
      .toBeGreaterThanOrEqual(1);
    const worktreeA: string = await pageA.evaluate(async () => {
      const wts = await (window as any).electron.worktree.getAll();
      return wts[0].id;
    });

    // Switch to Project B — A's view is now cached in the same window, and
    // windowToProject points at B. pageA keeps targeting the cached view.
    const pageB = await switchToProject(ctx.window, PROJECT_B_NAME);
    await expect
      .poll(
        () =>
          pageB
            .evaluate(() => (window as any).electron.worktree.getAll())
            .then((wts: Array<{ id: string }>) => wts.length),
        { timeout: T_LONG }
      )
      .toBeGreaterThanOrEqual(1);
    const worktreeB: string = await pageB.evaluate(async () => {
      const wts = await (window as any).electron.worktree.getAll();
      return wts[0].id;
    });
    expect(worktreeB).not.toBe(worktreeA);

    // The cached A view's listing must resolve against A's own workspace
    // host — before #11366 this failed with "Worktree not found" because the
    // request routed to the active project B's host.
    const listingA = await pageA.evaluate(async (wtId: string) => {
      try {
        const entries = await (window as any).electron.fileBrowser.listDirectory({
          worktreeId: wtId,
        });
        return { ok: true as const, names: entries.map((e: { name: string }) => e.name) };
      } catch (error) {
        return { ok: false as const, error: String(error) };
      }
    }, worktreeA);
    expect(
      listingA.ok,
      `cached view listing failed: ${"error" in listingA ? listingA.error : ""}`
    ).toBe(true);
    expect((listingA as { names: string[] }).names).toContain("README.md");

    // Prove B's own host can serve its worktree right now, so the refusal
    // below is conclusively an authorization decision, not an unready host.
    const listingBFromB = await pageB.evaluate(async (wtId: string) => {
      try {
        const entries = await (window as any).electron.fileBrowser.listDirectory({
          worktreeId: wtId,
        });
        return { ok: true as const, names: entries.map((e: { name: string }) => e.name) };
      } catch (error) {
        return { ok: false as const, error: String(error) };
      }
    }, worktreeB);
    expect(
      listingBFromB.ok,
      `active view listing failed: ${"error" in listingBFromB ? listingBFromB.error : ""}`
    ).toBe(true);

    // The scoping must be tighter than before, not looser: the cached A view
    // must NOT be able to list the active project B's worktree.
    const listingB = await pageA.evaluate(async (wtId: string) => {
      try {
        await (window as any).electron.fileBrowser.listDirectory({ worktreeId: wtId });
        return { ok: true as const };
      } catch (error) {
        return { ok: false as const, error: String(error) };
      }
    }, worktreeB);
    expect(listingB.ok).toBe(false);
    expect((listingB as { error: string }).error).toMatch(/Worktree not found/);

    // Restore the serial suite's baseline.
    await switchToProject(ctx.window, PROJECT_A_NAME);
  });
});
