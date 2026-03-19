/* eslint-disable @typescript-eslint/no-explicit-any -- window.electron is untyped in Playwright evaluate() */
import { test, expect } from "@playwright/test";
import { launchApp, closeApp, mockOpenDialog, type AppContext } from "../helpers/launch";
import { createFixtureRepos } from "../helpers/fixtures";
import { openAndOnboardProject, completeOnboarding } from "../helpers/project";
import { injectDelay, clearAllFaults } from "../helpers/ipcFaults";
import { getGridPanelCount } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../helpers/timeouts";

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
  await page.locator(SEL.toolbar.projectSwitcherTrigger).click();
  const palette = page.locator(SEL.projectSwitcher.palette);
  await expect(palette).toBeVisible({ timeout: T_MEDIUM });
  const projectRow = palette.locator(`text="${projectName}"`);
  await projectRow.click();
  await expect(palette).not.toBeVisible({ timeout: T_MEDIUM });
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
    await window.locator(SEL.toolbar.openTerminal).click();
    await expect(window.locator(SEL.panel.gridPanel).first()).toBeVisible({ timeout: T_LONG });

    // Inject 3-second delay on terminal:spawn
    await injectDelay(ctx.app, "terminal:spawn", 3000);

    // Trigger a second terminal spawn (this one will be delayed)
    await window.locator(SEL.toolbar.openTerminal).click();

    // Immediately switch to Project B — the spawn is still in-flight
    await switchToProject(window, PROJECT_B_NAME);

    // Wait for the delayed spawn to complete (3s delay + margin)
    await window.waitForTimeout(4500);

    // Clear the fault before querying
    await clearAllFaults(ctx.app);

    // Query backend for all terminals
    const terminals = await getAllTerminals(window);

    // Filter to non-trashed terminals with a projectId
    const assignedTerminals = terminals.filter((t: TerminalInfo) => !t.isTrashed && t.projectId);

    // All terminals should belong to Project A — none should have leaked to Project B
    for (const t of assignedTerminals) {
      expect(t.projectId).toBe(projectA.id);
    }

    // Verify we have at least 2 terminals (the original + the delayed one)
    expect(assignedTerminals.length).toBeGreaterThanOrEqual(2);
  });

  test("panel grid is clean after switching — no cross-project panels", async () => {
    const { window } = ctx;

    // We're in Project B after the previous test's switch
    // Project B should have 0 grid panels (no terminals were spawned in B)
    await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(0);

    // Switch to Project A — its panels should be visible
    await switchToProject(window, PROJECT_A_NAME);
    await expect
      .poll(() => getGridPanelCount(window), { timeout: T_LONG })
      .toBeGreaterThanOrEqual(1);

    // Switch back to Project B — grid should be empty again
    await switchToProject(window, PROJECT_B_NAME);
    await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(0);
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
    await window.locator(SEL.toolbar.openTerminal).click();

    // Rapid switch: A -> B -> A
    await switchToProject(window, PROJECT_B_NAME);
    await switchToProject(window, PROJECT_A_NAME);

    // Wait for the delayed spawn to complete
    await window.waitForTimeout(3500);
    await clearAllFaults(ctx.app);

    // Query all terminals again
    const finalTerminals = await getAllTerminals(window);
    const activeTerminals = finalTerminals.filter((t: TerminalInfo) => !t.isTrashed);

    // Should have exactly baseline + 1 (the one we spawned), not more
    expect(activeTerminals.length).toBe(baselineCount + 1);

    // Every active terminal with a projectId should have the correct project assignment
    for (const t of activeTerminals) {
      if (t.projectId) {
        expect(t.projectId).toBe(projectA.id);
      }
    }
  });
});
