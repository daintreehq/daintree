import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_SETTLE } from "../../helpers/timeouts";

import { openSettings } from "../../helpers/panels";
let ctx: AppContext;
let fixtureCleanup: (() => void) | undefined;

test.describe.serial("Core: Settings Pages Load", () => {
  test.beforeAll(async () => {
    ctx = await launchApp();
    const { dir: fixtureDir, cleanup } = createFixtureRepo({ name: "settings-load" });
    fixtureCleanup = cleanup;
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Settings Load Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("General tab: Overview loads without hanging", async () => {
    const { window } = ctx;

    await test.step("Open settings dialog", async () => {
      await openSettings(window);
      await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });
    });

    await test.step("Verify General Overview content renders", async () => {
      // General is the default tab
      await expect(window.locator("h3", { hasText: "General" })).toBeVisible({ timeout: T_SHORT });

      // Overview subtab should show the System Status section
      const dialog = window.locator('[role="dialog"]');
      await expect(dialog.locator("text=System Status")).toBeVisible({ timeout: T_SHORT });
    });
  });

  test("General tab: Hibernation subtab loads", async () => {
    const { window } = ctx;

    // Click Hibernation subtab
    await window
      .locator(`${SEL.settings.subtabNav} button[role="tab"]`, { hasText: "Hibernation" })
      .click();

    // Verify loading text disappears (the key fix we're testing)
    await expect(window.locator("text=Loading hibernation settings...")).not.toBeVisible({
      timeout: T_MEDIUM,
    });

    // Verify either the config loaded (Auto-Hibernation heading) or error state rendered
    const autoHibernation = window.locator("#general-hibernation");
    const errorState = window.locator("text=Failed to load hibernation settings");
    await expect(autoHibernation.or(errorState)).toBeVisible({ timeout: T_SHORT });
  });

  test("General tab: Display subtab loads", async () => {
    const { window } = ctx;

    await window
      .locator(`${SEL.settings.subtabNav} button[role="tab"]`, { hasText: "Display" })
      .click();

    await expect(window.locator("#general-project-pulse")).toBeVisible({ timeout: T_SHORT });
  });

  test("Appearance tab loads with subtabs", async () => {
    const { window } = ctx;

    await test.step("Open Appearance tab and verify App subtab content", async () => {
      await window.locator(`${SEL.settings.navSidebar} button`, { hasText: "Appearance" }).click();
      await expect(window.locator("h3", { hasText: "Appearance" })).toBeVisible({
        timeout: T_SHORT,
      });

      // App subtab (default) should show the accent color section
      const settingsPanel = window.locator('[role="dialog"]');
      await expect(settingsPanel.locator('section[aria-label="Accent color"]')).toBeVisible({
        timeout: T_SHORT,
      });
    });

    await test.step("Switch to Terminal subtab and verify content", async () => {
      await window
        .locator(`${SEL.settings.subtabNav} button[role="tab"]`, { hasText: "Terminal" })
        .click();
      await expect(window.locator(SEL.settings.fontSizeInput)).toBeVisible({ timeout: T_SHORT });
    });
  });

  test("Keyboard tab loads", async () => {
    const { window } = ctx;

    await window.locator(`${SEL.settings.navSidebar} button`, { hasText: "Keyboard" }).click();
    await expect(window.locator("h3", { hasText: "Keyboard Shortcuts" })).toBeVisible({
      timeout: T_SHORT,
    });

    // Shortcuts search input should be visible
    await expect(window.locator(SEL.settings.shortcutsSearchInput)).toBeVisible({
      timeout: T_SHORT,
    });
  });

  test("Notifications tab loads", async () => {
    const { window } = ctx;

    await window.locator(`${SEL.settings.navSidebar} button`, { hasText: "Notifications" }).click();
    await expect(window.locator("h3", { hasText: "Notifications" })).toBeVisible({
      timeout: T_SHORT,
    });

    // Wait for loading to finish
    await expect(window.locator("text=Loading…")).not.toBeVisible({ timeout: T_MEDIUM });

    // Notification checkboxes should be visible
    await expect(window.locator(SEL.settings.notifCompletedCheckbox)).toBeVisible({
      timeout: T_SHORT,
    });
  });

  test("Privacy & Data tab loads with subtabs", async () => {
    const { window } = ctx;

    await test.step("Open Privacy & Data tab and verify Telemetry subtab", async () => {
      await window
        .locator(`${SEL.settings.navSidebar} button`, { hasText: "Privacy & Data" })
        .click();
      await expect(window.locator("h3", { hasText: "Privacy & Data" })).toBeVisible({
        timeout: T_SHORT,
      });

      // Telemetry subtab (default) - verify telemetry options
      await expect(window.locator("text=No data is collected").first()).toBeVisible({
        timeout: T_SHORT,
      });
    });

    await test.step("Switch to Data & Storage subtab and verify content", async () => {
      await window
        .locator(`${SEL.settings.subtabNav} button[role="tab"]`, { hasText: "Data & Storage" })
        .click();
      await expect(window.locator("button", { hasText: "Clear Cache" })).toBeVisible({
        timeout: T_SHORT,
      });
    });
  });

  test("Panel Grid tab loads with subtabs", async () => {
    const { window } = ctx;

    await test.step("Open Panel Grid tab and verify Performance subtab", async () => {
      await window.locator(`${SEL.settings.navSidebar} button`, { hasText: "Panel Grid" }).click();
      await expect(window.locator("h3", { hasText: "Panel Grid" })).toBeVisible({
        timeout: T_SHORT,
      });

      // Performance subtab (default) should show Performance Mode toggle
      await expect(window.locator(SEL.settings.performanceModeToggle)).toBeVisible({
        timeout: T_SHORT,
      });
    });

    await test.step("Cycle remaining subtabs and verify each becomes selected", async () => {
      const subtabs = ["Input", "Layout", "Scrollback", "Accessibility"];
      for (const subtab of subtabs) {
        await window
          .locator(`${SEL.settings.subtabNav} button[role="tab"]`, { hasText: subtab })
          .click();
        // Verify the subtab button becomes selected
        await expect(
          window.locator(`${SEL.settings.subtabNav} button[role="tab"][aria-selected="true"]`, {
            hasText: subtab,
          })
        ).toBeVisible({ timeout: T_SHORT });
      }
    });
  });

  test("Worktree tab loads", async () => {
    const { window } = ctx;

    await window.locator(`${SEL.settings.navSidebar} button`, { hasText: "Worktree" }).click();
    await expect(window.locator("h3", { hasText: "Worktree Paths" })).toBeVisible({
      timeout: T_SHORT,
    });

    // Wait for loading to finish
    await expect(window.locator("text=Loading settings...")).not.toBeVisible({
      timeout: T_MEDIUM,
    });

    // Worktree Path Pattern section should be visible
    await expect(window.locator("text=Worktree Path Pattern")).toBeVisible({ timeout: T_SHORT });
  });

  test("Toolbar tab loads", async () => {
    const { window } = ctx;

    await window.locator(`${SEL.settings.navSidebar} button`, { hasText: "Toolbar" }).click();
    await expect(window.locator("h3", { hasText: "Toolbar Customization" })).toBeVisible({
      timeout: T_SHORT,
    });
  });

  test("Environment tab loads", async () => {
    const { window } = ctx;

    await window.locator(`${SEL.settings.navSidebar} button`, { hasText: "Environment" }).click();
    await expect(window.locator("h3", { hasText: "Environment Variables" })).toBeVisible({
      timeout: T_SHORT,
    });
  });

  test("CLI Agents tab loads", async () => {
    const { window } = ctx;

    await window.locator(`${SEL.settings.navSidebar} button`, { hasText: "CLI Agents" }).click();
    await expect(window.locator("h3", { hasText: "CLI Agents" })).toBeVisible({
      timeout: T_SHORT,
    });

    // Wait for loading to finish
    await expect(window.locator("text=Loading settings...")).not.toBeVisible({
      timeout: T_MEDIUM,
    });

    // Agent dropdown should be visible
    await expect(window.locator(SEL.settings.agentDropdownTrigger)).toBeVisible({
      timeout: T_SHORT,
    });
  });

  test("Code Forge GitHub settings load", async () => {
    const { window } = ctx;

    await window
      .locator(SEL.settings.navSidebar)
      .getByRole("tab", { name: "Code Forge", exact: true })
      .click();
    await expect(window.locator("h3", { hasText: "Code Forge" })).toBeVisible({
      timeout: T_SHORT,
    });

    await expect(window.locator("text=Loading forge settings...")).not.toBeVisible({
      timeout: T_MEDIUM,
    });

    // Wait for loading to finish
    await expect(window.locator("text=Loading GitHub settings...")).not.toBeVisible({
      timeout: T_MEDIUM,
    });

    // Personal Access Token section should be visible
    await expect(window.locator("#github-token")).toBeVisible({ timeout: T_SHORT });
  });

  test("Integrations tab loads", async () => {
    const { window } = ctx;

    await window
      .locator(SEL.settings.navSidebar)
      .getByRole("tab", { name: "Integrations", exact: true })
      .click();
    // Integrations tab combines Editor and Image Viewer sections
    await expect(window.locator("h4", { hasText: "External editor" })).toBeVisible({
      timeout: T_SHORT,
    });
    await expect(window.locator("h4", { hasText: "Image viewer" })).toBeVisible({
      timeout: T_SHORT,
    });
  });

  test("Portal tab loads", async () => {
    const { window } = ctx;

    await window.locator(`${SEL.settings.navSidebar} button`, { hasText: "Portal" }).click();
    await expect(window.locator("h3", { hasText: "Portal Links" })).toBeVisible({
      timeout: T_SHORT,
    });
  });

  test("MCP Server tab loads", async () => {
    const { window } = ctx;

    await window.locator(`${SEL.settings.navSidebar} button`, { hasText: "MCP Server" }).click();
    await expect(window.locator("h3", { hasText: "MCP Server" })).toBeVisible({
      timeout: T_SHORT,
    });

    // MCP Server toggle should be visible and not stuck loading
    const mcpToggle = window.locator('[aria-label="Enable MCP server"]');
    await expect(mcpToggle).toBeVisible({ timeout: T_SHORT });
    // Toggle should not be disabled (loading=false)
    await expect(mcpToggle).not.toBeDisabled({ timeout: T_MEDIUM });
  });

  test("Troubleshooting tab loads", async () => {
    const { window } = ctx;

    await window
      .locator(`${SEL.settings.navSidebar} button`, { hasText: "Troubleshooting" })
      .click();
    await expect(window.locator("h3", { hasText: "Troubleshooting" })).toBeVisible({
      timeout: T_SHORT,
    });

    // Run Health Check button should be visible
    await expect(window.locator("button", { hasText: "Run Health Check" })).toBeVisible({
      timeout: T_SHORT,
    });

    // Close settings
    await window.keyboard.press("Escape");
    await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
  });

  // ── Project Settings: Variables tab loads ──────────────────

  test("Project Variables tab loads", async () => {
    const { window } = ctx;

    await test.step("Open settings and switch to Project scope", async () => {
      await openSettings(window);
      await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

      // Switch to Project scope (Radix Select)
      await window.locator('[aria-label="Settings scope"]').click();
      await window.locator('[role="option"]', { hasText: "Project" }).click();
      await window.waitForTimeout(T_SETTLE);
    });

    await test.step("Open Variables tab and verify editor renders", async () => {
      await window.locator(`${SEL.settings.navSidebar} button`, { hasText: "Variables" }).click();

      // The EnvironmentVariablesEditor heading should appear
      await expect(window.locator("h3", { hasText: "Environment Variables" })).toBeVisible({
        timeout: T_SHORT,
      });

      // Add Variable button should be visible. Two Environment Variables editors
      // can render (one under Environment tab, one under Variables tab); check
      // that at least one Add Variable button is present.
      await expect(window.getByRole("button", { name: "Add Variable" }).first()).toBeVisible({
        timeout: T_SHORT,
      });
    });

    await test.step("Close settings dialog", async () => {
      await window.keyboard.press("Escape");
      await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
    });
  });

  // ── Project Settings: Resources tab loads ─────────────────

  test("Project Resources tab loads", async () => {
    const { window } = ctx;

    await test.step("Open settings and switch to Project scope", async () => {
      await openSettings(window);
      await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

      // Switch to Project scope (Radix Select)
      await window.locator('[aria-label="Settings scope"]').click();
      await window.locator('[role="option"]', { hasText: "Project" }).click();
      await window.waitForTimeout(T_SETTLE);
    });

    await test.step("Open Worktree Setup tab and verify Resource Environments", async () => {
      await window
        .locator(`${SEL.settings.navSidebar} button`, { hasText: "Worktree Setup" })
        .click();

      // The Resource Environments heading should appear (scoped to the automation panel)
      const automationPanel = window.locator("#settings-panel-project\\:automation");
      await expect(automationPanel.locator("h2", { hasText: "Resource Environments" })).toBeVisible(
        {
          timeout: T_SHORT,
        }
      );

      // Default Worktree Mode section should be visible (scoped to automation panel)
      await expect(automationPanel.locator("text=Default Worktree Mode")).toBeVisible({
        timeout: T_SHORT,
      });
    });

    await test.step("Close settings dialog", async () => {
      await window.keyboard.press("Escape");
      await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
    });
  });
});
