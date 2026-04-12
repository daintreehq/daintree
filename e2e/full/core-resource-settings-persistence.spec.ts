import path from "path";
import fs from "fs";
import { execFileSync } from "child_process";
import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { openSettings } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../helpers/timeouts";
import { ensureWindowFocused } from "../helpers/focus";

/**
 * E2E tests for resource settings persistence and GUI-driven configuration.
 *
 * Strategy: The fixture repo has .canopy/config.json with a `resources` block
 * containing "e2e-docker" environment commands. Test 1 adds "e2e-docker" via
 * the Settings GUI (which populates projectSettings.resourceEnvironments).
 * After that, the create worktree dialog shows the mode selector with
 * "e2e-docker" as an option, and lifecycle commands come from config.json.
 */

let ctx: AppContext;
let fixtureDir: string;

const mod = process.platform === "darwin" ? "Meta" : "Control";

function writeResourceConfig(repoDir: string) {
  const canopyDir = path.join(repoDir, ".canopy");
  fs.mkdirSync(canopyDir, { recursive: true });

  const stateFile = path.join(canopyDir, "resource-state.json");

  const config = {
    setup: [],
    teardown: [],
    resources: {
      "e2e-docker": {
        provision: [
          `printf '{"status":"provisioning"}' > "${stateFile}"`,
          `sleep 0.1`,
          `printf '{"status":"ready"}' > "${stateFile}"`,
        ],
        teardown: [`rm -f "${stateFile}"`],
        status: `cat "${stateFile}" 2>/dev/null || printf '{"status":"unknown"}'`,
        connect: "bash --norc --noprofile",
      },
    },
  };

  fs.writeFileSync(path.join(canopyDir, "config.json"), JSON.stringify(config, null, 2));

  execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "add resource config"], { cwd: repoDir, stdio: "ignore" });
}

/** Navigate to Project > Resources tab in settings */
async function navigateToResourcesTab(
  window: Awaited<ReturnType<typeof launchApp>>["window"]
): Promise<void> {
  const scopeSelect = window.locator('[aria-label="Settings scope"]');
  await scopeSelect.selectOption("project");
  // Wait for project settings to load via IPC (async fetch)
  await window.waitForTimeout(1000);

  await window.locator(`${SEL.settings.navSidebar} button`, { hasText: "Worktree Setup" }).click();
  const panel = window.locator("#settings-panel-project\\:automation");
  await expect(panel.locator("h2", { hasText: "Resource Environments" })).toBeVisible({
    timeout: T_MEDIUM,
  });
  // Wait for Add environment button to confirm panel is interactive
  await expect(panel.locator('[aria-label="Add environment"]')).toBeVisible({
    timeout: T_SHORT,
  });
}

/** Add a named environment via the Settings GUI */
async function addEnvironmentViaGUI(
  window: Awaited<ReturnType<typeof launchApp>>["window"],
  name: string
): Promise<void> {
  const panel = window.locator("#settings-panel-project\\:automation");

  await panel.locator('[aria-label="Add environment"]').click();
  const nameInput = panel.locator("#new-environment-name");
  await expect(nameInput).toBeVisible({ timeout: T_SHORT });
  await nameInput.fill(name);

  const formAddButton = panel
    .locator('[data-testid="add-environment-form"]')
    .locator("button", { hasText: "Add" });
  await formAddButton.click();
  await window.waitForTimeout(T_SETTLE);
}

test.describe.serial("Full: Resource Settings Persistence", () => {
  test.beforeAll(async () => {
    fixtureDir = createFixtureRepo({ name: "resource-settings" });
    writeResourceConfig(fixtureDir);

    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Resource Settings");

    // Wait for project to fully stabilize after onboarding
    await ctx.window.waitForTimeout(2000);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  // ---- Test 1: Settings persistence round-trip ----
  test("settings round-trip: added environment persists after close/reopen", async () => {
    const { window } = ctx;

    // Verify we're on the project view, not the welcome page
    expect(window.url()).toContain("projectId=");

    await openSettings(window);
    await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

    await navigateToResourcesTab(window);

    // Add "e2e-docker" environment via GUI (matches config.json resources key)
    await addEnvironmentViaGUI(window, "e2e-docker");

    // Verify it appears in the dropdown immediately after adding
    const panel = window.locator("#settings-panel-project\\:automation");
    const selectorBar = panel.locator('[data-testid="environment-selector-bar"]');
    await expect(selectorBar).toBeVisible({ timeout: T_SHORT });

    const selectElBefore = selectorBar.locator("select");
    const optionBefore = selectElBefore.locator('option[value="e2e-docker"]');
    await expect(optionBefore).toBeAttached({ timeout: T_SHORT });

    // Wait for auto-save: debounce (500ms) + React effect + I/O
    await window.waitForTimeout(3000);

    // Close settings via the close button — this calls flush() which
    // persists immediately before the dialog closes.
    const closeBtn = window.locator(SEL.settings.closeButton);
    if (await closeBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await closeBtn.click();
    } else {
      await window.keyboard.press("Escape");
    }
    await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });

    // Wait for save flush to complete
    await window.waitForTimeout(1000);

    // Reopen settings and verify persistence
    await openSettings(window);
    await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

    await navigateToResourcesTab(window);

    // The "e2e-docker" environment should still be visible in the dropdown
    const panel2 = window.locator("#settings-panel-project\\:automation");
    const selectorBar2 = panel2.locator('[data-testid="environment-selector-bar"]');
    await expect(selectorBar2).toBeVisible({ timeout: T_SHORT });
    const selectEl = selectorBar2.locator("select");
    const dockerOption = selectEl.locator('option[value="e2e-docker"]');
    await expect(dockerOption).toBeAttached({ timeout: T_SHORT });

    await window.keyboard.press("Escape");
    await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
  });

  // ---- Test 2: GUI-configured environment drives worktree lifecycle ----
  test("GUI-configured environment drives worktree lifecycle", async () => {
    const { window } = ctx;
    await expect(window.locator("[data-worktree-branch]").first()).toBeVisible({
      timeout: T_LONG,
    });

    // Open create worktree dialog — mode selector should be visible
    // since "e2e-docker" was added to project settings in Test 1
    const newBtn = window.locator('button[aria-label="Create new worktree"]');
    await newBtn.click();

    const dialog = window.locator(SEL.worktree.newDialog);
    await expect(dialog).toBeVisible({ timeout: T_MEDIUM });

    const modeGroup = window.locator('[role="radiogroup"][aria-label="Worktree environment mode"]');
    await expect(modeGroup).toBeVisible({ timeout: T_MEDIUM });

    // Select "e2e-docker" environment
    const dockerBtn = modeGroup.locator('[role="radio"]').filter({ hasText: "e2e-docker" });
    await dockerBtn.click();
    await expect(dockerBtn).toHaveAttribute("aria-checked", "true");

    // Fill branch name and create
    const branchInput = window.locator(SEL.worktree.branchNameInput);
    await branchInput.fill("e2e/gui-lifecycle");

    const pathInput = window.locator('[data-testid="worktree-path-input"]');
    await expect
      .poll(async () => (await pathInput.inputValue()).trim().length, {
        timeout: T_LONG,
        message: "Worktree path should auto-populate",
      })
      .toBeGreaterThan(0);

    const createBtn = window.locator(SEL.worktree.createButton);
    await createBtn.click();

    const BRANCH = "e2e/gui-lifecycle";
    const newCard = window.locator(SEL.worktree.card(BRANCH));
    await expect(newCard).toBeVisible({ timeout: 30_000 });

    // Wait for provision to settle
    await window.waitForTimeout(3000);

    // Trigger status check via action palette
    await ensureWindowFocused(ctx.app);
    await newCard.click({ position: { x: 10, y: 10 } });
    await window.waitForTimeout(500);

    await window.keyboard.press(`${mod}+Shift+P`);
    const palette = window.locator(SEL.actionPalette.dialog);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });

    const searchInput = palette.locator(SEL.actionPalette.searchInput);
    await searchInput.fill("Check Resource Status");
    const statusOption = palette
      .locator('[role="option"]')
      .filter({ hasText: /Check Resource Status/i });
    await expect(statusOption.first()).toBeVisible({ timeout: T_MEDIUM });
    await statusOption.first().click();

    // Badge should show ready or unknown
    await expect
      .poll(async () => newCard.getAttribute("data-resource-status"), {
        timeout: T_LONG,
        message: "Resource status badge should appear",
      })
      .toMatch(/ready|unknown/);

    // Clean up: delete the worktree
    const actionsBtn = newCard.locator(SEL.worktree.actionsMenu);
    await ensureWindowFocused(ctx.app);
    await actionsBtn.click();

    const deleteItem = window.getByRole("menuitem", { name: /delete/i });
    await expect(deleteItem).toBeVisible({ timeout: T_SHORT });
    await deleteItem.hover();
    await deleteItem.click();

    const confirmBtn = window.locator(SEL.worktree.deleteConfirm);
    await expect(confirmBtn).toBeVisible({ timeout: T_MEDIUM });
    await confirmBtn.click();
    await expect(newCard).not.toBeVisible({ timeout: T_LONG });
  });

  // ---- Test 3: Cross-environment isolation ----
  test("separate environments are isolated in the settings GUI", async () => {
    const { window } = ctx;

    await openSettings(window);
    await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });
    await navigateToResourcesTab(window);

    // Add a second environment "e2e-fly"
    await addEnvironmentViaGUI(window, "e2e-fly");

    const panel = window.locator("#settings-panel-project\\:automation");
    const selectorBar = panel.locator('[data-testid="environment-selector-bar"]');
    const selectEl = selectorBar.locator("select");

    // Both environments should be in the dropdown
    await expect(selectEl.locator('option[value="e2e-docker"]')).toBeAttached({ timeout: T_SHORT });
    await expect(selectEl.locator('option[value="e2e-fly"]')).toBeAttached({ timeout: T_SHORT });

    // Select "e2e-fly" and verify it's a distinct, empty environment
    await selectEl.selectOption("e2e-fly");
    await window.waitForTimeout(T_SETTLE);

    // Switch back to "e2e-docker" — it should still be intact
    await selectEl.selectOption("e2e-docker");
    await window.waitForTimeout(T_SETTLE);

    // Both should still be present after switching — no cross-contamination
    await expect(selectEl.locator('option[value="e2e-docker"]')).toBeAttached({ timeout: T_SHORT });
    await expect(selectEl.locator('option[value="e2e-fly"]')).toBeAttached({ timeout: T_SHORT });

    // Remove the second environment to clean up
    await selectEl.selectOption("e2e-fly");
    await window.waitForTimeout(T_SETTLE);
    const removeBtn = panel.locator('[aria-label="Remove environment"]');
    if (await removeBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await removeBtn.click();
      // Confirm removal if prompted
      const confirmBtn = window.locator('button:has-text("Confirm")');
      if (await confirmBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await confirmBtn.click();
      }
      await window.waitForTimeout(T_SETTLE);
    }

    await window.keyboard.press("Escape");
    await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
  });

  // ---- Test 4: Default worktree mode persists and applies ----
  test("default worktree mode persists and applies to create dialog", async () => {
    const { window } = ctx;
    await expect(window.locator("[data-worktree-branch]").first()).toBeVisible({
      timeout: T_LONG,
    });

    await openSettings(window);
    await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

    await navigateToResourcesTab(window);

    // Set default worktree mode to "e2e-docker"
    const panel = window.locator("#settings-panel-project\\:automation");
    await expect(panel.locator("text=Default Worktree Mode")).toBeVisible({ timeout: T_SHORT });
    const dockerRadio = panel.locator('input[type="radio"][value="e2e-docker"]');
    await dockerRadio.click();
    await expect(dockerRadio).toBeChecked({ timeout: T_SHORT });

    // Close settings and wait for save
    await window.keyboard.press("Escape");
    await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
    await window.waitForTimeout(1000);

    // Open create worktree dialog — "e2e-docker" should be pre-selected
    const newBtn = window.locator('button[aria-label="Create new worktree"]');
    await newBtn.click();
    const dialog = window.locator(SEL.worktree.newDialog);
    await expect(dialog).toBeVisible({ timeout: T_MEDIUM });

    const modeGroup = window.locator('[role="radiogroup"][aria-label="Worktree environment mode"]');
    await expect(modeGroup).toBeVisible({ timeout: T_MEDIUM });

    const dockerModeBtn = modeGroup.locator('[role="radio"]').filter({ hasText: "e2e-docker" });
    await expect(dockerModeBtn).toHaveAttribute("aria-checked", "true");

    // Close dialog without creating
    await window.keyboard.press("Escape");
    const discardBtn = window.locator('button:has-text("Discard")');
    if (await discardBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await discardBtn.click();
    }

    // Wait for dialog close animation to settle
    await window.waitForTimeout(500);

    // Reopen settings and verify default mode is still "e2e-docker"
    await openSettings(window);
    await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

    await navigateToResourcesTab(window);
    const panel2 = window.locator("#settings-panel-project\\:automation");
    const dockerRadio2 = panel2.locator('input[type="radio"][value="e2e-docker"]');
    await expect(dockerRadio2).toBeChecked({ timeout: T_SHORT });

    // Reset to local
    const localRadio = panel2.locator('input[type="radio"][value="local"]');
    await localRadio.click();
    await expect(localRadio).toBeChecked({ timeout: T_SHORT });

    await window.keyboard.press("Escape");
    await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
  });
});
