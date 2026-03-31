/* eslint-disable @typescript-eslint/no-explicit-any -- window.electron is untyped in Playwright evaluate() */
import { test, expect } from "@playwright/test";
import { launchApp, closeApp, mockOpenDialog, type AppContext } from "../helpers/launch";
import { createFixtureRepos } from "../helpers/fixtures";
import { openAndOnboardProject, completeOnboarding } from "../helpers/project";
import { injectDelay, clearAllFaults } from "../helpers/ipcFaults";
import { getGridPanelCount, openTerminal } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_MEDIUM, T_LONG, T_SETTLE } from "../helpers/timeouts";

let ctx: AppContext;
const PROJECT_A_NAME = "Race Project A";
const PROJECT_B_NAME = "Race Project B";

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

async function getCurrentProject(page: typeof ctx.window): Promise<ProjectInfo> {
  return page.evaluate(async () => {
    return await (window as any).electron.project.getCurrent();
  });
}

async function switchToProject(page: typeof ctx.window, projectName: string): Promise<void> {
  // Skip if already on the target project
  const current = await getCurrentProject(page);
  if (current.name === projectName) return;

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

  await expect(palette).not.toBeVisible({ timeout: T_LONG });
  await page.waitForTimeout(T_SETTLE);
}

test.describe.serial("Core: Project Switch Race Conditions", () => {
  test.beforeAll(async () => {
    const [repoA, repoB] = createFixtureRepos(2);

    ctx = await launchApp({ env: { CANOPY_E2E_FAULT_MODE: "1" } });

    // Open and onboard Project A
    await openAndOnboardProject(ctx.app, ctx.window, repoA, PROJECT_A_NAME);

    // Add Project B via project switcher
    await mockOpenDialog(ctx.app, repoB);
    await ctx.window.locator(SEL.toolbar.projectSwitcherTrigger).click();
    const palette = ctx.window.locator(SEL.projectSwitcher.palette);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });
    await ctx.window.locator(SEL.projectSwitcher.addButton).click({ force: true });

    await completeOnboarding(ctx.window, PROJECT_B_NAME);

    // Wait for onboarding transition to settle before switching
    await ctx.window.waitForTimeout(2000);

    // Switch back to Project A as the starting baseline
    await switchToProject(ctx.window, PROJECT_A_NAME);
  });

  test.afterEach(async () => {
    await clearAllFaults(ctx.app);
  });

  test.afterAll(async () => {
    await clearAllFaults(ctx.app);
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("delayed spawn assigns terminal to originating project", async () => {
    test.slow();
    const { window } = ctx;

    // Capture Project A's ID
    const projectA = await getCurrentProject(window);

    // Open a terminal in Project A to confirm normal flow works
    await openTerminal(window);
    await expect(window.locator(SEL.panel.gridPanel).first()).toBeVisible({ timeout: T_LONG });

    // Inject 3-second delay on terminal:spawn
    await injectDelay(ctx.app, "terminal:spawn", 3000);

    // Trigger a second terminal spawn (this one will be delayed)
    await openTerminal(window);

    // Immediately switch to Project B — the spawn is still in-flight
    await switchToProject(window, PROJECT_B_NAME);

    // Wait for the delayed spawn to complete (3s delay + margin)
    await window.waitForTimeout(4500);

    // Clear the fault before querying
    await clearAllFaults(ctx.app);

    // Query backend for all terminals
    const terminals = await getAllTerminals(window);

    // Filter to non-trashed terminals
    const activeTerminals = terminals.filter((t: TerminalInfo) => !t.isTrashed);

    // Verify we have at least 2 terminals (the original + the delayed one)
    expect(activeTerminals.length).toBeGreaterThanOrEqual(2);

    // Terminals with a defined projectId should belong to Project A.
    // Some terminals may still be mid-spawn (projectId not yet set);
    // the key invariant is that none should have leaked to Project B.
    const withProject = activeTerminals.filter((t: TerminalInfo) => t.projectId !== undefined);
    expect(withProject.length).toBeGreaterThanOrEqual(1);
    for (const t of withProject) {
      expect(t.projectId).toBe(projectA.id);
    }
  });

  test("panel grid is clean after switching — no cross-project panels", async () => {
    test.slow();
    const { window } = ctx;

    // Ensure faults are cleared from previous test before spawning
    await clearAllFaults(ctx.app);

    // Ensure we're on Project A with a fresh terminal fully spawned
    await switchToProject(window, PROJECT_A_NAME);
    await openTerminal(window);
    const panel = window.locator(SEL.panel.gridPanel).first();
    // CI VMs are slow after fault-injection tests; use generous timeout
    await expect(panel).toBeVisible({ timeout: 60_000 });
    // Wait for shell prompt so the terminal is fully initialized
    await window.waitForTimeout(3000);

    // Verify grid has at least 1 panel before switching
    const countBeforeSwitch = await getGridPanelCount(window);
    expect(countBeforeSwitch).toBeGreaterThanOrEqual(1);

    // Switch to Project B — grid should be empty (no terminals spawned in B)
    await switchToProject(window, PROJECT_B_NAME);
    await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(0);

    // Switch back to Project A — its panels should reappear
    await switchToProject(window, PROJECT_A_NAME);
    await expect
      .poll(() => getGridPanelCount(window), { timeout: T_LONG })
      .toBeGreaterThanOrEqual(1);
  });

  test("no orphaned terminals after rapid switching", async () => {
    test.slow();
    const { window } = ctx;

    // Record baseline terminal count
    const baselineTerminals = await getAllTerminals(window);
    const baselineCount = baselineTerminals.filter((t: TerminalInfo) => !t.isTrashed).length;

    // Switch to Project A to spawn from there
    await switchToProject(window, PROJECT_A_NAME);
    const projectA = await getCurrentProject(window);

    // Inject delay and trigger a spawn
    await injectDelay(ctx.app, "terminal:spawn", 2000);
    await openTerminal(window);

    // Rapid switch: A -> B -> A (settle between switches to avoid palette detach)
    await switchToProject(window, PROJECT_B_NAME);
    await window.waitForTimeout(T_SETTLE);
    await switchToProject(window, PROJECT_A_NAME);

    // Wait for the delayed spawn to complete
    await window.waitForTimeout(3500);
    await clearAllFaults(ctx.app);

    // Query all terminals again
    const finalTerminals = await getAllTerminals(window);
    const activeTerminals = finalTerminals.filter((t: TerminalInfo) => !t.isTrashed);

    // Should have exactly baseline + 1 (the one we spawned), not more
    expect(activeTerminals.length).toBe(baselineCount + 1);

    // Terminals with a defined projectId should belong to Project A.
    // Some terminals may still be mid-spawn (projectId not yet set);
    // the key invariant is that none should have leaked to Project B.
    const withProject = activeTerminals.filter((t: TerminalInfo) => t.projectId !== undefined);
    expect(withProject.length).toBeGreaterThanOrEqual(1);
    for (const t of withProject) {
      expect(t.projectId).toBe(projectA.id);
    }
  });
});
