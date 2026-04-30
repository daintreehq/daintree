import { test, expect } from "@playwright/test";
import { launchApp, closeApp, waitForProcessExit, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import {
  addAndSwitchToProject,
  selectExistingProjectAndRefresh,
  spawnTerminalAndVerify,
} from "../helpers/workflows";
import { getGridPanelCount, getDockPanelCount, openTerminal } from "../helpers/panels";
import { getPtyPid, waitForProcessDeath } from "../helpers/stress";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../helpers/timeouts";
import { mkdtempSync, rmSync } from "fs";
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
        const visible = await stopItem.isVisible({ timeout: T_SHORT }).catch(() => false);
        if (visible) return true;
        // Menu opened but lacks "Stop all agents" (processCount not yet
        // propagated). Dismiss and retry — palette stays open.
        await window.keyboard.press("Escape");
        return false;
      },
      { timeout: T_LONG, intervals: [250, 500, 1000] }
    )
    .toBe(true);

  await stopItem.click();
}

// ── Scenario 1: Active project close clears UI ──────────

test.describe.serial("Deletion Cleanup: Active project close clears UI", () => {
  let ctx: AppContext;
  let fixtureDir: string;
  const PROJECT_NAME = "Active Close Test";
  let ptyPids: number[] = [];

  test.beforeAll(async () => {
    fixtureDir = createFixtureRepo({ name: "active-close" });
    ctx = await launchApp();

    // Disable two-pane split mode: spawning exactly 2 terminals triggers a
    // race condition where the split layout momentarily activates during the
    // tab-group intermediate state, causing the Electron process to exit.
    await ctx.window.evaluate(() => {
      localStorage.setItem(
        "daintree-two-pane-split",
        JSON.stringify({
          state: {
            config: { enabled: false, defaultRatio: 0.5, preferPreview: false },
            ratioByWorktreeId: {},
          },
          version: 1,
        })
      );
    });

    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, PROJECT_NAME);

    const panel1 = await spawnTerminalAndVerify(ctx.window);
    const panel2 = await spawnTerminalAndVerify(ctx.window);

    if (process.platform !== "win32") {
      try {
        const pid1 = await getPtyPid(ctx.window, panel1);
        const pid2 = await getPtyPid(ctx.window, panel2);
        ptyPids = [pid1, pid2];
      } catch {
        // PTY PID extraction may fail in some environments
      }
    }
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test("active project removal shows Close Project dialog", async () => {
    const { window } = ctx;

    await stopActiveProjectViaSwitcher(window, PROJECT_NAME);

    // The active-project flow now uses "Stop project?" instead of the
    // retired "Close Project?" title.
    const dialog = window.getByRole("dialog", { name: "Stop project?" }).last();
    await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
    await expect(dialog.getByRole("button", { name: "Stop project" })).toBeVisible();

    // Cancel — project should remain active
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).not.toBeVisible({ timeout: T_MEDIUM });

    // Verify project is still active
    const trigger = window.locator(SEL.toolbar.projectSwitcherTrigger);
    await expect(trigger).toContainText(PROJECT_NAME, { timeout: T_SHORT });
  });

  test("confirming close shows welcome state with no panels", async () => {
    const { window } = ctx;

    await stopActiveProjectViaSwitcher(window, PROJECT_NAME);

    const dialog = window.getByRole("dialog", { name: "Stop project?" }).last();
    await expect(dialog).toBeVisible({ timeout: T_MEDIUM });

    await dialog.getByRole("button", { name: "Stop project" }).click();

    // Welcome screen should appear — project view is unmounted, find it
    // across all alive pages instead of relying on the stale `window` ref.
    await expect
      .poll(
        async () => {
          for (const w of ctx.app.windows()) {
            const openFolder = w.locator(SEL.welcome.openFolder);
            if (await openFolder.isVisible({ timeout: 500 }).catch(() => false)) {
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

  test("PTY processes are killed after active close", async () => {
    test.skip(process.platform === "win32", "PTY PID checks not available on Windows");
    test.skip(ptyPids.length === 0, "No PTY PIDs captured");

    for (const pid of ptyPids) {
      await waitForProcessDeath(pid, T_LONG);
    }
  });

  test("closed project still appears in switcher list", async () => {
    const { window } = ctx;

    await window.locator(SEL.toolbar.projectSwitcherTrigger).click();
    const palette = window.locator(SEL.projectSwitcher.palette);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });

    // Active close does NOT remove from the list — project should still be there
    await expect(palette.locator(`text="${PROJECT_NAME}"`)).toBeVisible({ timeout: T_SHORT });

    await window.keyboard.press("Escape");
    await expect(palette).not.toBeVisible({ timeout: T_SHORT });
  });
});

// ── Scenario 2: Background project removal isolation ────

test.describe.serial("Deletion Cleanup: Background project removal isolation", () => {
  let ctx: AppContext;
  let fixtureA: string;
  let fixtureB: string;
  const PROJECT_A = "Background Active";
  const PROJECT_B = "Background Remove";
  let ptyPidB: number | null = null;

  test.beforeAll(async () => {
    fixtureA = createFixtureRepo({ name: "bg-active" });
    fixtureB = createFixtureRepo({ name: "bg-remove" });

    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureA, PROJECT_A);

    // Spawn a terminal in A so it has panels when we switch back
    await spawnTerminalAndVerify(ctx.window);

    ctx.window = await addAndSwitchToProject(ctx.app, ctx.window, fixtureB, PROJECT_B);

    // Spawn a terminal in project B
    const panelB = await spawnTerminalAndVerify(ctx.window);
    if (process.platform !== "win32") {
      try {
        ptyPidB = await getPtyPid(ctx.window, panelB);
      } catch {
        // best-effort
      }
    }

    // Switch back to project A
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);

    // Wait for A's worktree cards to confirm switch
    await expect(ctx.window.locator("[data-worktree-branch]").first()).toBeVisible({
      timeout: T_LONG,
    });
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    rmSync(fixtureA, { recursive: true, force: true });
    rmSync(fixtureB, { recursive: true, force: true });
  });

  test("background removal shows Remove Project dialog", async () => {
    const { window } = ctx;

    await removeProjectViaSwitcher(window, PROJECT_B);

    const dialog = window.getByRole("dialog", { name: "Remove project from list?" }).last();
    await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
    await expect(dialog.getByRole("button", { name: "Remove project" })).toBeVisible();

    // Cancel first
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).not.toBeVisible({ timeout: T_MEDIUM });
  });

  test("confirming removal leaves active project intact", async () => {
    const { window } = ctx;

    await removeProjectViaSwitcher(window, PROJECT_B);

    const dialog = window.getByRole("dialog", { name: "Remove project from list?" }).last();
    await expect(dialog).toBeVisible({ timeout: T_MEDIUM });

    await dialog.getByRole("button", { name: "Remove project" }).click();
    await expect(dialog).not.toBeVisible({ timeout: T_MEDIUM });

    await window.waitForTimeout(T_SETTLE * 2);

    // Active project A should still be active
    const trigger = window.locator(SEL.toolbar.projectSwitcherTrigger);
    await expect(trigger).toContainText(PROJECT_A, { timeout: T_MEDIUM });

    // A's panels should still be present. If panels were lost during the
    // removal transition, spawn a fresh one to verify the project works.
    let panelCount = await getGridPanelCount(window);
    if (panelCount === 0) {
      await openTerminal(window);
      await expect
        .poll(() => getGridPanelCount(window), { timeout: T_LONG })
        .toBeGreaterThanOrEqual(1);
      panelCount = await getGridPanelCount(window);
    }
    expect(panelCount).toBeGreaterThanOrEqual(1);

    // A's worktree cards should still be visible
    await expect(window.locator("[data-worktree-branch]").first()).toBeVisible({
      timeout: T_MEDIUM,
    });

    // B should be gone from the switcher list
    await window.locator(SEL.toolbar.projectSwitcherTrigger).click();
    const palette = window.locator(SEL.projectSwitcher.palette);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });
    await expect(palette.locator(`text="${PROJECT_B}"`)).not.toBeVisible({ timeout: T_SHORT });

    await window.keyboard.press("Escape");
    await expect(palette).not.toBeVisible({ timeout: T_SHORT });
  });

  test("background project PTY processes are killed", async () => {
    test.skip(process.platform === "win32", "PTY PID checks not available on Windows");
    test.skip(ptyPidB === null, "No PTY PID captured");

    await waitForProcessDeath(ptyPidB!, T_LONG);
  });
});

// ── Scenario 3: Background removal persists across restart ──

test.describe.serial("Deletion Cleanup: Background removal persists across restart", () => {
  let userDataDir: string;
  let fixtureA: string;
  let fixtureB: string;
  let ctx: AppContext | null = null;
  const PROJECT_A = "Persist Active";
  const PROJECT_B = "Persist Remove";

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-deletion-persist-"));
    fixtureA = createFixtureRepo({ name: "persist-active" });
    fixtureB = createFixtureRepo({ name: "persist-remove" });
  });

  test.afterAll(async () => {
    if (ctx?.app) {
      const pid = ctx.app.process().pid;
      await closeApp(ctx.app);
      if (pid) await waitForProcessExit(pid).catch(() => {});
      ctx = null;
    }
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(fixtureA, { recursive: true, force: true });
    rmSync(fixtureB, { recursive: true, force: true });
  });

  test("removed project stays gone after app restart", async () => {
    // Session 1: Launch, onboard both projects, remove B
    ctx = await launchApp({ userDataDir });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureA, PROJECT_A);
    ctx.window = await addAndSwitchToProject(ctx.app, ctx.window, fixtureB, PROJECT_B);

    // Switch to A so B is background
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);
    await expect(ctx.window.locator("[data-worktree-branch]").first()).toBeVisible({
      timeout: T_LONG,
    });

    // Remove B from the list
    await removeProjectViaSwitcher(ctx.window, PROJECT_B);
    const dialog = ctx.window.getByRole("dialog", { name: "Remove project from list?" }).last();
    await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
    await dialog.getByRole("button", { name: "Remove project" }).click();
    await expect(dialog).not.toBeVisible({ timeout: T_MEDIUM });

    // Verify B is gone
    await ctx.window.waitForTimeout(T_SETTLE);
    await ctx.window.locator(SEL.toolbar.projectSwitcherTrigger).click();
    const palette1 = ctx.window.locator(SEL.projectSwitcher.palette);
    await expect(palette1).toBeVisible({ timeout: T_MEDIUM });
    await expect(palette1.locator(`text="${PROJECT_B}"`)).not.toBeVisible({ timeout: T_SHORT });
    await ctx.window.keyboard.press("Escape");

    // Graceful close
    const pid = ctx.app.process().pid!;
    await closeApp(ctx.app);
    await waitForProcessExit(pid);
    ctx = null;

    // Session 2: Relaunch with same userDataDir
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
    await expect(palette2.locator(`text="${PROJECT_B}"`)).not.toBeVisible({ timeout: T_SHORT });

    await w2.keyboard.press("Escape");
  });
});
