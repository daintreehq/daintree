import { test, expect } from "@playwright/test";
import { launchApp, closeApp, waitForProcessExit, type AppContext } from "../../helpers/launch";
import { createFixtureRepo, removePathSync } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import {
  addAndSwitchToProject,
  selectExistingProjectAndRefresh,
  spawnTerminalAndVerify,
} from "../../helpers/workflows";
import { getGridPanelCount, getDockPanelCount } from "../../helpers/panels";
import { dismissBlockingPalette } from "../../helpers/overlays";
import { getPtyPid, waitForProcessDeath } from "../../helpers/stress";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";

/**
 * Open the project switcher palette and trigger the remove flow for an
 * inactive project via its context menu.
 */
async function removeProjectViaSwitcher(
  window: import("@playwright/test").Page,
  projectName: string
) {
  await window.locator(SEL.toolbar.projectSwitcherTrigger).click();
  const palette = window.locator(SEL.projectSwitcher.palette);
  await expect(palette).toBeVisible({ timeout: T_MEDIUM });

  const option = palette.getByRole("option", { name: new RegExp(projectName) });
  await expect(option).toBeVisible({ timeout: T_SHORT });
  // The dedicated close-project button in each row was removed. Remove is
  // now triggered via the context menu — right-click the row and pick the
  // destructive "Remove project" item (only shown for inactive projects).
  await option.click({ button: "right" });
  const removeItem = window.getByRole("menuitem", { name: "Remove project" });
  await expect(removeItem).toBeVisible({ timeout: T_SHORT });
  await removeItem.click();
}

/**
 * Open the project switcher palette and trigger the stop flow for the
 * currently-active project. Active projects no longer have a "Remove
 * project" menu item — instead they expose "Stop all agents" which fires
 * the Stop project confirm dialog.
 *
 * "Stop all agents" is gated by `processCount > 0` in the renderer. The
 * processCount is pushed via `project:stats-updated` IPC, which is debounced
 * (200ms) and otherwise polls every 5s. Right-clicking immediately after
 * spawning terminals can race the broadcast — retry by re-opening the
 * context menu until the menuitem renders.
 */
async function stopActiveProjectViaSwitcher(
  window: import("@playwright/test").Page,
  projectName: string
) {
  await window.locator(SEL.toolbar.projectSwitcherTrigger).click();
  const palette = window.locator(SEL.projectSwitcher.palette);
  await expect(palette).toBeVisible({ timeout: T_MEDIUM });

  const option = palette.getByRole("option", { name: new RegExp(projectName) });
  await expect(option).toBeVisible({ timeout: T_SHORT });

  const stopItem = window.getByRole("menuitem", { name: "Stop all agents" });

  await expect
    .poll(
      async () => {
        await option.click({ button: "right" });
        const visible = await stopItem
          .waitFor({ state: "visible", timeout: T_SHORT })
          .then(() => true)
          .catch(() => false);
        if (visible) return true;
        // Menu opened but lacks "Stop all agents" (processCount not yet
        // propagated). Dismiss and retry — palette stays open.
        await window.keyboard.press("Escape");
        return false;
      },
      // Allow up to 2× T_LONG (≈20s locally). The processCount aligned-interval
      // poll runs every 5s and terminal spawns don't trigger an event-driven
      // broadcast (only agent-state changes do), so under load the race window
      // can swallow the first 10s.
      { timeout: T_LONG * 2, intervals: [250, 500, 1000] }
    )
    .toBe(true);

  await stopItem.click();
}

// ── Scenario 1: Stopping the active project clears its UI ──

test.describe.serial("Deletion Cleanup: Stopping the active project clears UI", () => {
  let ctx: AppContext;
  let fixtureDir: string;
  let fixtureCleanup: (() => void) | undefined;
  const PROJECT_NAME = "active-close";
  let ptyPids: number[] = [];

  test.beforeAll(async () => {
    ({ dir: fixtureDir, cleanup: fixtureCleanup } = createFixtureRepo({ name: "active-close" }));
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, PROJECT_NAME);

    const panel1 = await spawnTerminalAndVerify(ctx.window);
    const panel2 = await spawnTerminalAndVerify(ctx.window);

    if (process.platform !== "win32") {
      const pid1 = await getPtyPid(ctx.window, panel1);
      const pid2 = await getPtyPid(ctx.window, panel2);
      ptyPids = [pid1, pid2];
    }
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("Stop all agents on the active project shows the Stop project dialog", async () => {
    const { window } = ctx;

    await stopActiveProjectViaSwitcher(window, PROJECT_NAME);

    const dialog = window.getByRole("alertdialog", { name: /^Stop '.+'\?$/ }).last();
    await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
    await expect(dialog.getByRole("button", { name: "Stop project" })).toBeVisible();

    // Cancel — project should remain active
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).not.toBeVisible({ timeout: T_MEDIUM });

    // Verify project is still active
    const trigger = window.locator(SEL.toolbar.projectSwitcherTrigger);
    await expect(trigger).toContainText(PROJECT_NAME, { timeout: T_SHORT });
  });

  test("confirming stop shows welcome state with no panels", async () => {
    const { window } = ctx;

    await stopActiveProjectViaSwitcher(window, PROJECT_NAME);

    const dialog = window.getByRole("alertdialog", { name: /^Stop '.+'\?$/ }).last();
    await expect(dialog).toBeVisible({ timeout: T_MEDIUM });

    await dialog.getByRole("button", { name: "Stop project" }).click();

    // Welcome screen should appear — project view is unmounted, find it
    // across all alive pages instead of relying on the stale `window` ref.
    await expect
      .poll(
        async () => {
          for (const w of ctx.app.windows()) {
            const openFolder = w.locator(SEL.welcome.openFolder);
            if (await openFolder.isVisible().catch(() => false)) {
              ctx.window = w;
              return true;
            }
          }
          return false;
        },
        { timeout: T_LONG }
      )
      .toBe(true);

    // No panels should remain in the welcome/project view
    expect(await getGridPanelCount(ctx.window)).toBe(0);
    expect(await getDockPanelCount(ctx.window)).toBe(0);
  });

  test("PTY processes are killed after stopping the project", async () => {
    if (process.platform === "win32") {
      test.info().annotations.push({
        type: "platform-skip",
        description: "PTY PID checks not available on Windows",
      });
      test.skip(true, "PTY PID checks not available on Windows");
    }

    expect(ptyPids).toHaveLength(2);
    for (const pid of ptyPids) {
      await waitForProcessDeath(pid, T_LONG);
    }
  });

  test("stopped project still appears in switcher list", async () => {
    const { window } = ctx;

    await window.locator(SEL.toolbar.projectSwitcherTrigger).click();
    const palette = window.locator(SEL.projectSwitcher.palette);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });

    // Stopping does NOT remove the project from the list — project should still be there
    await expect(palette.getByText(PROJECT_NAME, { exact: false })).toBeVisible({
      timeout: T_SHORT,
    });

    await dismissBlockingPalette(window);
    await expect(palette).not.toBeVisible({ timeout: T_SHORT });
  });
});

// ── Scenario 2: Background project removal — isolation and persistence ──

test.describe.serial("Deletion Cleanup: Background project removal", () => {
  let ctx: AppContext | null = null;
  let userDataDir: string;
  let fixtureA: string;
  let fixtureB: string;
  let cleanupA: (() => void) | undefined;
  let cleanupB: (() => void) | undefined;
  const PROJECT_A = "bg-active";
  const PROJECT_B = "bg-remove";
  let ptyPidB: number | null = null;

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-deletion-persist-"));
    ({ dir: fixtureA, cleanup: cleanupA } = createFixtureRepo({ name: "bg-active" }));
    ({ dir: fixtureB, cleanup: cleanupB } = createFixtureRepo({ name: "bg-remove" }));

    ctx = await launchApp({ userDataDir });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureA, PROJECT_A);

    // Spawn a terminal in A so it has panels when we switch back
    await spawnTerminalAndVerify(ctx.window);

    ctx.window = await addAndSwitchToProject(ctx.app, ctx.window, fixtureB, PROJECT_B);

    // Spawn a terminal in project B
    const panelB = await spawnTerminalAndVerify(ctx.window);
    if (process.platform !== "win32") {
      ptyPidB = await getPtyPid(ctx.window, panelB);
    }

    // Switch back to project A
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);

    // Wait for A's worktree cards to confirm switch
    await expect(ctx.window.locator("[data-worktree-branch]").first()).toBeVisible({
      timeout: T_LONG,
    });
  });

  test.afterAll(async () => {
    if (ctx?.app) {
      const pid = ctx.app.process().pid;
      await closeApp(ctx.app);
      if (pid) await waitForProcessExit(pid).catch(() => {});
      ctx = null;
    }
    removePathSync(userDataDir);
    cleanupA?.();
    cleanupB?.();
  });

  test("background removal shows Remove Project dialog; cancel keeps it listed", async () => {
    const { window } = ctx!;

    await removeProjectViaSwitcher(window, PROJECT_B);

    const dialog = window
      .getByRole("alertdialog", { name: /^Remove '.+' from the list\?$/ })
      .last();
    await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
    await expect(dialog.getByRole("button", { name: "Remove project" })).toBeVisible();
    // The confirmation names the project being removed.
    await expect(dialog.getByText(PROJECT_B, { exact: false }).first()).toBeVisible();

    // Cancel first
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).not.toBeVisible({ timeout: T_MEDIUM });

    // The cancel flow returns to the underlying switcher when it remains open.
    // Only click the trigger if the dialog teardown closed the switcher too.
    const palette = window.locator(SEL.projectSwitcher.palette);
    if (!(await palette.isVisible().catch(() => false))) {
      await window.locator(SEL.toolbar.projectSwitcherTrigger).click();
    }
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });
    await expect(palette.getByText(PROJECT_B, { exact: false })).toBeVisible({
      timeout: T_SHORT,
    });

    await dismissBlockingPalette(window);
    await expect(palette).not.toBeVisible({ timeout: T_SHORT });
  });

  test("confirming removal leaves active project intact", async () => {
    const { window } = ctx!;

    await removeProjectViaSwitcher(window, PROJECT_B);

    const dialog = window
      .getByRole("alertdialog", { name: /^Remove '.+' from the list\?$/ })
      .last();
    await expect(dialog).toBeVisible({ timeout: T_MEDIUM });

    await dialog.getByRole("button", { name: "Remove project" }).click();
    await expect(dialog).not.toBeVisible({ timeout: T_MEDIUM });

    // Active project A should still be active
    const trigger = window.locator(SEL.toolbar.projectSwitcherTrigger);
    await expect(trigger).toContainText(PROJECT_A, { timeout: T_MEDIUM });

    // A's panel must survive the background removal — this is the regression
    // the test exists to catch, so assert it directly rather than respawning.
    await expect
      .poll(() => getGridPanelCount(window), { timeout: T_LONG })
      .toBeGreaterThanOrEqual(1);

    // A's worktree cards should still be visible
    await expect(window.locator("[data-worktree-branch]").first()).toBeVisible({
      timeout: T_MEDIUM,
    });

    // B should be gone from the switcher list
    await window.locator(SEL.toolbar.projectSwitcherTrigger).click();
    const palette = window.locator(SEL.projectSwitcher.palette);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });
    await expect(palette.getByText(PROJECT_B, { exact: false })).not.toBeVisible({
      timeout: T_SHORT,
    });

    await dismissBlockingPalette(window);
    await expect(palette).not.toBeVisible({ timeout: T_SHORT });
  });

  test("background project PTY processes are killed", async () => {
    if (process.platform === "win32") {
      test.info().annotations.push({
        type: "platform-skip",
        description: "PTY PID checks not available on Windows",
      });
      test.skip(true, "PTY PID checks not available on Windows");
    }

    expect(ptyPidB).not.toBeNull();
    await waitForProcessDeath(ptyPidB!, T_LONG);
  });

  test("removed project stays gone after app restart", async () => {
    // Graceful close so the removal is flushed, then relaunch on the same
    // userData.
    const pid = ctx!.app.process().pid!;
    await closeApp(ctx!.app);
    await waitForProcessExit(pid);
    ctx = null;

    ctx = await launchApp({ userDataDir });
    const { window: w2 } = ctx;

    // A should still be present
    const trigger = w2.locator(SEL.toolbar.projectSwitcherTrigger);
    await expect(trigger).toBeVisible({ timeout: T_MEDIUM });
    await expect(trigger).toContainText(PROJECT_A, { timeout: T_MEDIUM });

    // B should still be absent from the switcher
    await w2.locator(SEL.toolbar.projectSwitcherTrigger).click();
    const palette2 = w2.locator(SEL.projectSwitcher.palette);
    await expect(palette2).toBeVisible({ timeout: T_MEDIUM });
    await expect(palette2.getByText(PROJECT_B, { exact: false })).not.toBeVisible({
      timeout: T_SHORT,
    });

    await dismissBlockingPalette(w2);
  });
});
