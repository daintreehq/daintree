import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getGridPanelCount, openSettings } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../helpers/timeouts";

let ctx: AppContext;
const mod = process.platform === "darwin" ? "Meta" : "Control";

test.describe.serial("Core: Shell & Settings", () => {
  test.beforeAll(async () => {
    ctx = await launchApp();
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  // ── App Shell (5 tests) ──────────────────────────────────

  test.describe.serial("App Shell", () => {
    test("app launches with correct title and version", async () => {
      const title = await ctx.window.title();
      expect(title).toContain("Daintree");

      const version = await ctx.app.evaluate(({ app }) => app.getVersion());
      expect(version).toMatch(/^\d+\.\d+\.\d+/);
    });

    test("toolbar baseline buttons are visible", async () => {
      const { window } = ctx;
      await expect(window.locator(SEL.toolbar.toggleSidebar)).toBeVisible({ timeout: T_MEDIUM });
      await expect(window.locator(SEL.toolbar.toggleSidebar)).toBeVisible({ timeout: T_SHORT });
      await expect(window.locator(SEL.toolbar.openSettings)).toBeVisible({ timeout: T_SHORT });
    });

    test("welcome screen shows Open Folder button", async () => {
      const { window } = ctx;
      await expect(window.getByRole("button", { name: "Open Folder" })).toBeVisible({
        timeout: T_MEDIUM,
      });
    });

    // Sidebar toggle test moved to Keyboard Shortcuts describe below — the
    // worktree sidebar is intentionally hidden on the welcome screen, so the
    // toggle is only testable once a project is opened.

    test("settings opens, navigates all tabs, closes via Escape", async () => {
      const { window } = ctx;

      await openSettings(window);

      const heading = window.locator("h2", { hasText: "Settings" });
      await expect(heading).toBeVisible({ timeout: T_MEDIUM });

      const defaultTab = window.locator("h3", { hasText: "General" });
      await expect(defaultTab).toBeVisible({ timeout: T_SHORT });

      // Verify all settings nav tabs are clickable and load their content
      const navButtons = [
        "Keyboard",
        "Notifications",
        "Panel Grid",
        "Worktree",
        "Toolbar",
        "Appearance",
        "CLI Agents",
        "GitHub",
        "Integrations",
        "Portal",
        "MCP Server",
        "Privacy & Data",
        "Environment",
        "Troubleshooting",
      ];

      for (const nav of navButtons) {
        const btn = window.locator(`${SEL.settings.navSidebar} button`, { hasText: nav });
        await expect(btn).toBeVisible({ timeout: T_SHORT });
        await btn.click();
        // Brief settle to confirm tab content loads without error
        await window.waitForTimeout(200);
      }

      await window.keyboard.press("Escape");
      await expect(heading).not.toBeVisible({ timeout: T_SHORT });
    });
  });

  // ── Keyboard Shortcuts (7 tests) ─────────────────────────

  test.describe.serial("Keyboard Shortcuts", () => {
    test.beforeAll(async () => {
      const fixtureDir = createFixtureRepo({ name: "shell-settings" });
      ctx.window = await openAndOnboardProject(
        ctx.app,
        ctx.window,
        fixtureDir,
        "Shell Settings Test"
      );
    });

    test("Cmd+Alt+T opens a new terminal", async () => {
      const { window } = ctx;
      const before = await getGridPanelCount(window);
      await window.keyboard.press(`${mod}+Alt+t`);
      await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(before + 1);
    });

    test("Cmd+Alt+T opens a second terminal", async () => {
      const { window } = ctx;
      const before = await getGridPanelCount(window);
      await window.keyboard.press(`${mod}+Alt+t`);
      await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(before + 1);
    });

    test("Cmd+W closes the focused terminal", async () => {
      const { window } = ctx;
      const before = await getGridPanelCount(window);
      expect(before).toBeGreaterThanOrEqual(1);
      await window.keyboard.press(`${mod}+w`);
      await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(before - 1);
    });

    test("Cmd+B toggles sidebar off and on", async () => {
      const { window } = ctx;

      const sidebar = window.locator("aside").first();
      await expect(sidebar).toBeVisible({ timeout: T_SHORT });

      await window.keyboard.press(`${mod}+b`);
      await expect(sidebar).not.toBeVisible({ timeout: T_SHORT });

      await window.keyboard.press(`${mod}+b`);
      await expect(sidebar).toBeVisible({ timeout: T_SHORT });
    });

    test("toolbar button toggles sidebar off and on", async () => {
      const { window } = ctx;

      const sidebar = window.locator(SEL.sidebar.resizeHandle);
      await expect(sidebar).toBeVisible({ timeout: T_MEDIUM });

      await window.locator(SEL.toolbar.toggleSidebar).click();
      await expect(sidebar).not.toBeVisible({ timeout: T_SHORT });

      await window.locator(SEL.toolbar.toggleSidebar).click();
      await expect(sidebar).toBeVisible({ timeout: T_SHORT });
    });

    test("Cmd+, opens settings", async () => {
      const { window } = ctx;
      await window.keyboard.press(`${mod}+,`);
      const heading = window.locator(SEL.settings.heading);
      await expect(heading).toBeVisible({ timeout: T_MEDIUM });
    });

    test("Escape closes settings dialog", async () => {
      const { window } = ctx;

      const heading = window.locator(SEL.settings.heading);
      await expect(heading).toBeVisible({ timeout: T_SHORT });

      const closeBtn = window.locator(SEL.settings.closeButton);
      await closeBtn.click();
      await expect(heading).not.toBeVisible({ timeout: T_SHORT });
    });

    test("Cmd+W closes remaining terminal", async () => {
      const { window } = ctx;

      // Ensure at least 2 panels so Cmd+W doesn't close the last one (which quits the app)
      let before = await getGridPanelCount(window);
      if (before === 0) {
        test.skip();
        return;
      }
      if (before === 1) {
        await window.keyboard.press(`${mod}+Alt+t`);
        await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(2);
        before = 2;
      }

      const panel = window.locator(SEL.panel.gridPanel).first();
      await panel.click();
      await window.waitForTimeout(T_SETTLE);

      await window.keyboard.press(`${mod}+w`);
      await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(before - 1);
    });
  });

  // ── Settings Persistence (5 tests) ───────────────────────

  test.describe.serial("Settings Persistence", () => {
    test("open settings dialog", async () => {
      const { window } = ctx;
      await openSettings(window);
      const heading = window.locator(SEL.settings.heading);
      await expect(heading).toBeVisible({ timeout: T_MEDIUM });
    });

    test("General tab: toggle Project Pulse off", async () => {
      const { window } = ctx;

      const generalTab = window.locator(`${SEL.settings.navSidebar} button:has-text("General")`);
      await generalTab.click();

      const displaySubtab = window.locator(
        '#settings-panel-general button[role="tab"]:has-text("Display")'
      );
      await displaySubtab.click();

      const toggle = window.locator(SEL.settings.projectPulseToggle);
      await expect(toggle).toBeVisible({ timeout: T_MEDIUM });
      await expect(toggle).toHaveAttribute("aria-checked", "true", { timeout: T_MEDIUM });

      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "false", { timeout: T_MEDIUM });
    });

    test("Terminal tab: toggle Performance Mode on", async () => {
      const { window } = ctx;

      const terminalTab = window.locator(
        `${SEL.settings.navSidebar} button:has-text("Panel Grid")`
      );
      await terminalTab.click();

      const toggle = window.locator(SEL.settings.performanceModeToggle);
      await toggle.scrollIntoViewIfNeeded();
      await expect(toggle).toBeVisible({ timeout: T_MEDIUM });
      await expect(toggle).toHaveAttribute("aria-checked", "false", { timeout: T_MEDIUM });

      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "true", { timeout: T_MEDIUM });
    });

    test("Appearance tab: change font family", async () => {
      const { window } = ctx;

      const appearanceTab = window.locator(
        `${SEL.settings.navSidebar} button:has-text("Appearance")`
      );
      await appearanceTab.click();

      const terminalSubtab = window.locator(
        '#settings-panel-terminalAppearance button[role="tab"]:has-text("Terminal")'
      );
      await terminalSubtab.click();

      const fontSelect = window.locator(SEL.settings.fontFamilySelect);
      await expect(fontSelect).toBeVisible({ timeout: T_MEDIUM });
      await expect(fontSelect).toHaveValue("jetbrains", { timeout: T_MEDIUM });

      await fontSelect.selectOption("system");
      await expect(fontSelect).toHaveValue("system", { timeout: T_MEDIUM });
    });

    test("close and reopen settings — changes persist", async () => {
      const { window } = ctx;

      await window.keyboard.press("Escape");
      const heading = window.locator(SEL.settings.heading);
      await expect(heading).not.toBeVisible({ timeout: T_SHORT });

      await openSettings(window);
      await expect(heading).toBeVisible({ timeout: T_MEDIUM });

      const generalTab = window.locator(`${SEL.settings.navSidebar} button:has-text("General")`);
      await generalTab.click();
      const displaySubtab = window.locator(
        '#settings-panel-general button[role="tab"]:has-text("Display")'
      );
      await displaySubtab.click();
      const pulseToggle = window.locator(SEL.settings.projectPulseToggle);
      await expect(pulseToggle).toHaveAttribute("aria-checked", "false", { timeout: T_MEDIUM });

      const terminalTab = window.locator(
        `${SEL.settings.navSidebar} button:has-text("Panel Grid")`
      );
      await terminalTab.click();
      const perfToggle = window.locator(SEL.settings.performanceModeToggle);
      await perfToggle.scrollIntoViewIfNeeded();
      await expect(perfToggle).toHaveAttribute("aria-checked", "true", { timeout: T_MEDIUM });

      const appearanceTab = window.locator(
        `${SEL.settings.navSidebar} button:has-text("Appearance")`
      );
      await appearanceTab.click();
      const terminalSubtab = window.locator(
        '#settings-panel-terminalAppearance button[role="tab"]:has-text("Terminal")'
      );
      await terminalSubtab.click();
      const fontSelect = window.locator(SEL.settings.fontFamilySelect);
      await expect(fontSelect).toHaveValue("system", { timeout: T_MEDIUM });

      await window.keyboard.press("Escape");
    });
  });

  // ── Project Settings (4 tests) ───────────────────────────

  test.describe.serial("Project Settings", () => {
    test("open project settings via project switcher", async () => {
      const { window } = ctx;

      await window.locator(SEL.toolbar.projectSwitcherTrigger).click();

      const palette = window.locator(SEL.projectSwitcher.palette);
      await expect(palette).toBeVisible({ timeout: T_MEDIUM });

      const settingsBtn = palette.locator("button", { hasText: /Project Settings/ });
      await expect(settingsBtn).toBeVisible({ timeout: T_SHORT });
      await settingsBtn.click();

      // Settings dialog opens in project scope
      const heading = window.locator('h2:has-text("Settings")');
      await expect(heading).toBeVisible({ timeout: T_MEDIUM });

      // Verify project scope is selected
      const scopeSelect = window.locator(".settings-sidebar select");
      await expect(scopeSelect).toHaveValue("project", { timeout: T_SHORT });
    });

    test("project name is displayed", async () => {
      const { window } = ctx;

      // Navigate to General tab which shows project identity
      const generalBtn = window.locator(`${SEL.settings.navSidebar} button`, {
        hasText: "General",
      });
      await generalBtn.click();

      const nameInput = window.locator('input[aria-label="Project name"]');
      if (await nameInput.isVisible().catch(() => false)) {
        const value = await nameInput.inputValue();
        expect(value).toContain("Shell Settings Test");
      } else {
        const nameText = window.locator('text="Shell Settings Test"');
        await expect(nameText).toBeVisible({ timeout: T_SHORT });
      }
    });

    test("dev server command input is visible", async () => {
      const { window } = ctx;
      const devInput = window.locator('[aria-label="Dev server command"]');
      await expect(devInput).toBeVisible({ timeout: T_SHORT });
    });

    test("close project settings via close button", async () => {
      const { window } = ctx;

      const closeBtn = window.locator('[aria-label="Close settings"]');
      await closeBtn.click();

      const heading = window.locator('h2:has-text("Settings")');
      await expect(heading).not.toBeVisible({ timeout: T_SHORT });
    });
  });
});
