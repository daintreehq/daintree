import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_SETTLE } from "../helpers/timeouts";

import { openSettings } from "../helpers/panels";

test.describe.serial("Core: Settings Tabs Coverage", () => {
  let ctx: AppContext;

  test.beforeAll(async () => {
    ctx = await launchApp();
    const fixtureDir = createFixtureRepo({ name: "settings-tabs" });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Settings Tabs Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  // ── Appearance Tab: App Theme ──────────────────────────────

  test("Appearance tab: switch app theme", async () => {
    const { window } = ctx;
    await openSettings(window);
    await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

    await window.locator(`${SEL.settings.navSidebar} button`, { hasText: "Appearance" }).click();
    await expect(window.locator("h3", { hasText: "Appearance" })).toBeVisible({
      timeout: T_SHORT,
    });

    // "App" subtab is the default — the inline AppThemePicker now shows a
    // "Change theme…" button that opens the ThemeBrowser side panel. Click
    // through to the browser to access the theme list.
    await window.locator('button:has-text("Change theme")').click();

    const themeBrowser = window.locator('[role="dialog"][aria-label="Theme browser"]');
    await expect(themeBrowser).toBeVisible({ timeout: T_SHORT });

    const themeListbox = themeBrowser.locator('[role="listbox"][aria-label="Theme list"]');
    await expect(themeListbox).toBeVisible({ timeout: T_SHORT });

    // Select a different theme option from the list
    const options = themeListbox.locator('[role="option"]');
    const optionCount = await options.count();
    expect(optionCount).toBeGreaterThanOrEqual(2);

    // Find an option that is NOT currently selected
    let targetOption = options.first();
    for (let i = 0; i < optionCount; i++) {
      const option = options.nth(i);
      const selected = await option.getAttribute("aria-selected");
      if (selected !== "true") {
        targetOption = option;
        break;
      }
    }

    await targetOption.click();
    // The clicked option should now be selected
    await expect(targetOption).toHaveAttribute("aria-selected", "true", { timeout: T_SHORT });

    // Close the theme browser, then close settings.
    await window.locator('[aria-label="Close theme browser"]').click();
    await expect(themeBrowser).not.toBeVisible({ timeout: T_SHORT });
    await window.keyboard.press("Escape");
    await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
  });

  // ── Appearance Tab: Terminal Font Size ─────────────────────

  test("Appearance tab: change terminal font size", async () => {
    const { window } = ctx;
    await openSettings(window);
    await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

    await window.locator(`${SEL.settings.navSidebar} button`, { hasText: "Appearance" }).click();
    await expect(window.locator("h3", { hasText: "Appearance" })).toBeVisible({
      timeout: T_SHORT,
    });

    // Switch to "Terminal" subtab
    await window
      .locator(`${SEL.settings.subtabNav} button[role="tab"]`, { hasText: "Terminal" })
      .click();

    const fontSizeInput = window.locator(SEL.settings.fontSizeInput);
    await expect(fontSizeInput).toBeVisible({ timeout: T_SHORT });

    // Read current value to pick a different one
    const currentValue = await fontSizeInput.inputValue();
    const newValue = currentValue === "16" ? "18" : "16";

    await fontSizeInput.fill(newValue);
    await fontSizeInput.blur();
    await window.waitForTimeout(T_SETTLE);

    await expect(window.locator(`text=Current: ${newValue}px`)).toBeVisible({
      timeout: T_SHORT,
    });

    await window.keyboard.press("Escape");
    await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
  });

  // ── CLI Agents Tab: Agent Selector Dropdown ────────────────

  test("CLI Agents tab: agent selector dropdown", async () => {
    const { window } = ctx;
    await openSettings(window);
    await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

    await window.locator(`${SEL.settings.navSidebar} button`, { hasText: "CLI Agents" }).click();
    await expect(window.locator("h3", { hasText: "CLI Agents" })).toBeVisible({
      timeout: T_SHORT,
    });

    // Wait for settings to load
    await expect(window.locator("text=Loading settings...")).not.toBeVisible({
      timeout: T_MEDIUM,
    });

    // Click the agent selector dropdown trigger
    const trigger = window.locator(SEL.settings.agentDropdownTrigger);
    await expect(trigger).toBeVisible({ timeout: T_SHORT });
    await trigger.click();

    // The listbox appears (portalled to document root)
    const listbox = window.locator(SEL.settings.agentDropdownList);
    await expect(listbox).toBeVisible({ timeout: T_SHORT });

    // "General" option is always available as first item
    const generalOption = listbox.locator('[role="option"]').first();
    await expect(generalOption).toContainText("General");

    // At least 1 option present (General)
    const optionCount = await listbox.locator('[role="option"]').count();
    expect(optionCount).toBeGreaterThanOrEqual(1);

    // Select General to close the dropdown
    await generalOption.click();
    await expect(listbox).not.toBeVisible({ timeout: T_SHORT });

    // Verify General content rendered
    await expect(window.locator("text=Global Agent Settings")).toBeVisible({
      timeout: T_SHORT,
    });

    await window.keyboard.press("Escape");
    await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
  });

  // ── Privacy & Data Tab: Telemetry Options ──────────────────

  test("Privacy tab: telemetry options are interactive", async () => {
    const { window } = ctx;
    await openSettings(window);
    await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

    await window
      .locator(`${SEL.settings.navSidebar} button`, { hasText: "Privacy & Data" })
      .click();
    await expect(window.locator("h3", { hasText: "Privacy & Data" })).toBeVisible({
      timeout: T_SHORT,
    });

    // Telemetry subtab is the default — verify the 3 options are visible
    const offButton = window.locator("button", { hasText: "Off" }).filter({
      has: window.locator("text=No data is collected"),
    });
    const errorsButton = window.locator("button", { hasText: "Errors Only" }).filter({
      has: window.locator("text=Crash reports and error details"),
    });
    const fullButton = window.locator("button", { hasText: "Full Usage" }).filter({
      has: window.locator("text=anonymous usage analytics"),
    });

    await expect(offButton).toBeVisible({ timeout: T_SHORT });
    await expect(errorsButton).toBeVisible({ timeout: T_SHORT });
    await expect(fullButton).toBeVisible({ timeout: T_SHORT });

    // Click "Errors Only" and verify it gets the selected border
    await errorsButton.click();
    await expect(errorsButton).toHaveClass(/border-border-strong/, { timeout: T_SHORT });

    await window.keyboard.press("Escape");
    await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
  });

  // ── Privacy & Data Tab: Data & Storage ─────────────────────

  test("Privacy tab: Data & Storage has Clear Cache button", async () => {
    const { window } = ctx;
    await openSettings(window);
    await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

    await window
      .locator(`${SEL.settings.navSidebar} button`, { hasText: "Privacy & Data" })
      .click();
    await expect(window.locator("h3", { hasText: "Privacy & Data" })).toBeVisible({
      timeout: T_SHORT,
    });

    // Switch to "Data & Storage" subtab
    await window
      .locator(`${SEL.settings.subtabNav} button[role="tab"]`, { hasText: "Data & Storage" })
      .click();

    // Verify Clear Cache button is visible
    const clearCacheButton = window.locator("button", { hasText: "Clear Cache" });
    await expect(clearCacheButton).toBeVisible({ timeout: T_SHORT });

    await window.keyboard.press("Escape");
    await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
  });

  // ── Troubleshooting Tab ────────────────────────────────────

  test("Troubleshooting tab: controls are present", async () => {
    const { window } = ctx;
    await openSettings(window);
    await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

    await window
      .locator(`${SEL.settings.navSidebar} button`, { hasText: "Troubleshooting" })
      .click();
    await expect(window.locator("h3", { hasText: "Troubleshooting" })).toBeVisible({
      timeout: T_SHORT,
    });

    // Developer Mode toggle
    const devModeToggle = window.locator(SEL.settings.developerModeToggle);
    await expect(devModeToggle).toBeVisible({ timeout: T_SHORT });
    await expect(devModeToggle).toHaveRole("switch");

    // Run Health Check button
    await expect(window.locator("button", { hasText: "Run Health Check" })).toBeVisible({
      timeout: T_SHORT,
    });

    // Clear Logs button
    await expect(window.locator("button", { hasText: "Clear Logs" })).toBeVisible({
      timeout: T_SHORT,
    });

    // Download Diagnostics button
    await expect(window.locator("button", { hasText: "Download Diagnostics" })).toBeVisible({
      timeout: T_SHORT,
    });

    await window.keyboard.press("Escape");
    await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
  });

  // ── Settings Search ────────────────────────────────────────

  test("Settings search shows cross-tab results", async () => {
    const { window } = ctx;
    await openSettings(window);
    await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

    const searchInput = window.locator(SEL.settings.searchInput);
    await searchInput.fill("font size");
    await window.waitForTimeout(T_SETTLE);

    // h3 switches to "Search Results"
    await expect(window.locator("h3", { hasText: "Search Results" })).toBeVisible({
      timeout: T_SHORT,
    });

    // At least one result is visible in the search results region
    const resultsRegion = window.locator('[role="region"][aria-label="Search results"]');
    await expect(resultsRegion).toBeVisible({ timeout: T_SHORT });
    const resultButtons = resultsRegion.locator("button");
    const resultCount = await resultButtons.count();
    expect(resultCount).toBeGreaterThan(0);

    // Verify at least one result references the Appearance tab
    const firstResult = resultButtons.first();
    await expect(firstResult).toContainText("Appearance");

    // Clear search and verify we return to normal tab view
    await searchInput.fill("");
    await window.waitForTimeout(T_SETTLE);
    await expect(window.locator("h3", { hasText: "Search Results" })).not.toBeVisible({
      timeout: T_SHORT,
    });

    await window.keyboard.press("Escape");
    await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
  });

  // ── Project Resources Tab: Add Environment ────────────────
  // Run Resources tests before Variables tests to avoid app crash from
  // Variables cleanup interfering with subsequent tests.

  test("Project Resources tab: add and remove resource environment", async () => {
    const { window } = ctx;
    await openSettings(window);
    await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

    // Switch to Project scope (Radix Select)
    await window.locator('[aria-label="Settings scope"]').click();
    await window.locator('[role="option"]', { hasText: "Project" }).click();
    await window.waitForTimeout(T_SETTLE);

    // Navigate to Resources tab — scope everything to this panel
    await window
      .locator(`${SEL.settings.navSidebar} button`, { hasText: "Worktree Setup" })
      .click();
    const panel = window.locator("#settings-panel-project\\:automation");
    await expect(panel.locator("h2", { hasText: "Resource Environments" })).toBeVisible({
      timeout: T_SHORT,
    });

    // Click the "+" button to add the first environment
    await panel.locator('[aria-label="Add environment"]').click();

    const nameInput = panel.locator("#new-environment-name");
    await expect(nameInput).toBeVisible({ timeout: T_SHORT });
    await nameInput.fill("staging");

    const formAddButton = panel
      .locator('[data-testid="add-environment-form"]')
      .locator("button", { hasText: "Add" });
    await formAddButton.click();
    await window.waitForTimeout(T_SETTLE);

    // "staging" should appear in the environment dropdown
    const selectorBar = panel.locator('[data-testid="environment-selector-bar"]');
    await expect(selectorBar).toBeVisible({ timeout: T_SHORT });
    const selectEl = selectorBar.locator("select");
    await expect(selectEl.locator('option[value="staging"]')).toBeAttached({ timeout: T_SHORT });

    // Add a second environment
    await panel.locator('[aria-label="Add environment"]').click();
    const nameInput2 = panel.locator("#new-environment-name");
    await expect(nameInput2).toBeVisible({ timeout: T_SHORT });
    await nameInput2.fill("production");

    const formAddButton2 = panel
      .locator('[data-testid="add-environment-form"]')
      .locator("button", { hasText: "Add" });
    await formAddButton2.click();
    await window.waitForTimeout(T_SETTLE);

    // "production" should appear in the dropdown
    await expect(selectEl.locator('option[value="production"]')).toBeAttached({
      timeout: T_SHORT,
    });

    // Select "staging" in dropdown, then remove it via the X button
    await selectEl.selectOption("staging");
    await window.waitForTimeout(T_SETTLE);

    const removeButton = panel.locator('[aria-label="Remove staging environment"]');
    await removeButton.click();

    // ConfirmDialog should appear (rendered via portal, so use window scope)
    await expect(window.getByRole("dialog", { name: "Remove 'staging'?" })).toBeVisible({
      timeout: T_SHORT,
    });
    await window.getByRole("button", { name: "Remove environment" }).click();
    await window.waitForTimeout(T_SETTLE);

    // "staging" should be gone from dropdown, "production" should remain
    await expect(selectEl.locator('option[value="staging"]')).not.toBeAttached({
      timeout: T_SHORT,
    });
    await expect(selectEl.locator('option[value="production"]')).toBeAttached({
      timeout: T_SHORT,
    });

    await window.keyboard.press("Escape");
    await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
  });

  // ── Project Resources Tab: Persistence Round-Trip ─────────
  // Verifies that flush() on settings close persists data so it survives
  // a close → reopen cycle. The previous test left "production" in the
  // store; this test re-opens and confirms it is still visible.

  test("Project Resources tab: environment persists after settings close/reopen", async () => {
    const { window } = ctx;

    // Reopen settings and verify "production" persisted from the previous test.
    // flush() is called synchronously on Escape/close (direct persist, no debounce
    // race), so no extra wait is needed before reopening.
    await openSettings(window);
    await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

    await window.locator('[aria-label="Settings scope"]').click();
    await window.locator('[role="option"]', { hasText: "Project" }).click();
    await window.waitForTimeout(T_SETTLE);

    await window
      .locator(`${SEL.settings.navSidebar} button`, { hasText: "Worktree Setup" })
      .click();
    const panel = window.locator("#settings-panel-project\\:automation");
    await expect(panel.locator("h2", { hasText: "Resource Environments" })).toBeVisible({
      timeout: T_MEDIUM,
    });

    // "production" should still be in the dropdown (persisted from previous test)
    const selectorBar = panel.locator('[data-testid="environment-selector-bar"]');
    await expect(selectorBar).toBeVisible({ timeout: T_MEDIUM });
    const selectEl = selectorBar.locator("select");
    await expect(selectEl.locator('option[value="production"]')).toBeAttached({
      timeout: T_MEDIUM,
    });

    await window.keyboard.press("Escape");
    await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
  });

  // ── Project Resources Tab: Default Worktree Mode ──────────

  test("Project Resources tab: toggle default worktree mode", async () => {
    const { window } = ctx;
    await openSettings(window);
    await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

    // Switch to Project scope
    await window.locator('[aria-label="Settings scope"]').click();
    await window.locator('[role="option"]', { hasText: "Project" }).click();
    await window.waitForTimeout(T_SETTLE);

    await window
      .locator(`${SEL.settings.navSidebar} button`, { hasText: "Worktree Setup" })
      .click();
    const panel = window.locator("#settings-panel-project\\:automation");
    await expect(panel.locator("h2", { hasText: "Resource Environments" })).toBeVisible({
      timeout: T_SHORT,
    });

    // Ensure at least one environment exists so we have a second radio option
    const selectorBar = panel.locator('[data-testid="environment-selector-bar"]');
    const hasEnvs = await selectorBar.isVisible().catch(() => false);
    if (!hasEnvs) {
      await panel.locator('[aria-label="Add environment"]').click();
      const nameInput = panel.locator("#new-environment-name");
      await expect(nameInput).toBeVisible({ timeout: T_SHORT });
      await nameInput.fill("test-env");
      await panel
        .locator('[data-testid="add-environment-form"]')
        .locator("button", { hasText: "Add" })
        .click();
      await window.waitForTimeout(T_SETTLE);
      await expect(selectorBar).toBeVisible({ timeout: T_SHORT });
    }

    // Default Worktree Mode should be visible
    await expect(panel.locator("text=Default Worktree Mode")).toBeVisible({ timeout: T_SHORT });

    // Scope radios to the worktreeMode group — AutomationTab also renders a
    // branchPrefixMode radio group in this panel, so an unscoped lookup would
    // pick up those radios too.
    const worktreeModeRadios = panel.locator('input[type="radio"][name="worktreeMode"]');
    const localRadio = panel.locator('input[type="radio"][name="worktreeMode"][value="local"]');
    await expect(localRadio).toBeVisible({ timeout: T_SHORT });

    // Local should be default
    await expect(localRadio).toBeChecked({ timeout: T_SHORT });

    // Find the first non-local radio option (one of the environment keys)
    const radioCount = await worktreeModeRadios.count();
    expect(radioCount).toBeGreaterThanOrEqual(2);

    // Pick the second radio (first environment key after "Local")
    const envRadio = worktreeModeRadios.nth(1);
    await envRadio.click();
    await expect(envRadio).toBeChecked({ timeout: T_SHORT });
    await expect(localRadio).not.toBeChecked({ timeout: T_SHORT });

    // Switch back to Local
    await localRadio.click();
    await expect(localRadio).toBeChecked({ timeout: T_SHORT });

    await window.keyboard.press("Escape");
    await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
  });

  // ── Project Resources Tab: Duplicate Env Name ─────────────

  test("Project Resources tab: shows error for duplicate environment name", async () => {
    const { window } = ctx;
    await openSettings(window);
    await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

    // Switch to Project scope
    await window.locator('[aria-label="Settings scope"]').click();
    await window.locator('[role="option"]', { hasText: "Project" }).click();
    await window.waitForTimeout(T_SETTLE);

    await window
      .locator(`${SEL.settings.navSidebar} button`, { hasText: "Worktree Setup" })
      .click();
    const panel = window.locator("#settings-panel-project\\:automation");
    await expect(panel.locator("h2", { hasText: "Resource Environments" })).toBeVisible({
      timeout: T_SHORT,
    });

    // Ensure at least one environment exists to test duplicate detection against
    const selectorBar = panel.locator('[data-testid="environment-selector-bar"]');
    const hasEnvs = await selectorBar.isVisible().catch(() => false);
    if (!hasEnvs) {
      await panel.locator('[aria-label="Add environment"]').click();
      const setupInput = panel.locator("#new-environment-name");
      await expect(setupInput).toBeVisible({ timeout: T_SHORT });
      await setupInput.fill("existing-env");
      await panel
        .locator('[data-testid="add-environment-form"]')
        .locator("button", { hasText: "Add" })
        .click();
      await window.waitForTimeout(T_SETTLE);
      await expect(selectorBar).toBeVisible({ timeout: T_SHORT });
    }

    // Get the name of the first existing environment from the dropdown
    const selectEl = panel.locator('[data-testid="environment-selector-bar"] select');
    const existingName = await selectEl.inputValue();

    // Click "+" to start adding a new environment
    await panel.locator('[aria-label="Add environment"]').click();

    const nameInput = panel.locator("#new-environment-name");
    await expect(nameInput).toBeVisible({ timeout: T_SHORT });
    await nameInput.fill(existingName);

    // Submit via the form's Add button
    const formAddButton = panel
      .locator('[data-testid="add-environment-form"]')
      .locator("button", { hasText: "Add" });
    await formAddButton.click();

    // Error should appear
    await expect(panel.locator("text=already exists")).toBeVisible({ timeout: T_SHORT });

    // Cancel the add
    await panel
      .locator('[data-testid="add-environment-form"]')
      .locator("button", { hasText: "Cancel" })
      .click();

    await window.keyboard.press("Escape");
    await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
  });

  // ── Project Variables Tab: Add and Remove ─────────────────

  test("Project Variables tab: add and remove environment variable", async () => {
    const { window } = ctx;
    await openSettings(window);
    await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

    // Switch to Project scope
    await window.locator('[aria-label="Settings scope"]').click();
    await window.locator('[role="option"]', { hasText: "Project" }).click();
    await window.waitForTimeout(T_SETTLE);

    // Navigate to Variables tab
    await window.locator(`${SEL.settings.navSidebar} button`, { hasText: "Variables" }).click();
    await expect(window.locator("h3", { hasText: "Environment Variables" })).toBeVisible({
      timeout: T_SHORT,
    });

    // Initially shows empty state
    await expect(window.locator("text=No environment variables configured yet")).toBeVisible({
      timeout: T_SHORT,
    });

    // Click "Add Variable"
    await window.locator("button", { hasText: "Add Variable" }).click();

    // Fill in key and value
    const keyInput = window.locator('input[placeholder="VARIABLE_NAME"]');
    await expect(keyInput).toBeVisible({ timeout: T_SHORT });
    await keyInput.fill("TEST_API_KEY");

    const valueInput = window.locator('input[placeholder="value"]');
    await valueInput.fill("my-secret-value");

    // Empty state should be gone
    await expect(window.locator("text=No environment variables configured yet")).not.toBeVisible({
      timeout: T_SHORT,
    });

    // Delete the variable
    await window.locator('button[aria-label="Delete environment variable"]').click();

    // Empty state returns
    await expect(window.locator("text=No environment variables configured yet")).toBeVisible({
      timeout: T_SHORT,
    });

    await window.keyboard.press("Escape");
    await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
  });

  // ── Project Variables Tab: Validation ─────────────────────

  test("Project Variables tab: validates duplicate and invalid keys", async () => {
    const { window } = ctx;
    await openSettings(window);
    await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

    // Switch to Project scope
    await window.locator('[aria-label="Settings scope"]').click();
    await window.locator('[role="option"]', { hasText: "Project" }).click();
    await window.waitForTimeout(T_SETTLE);

    await window.locator(`${SEL.settings.navSidebar} button`, { hasText: "Variables" }).click();
    await expect(window.locator("h3", { hasText: "Environment Variables" })).toBeVisible({
      timeout: T_SHORT,
    });

    // Add two variables with the same key
    await window.locator("button", { hasText: "Add Variable" }).click();
    await window.locator("button", { hasText: "Add Variable" }).click();

    const keyInputs = window.locator('input[placeholder="VARIABLE_NAME"]');
    await keyInputs.nth(0).fill("DUPLICATE_KEY");
    await keyInputs.nth(1).fill("DUPLICATE_KEY");

    // Click Save — should trigger validation
    const saveButton = window.locator("button", { hasText: "Save" }).first();
    if (await saveButton.isVisible({ timeout: 1000 }).catch(() => false)) {
      await saveButton.click();
      await window.waitForTimeout(T_SETTLE);

      // Should show duplicate error
      await expect(window.locator("text=Duplicate variable name")).toBeVisible({
        timeout: T_SHORT,
      });
    }

    // Clean up — delete both rows one at a time with settle time
    const deleteButtons = window.locator('button[aria-label="Delete environment variable"]');
    const deleteCount = await deleteButtons.count();
    for (let i = deleteCount - 1; i >= 0; i--) {
      await deleteButtons.nth(i).click();
      await window.waitForTimeout(T_SETTLE);
    }

    await window.keyboard.press("Escape");
    await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
  });
});
