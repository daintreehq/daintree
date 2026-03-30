import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_SETTLE } from "../helpers/timeouts";

import { openSettings } from "../helpers/panels";
let ctx: AppContext;

test.describe.serial("Core: Settings Tabs Coverage", () => {
  test.beforeAll(async () => {
    ctx = await launchApp();
    const fixtureDir = createFixtureRepo({ name: "settings-tabs" });
    await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Settings Tabs Test");
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

    // "App" subtab is the default — click the theme picker trigger to open the list
    const settingsPanel = window.locator('[role="dialog"]');
    const themeTrigger = settingsPanel.locator('[aria-controls="theme-listbox"]');
    await expect(themeTrigger).toBeVisible({ timeout: T_SHORT });
    await themeTrigger.click();
    const themeListbox = settingsPanel.locator('[role="listbox"][aria-label="Theme list"]');
    await expect(themeListbox).toBeVisible({ timeout: T_SHORT });

    // Select a different theme option from the list
    const options = themeListbox.locator('[role="option"]');
    const optionCount = await options.count();
    expect(optionCount).toBeGreaterThanOrEqual(2);

    // Find an option that is NOT currently selected and get its name
    let targetOption = options.first();
    let targetName = "";
    for (let i = 0; i < optionCount; i++) {
      const option = options.nth(i);
      const selected = await option.getAttribute("aria-selected");
      if (selected !== "true") {
        targetOption = option;
        targetName = (await option.textContent()) ?? "";
        break;
      }
    }

    await targetOption.click();
    // Picker closes on selection — verify trigger now shows the selected theme name
    await expect(themeListbox).not.toBeVisible({ timeout: T_SHORT });
    if (targetName) {
      await expect(themeTrigger).toContainText(targetName, { timeout: T_SHORT });
    }

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
    await expect(errorsButton).toHaveClass(/border-canopy-accent/, { timeout: T_SHORT });

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
});
