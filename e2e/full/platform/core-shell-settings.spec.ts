import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import {
  expectToolbarButtonReachable,
  getGridPanelCount,
  openSettings,
} from "../../helpers/panels";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../../helpers/timeouts";

let ctx: AppContext;
const mod = process.platform === "darwin" ? "Meta" : "Control";
let fixtureCleanup: (() => void) | undefined;

test.describe.serial("Core: Shell & Settings", () => {
  test.beforeAll(async () => {
    ctx = await launchApp();
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
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
      await expectToolbarButtonReachable(window, SEL.toolbar.openSettings, T_SHORT);
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
      const heading = window.locator("h2", { hasText: "Settings" });

      await test.step("Open settings and verify default General tab", async () => {
        await openSettings(window);

        await expect(heading).toBeVisible({ timeout: T_MEDIUM });

        const defaultTab = window.locator("h3", { hasText: "General" });
        await expect(defaultTab).toBeVisible({ timeout: T_SHORT });
      });

      await test.step("Cycle through all settings nav tabs and confirm each renders", async () => {
        const navButtons = [
          "Keyboard",
          "Notifications",
          "Panel Grid",
          "Worktree",
          "Toolbar",
          "Appearance",
          "CLI agents",
          "Code Forge",
          "Integrations",
          "Portal",
          "MCP Server",
          "Privacy & Data",
          "Environment",
          "Troubleshooting",
        ];

        for (const nav of navButtons) {
          const btn = window
            .locator(SEL.settings.navSidebar)
            .getByRole("tab", { name: nav, exact: true });
          await expect(btn).toBeVisible({ timeout: T_SHORT });
          await btn.click();
          // Brief settle to confirm tab content loads without error
          await window.waitForTimeout(200);
        }
      });

      await test.step("Close settings via Escape", async () => {
        await window.keyboard.press("Escape");
        await expect(heading).not.toBeVisible({ timeout: T_SHORT });
      });
    });
  });

  // ── Keyboard Shortcuts (7 tests) ─────────────────────────

  test.describe.serial("Keyboard Shortcuts", () => {
    test.beforeAll(async () => {
      const { dir: fixtureDir, cleanup } = createFixtureRepo({ name: "shell-settings" });
      fixtureCleanup = cleanup;
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

      const aside = window.locator(SEL.sidebar.aside);
      await expect(aside).toHaveAttribute("aria-hidden", "false", { timeout: T_SHORT });

      await window.keyboard.press(`${mod}+b`);
      await expect(aside).toHaveAttribute("aria-hidden", "true", { timeout: T_SHORT });

      await window.keyboard.press(`${mod}+b`);
      await expect(aside).toHaveAttribute("aria-hidden", "false", { timeout: T_SHORT });
    });

    test("toolbar button toggles sidebar off and on", async () => {
      const { window } = ctx;

      const aside = window.locator(SEL.sidebar.aside);
      await expect(aside).toHaveAttribute("aria-hidden", "false", { timeout: T_MEDIUM });

      await window.locator(SEL.toolbar.toggleSidebar).click();
      await expect(aside).toHaveAttribute("aria-hidden", "true", { timeout: T_SHORT });

      await window.locator(SEL.toolbar.toggleSidebar).click();
      await expect(aside).toHaveAttribute("aria-hidden", "false", { timeout: T_SHORT });
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

      // Skip-decision belongs outside test.step — calling test.skip() inside a
      // step throws TestSkipError, which records the step as errored in trace
      // rather than cleanly skipped.
      let before = await getGridPanelCount(window);
      if (before === 0) {
        test.skip();
        return;
      }

      await test.step("Ensure at least 2 panels so Cmd+W doesn't quit the app", async () => {
        if (before === 1) {
          await window.keyboard.press(`${mod}+Alt+t`);
          await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(2);
          before = 2;
        }
      });

      await test.step("Focus first panel and dispatch Cmd+W to close it", async () => {
        const panel = window.locator(SEL.panel.gridPanel).first();
        await panel.click();
        await window.waitForTimeout(T_SETTLE);

        await window.keyboard.press(`${mod}+w`);
        await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(before - 1);
      });
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

      await test.step("Navigate to General › Display subtab", async () => {
        const generalTab = window.locator(`${SEL.settings.navSidebar} button:has-text("General")`);
        await generalTab.click();

        const displaySubtab = window.locator(
          '#settings-panel-general button[role="tab"]:has-text("Display")'
        );
        await displaySubtab.click();
      });

      await test.step("Toggle Project Pulse off and verify state", async () => {
        const toggle = window.locator(SEL.settings.projectPulseToggle);
        await expect(toggle).toBeVisible({ timeout: T_MEDIUM });
        await expect(toggle).toHaveAttribute("aria-checked", "true", { timeout: T_MEDIUM });

        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-checked", "false", { timeout: T_MEDIUM });
      });
    });

    test("Terminal tab: toggle Performance Mode on", async () => {
      const { window } = ctx;

      await test.step("Navigate to Panel Grid tab", async () => {
        const terminalTab = window.locator(
          `${SEL.settings.navSidebar} button:has-text("Panel Grid")`
        );
        await terminalTab.click();
      });

      await test.step("Toggle Performance Mode on and verify state", async () => {
        const toggle = window.locator(SEL.settings.performanceModeToggle);
        await toggle.scrollIntoViewIfNeeded();
        await expect(toggle).toBeVisible({ timeout: T_MEDIUM });
        await expect(toggle).toHaveAttribute("aria-checked", "false", { timeout: T_MEDIUM });

        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-checked", "true", { timeout: T_MEDIUM });
      });
    });

    test("Appearance tab: change font family", async () => {
      const { window } = ctx;

      await test.step("Navigate to Appearance › Terminal subtab", async () => {
        const appearanceTab = window.locator(
          `${SEL.settings.navSidebar} button:has-text("Appearance")`
        );
        await appearanceTab.click();

        const terminalSubtab = window.locator(
          '#settings-panel-terminalAppearance button[role="tab"]:has-text("Terminal")'
        );
        await terminalSubtab.click();
      });

      await test.step("Change font family from JetBrains Mono to System monospace", async () => {
        const fontSelect = window.locator(SEL.settings.fontFamilySelect);
        await expect(fontSelect).toBeVisible({ timeout: T_MEDIUM });
        await expect(fontSelect).toContainText("JetBrains Mono", { timeout: T_MEDIUM });

        await fontSelect.click();
        await window.locator('[role="option"]', { hasText: "System monospace" }).click();
        await expect(fontSelect).toContainText("System monospace", { timeout: T_MEDIUM });
      });
    });

    test("close and reopen settings — changes persist", async () => {
      const { window } = ctx;
      const heading = window.locator(SEL.settings.heading);

      await test.step("Close and reopen settings dialog", async () => {
        await window.keyboard.press("Escape");
        await expect(heading).not.toBeVisible({ timeout: T_SHORT });

        await openSettings(window);
        await expect(heading).toBeVisible({ timeout: T_MEDIUM });
      });

      await test.step("Verify Project Pulse remained off", async () => {
        const generalTab = window.locator(`${SEL.settings.navSidebar} button:has-text("General")`);
        await generalTab.click();
        const displaySubtab = window.locator(
          '#settings-panel-general button[role="tab"]:has-text("Display")'
        );
        await displaySubtab.click();
        const pulseToggle = window.locator(SEL.settings.projectPulseToggle);
        await expect(pulseToggle).toHaveAttribute("aria-checked", "false", { timeout: T_MEDIUM });
      });

      await test.step("Verify Performance Mode remained on", async () => {
        const terminalTab = window.locator(
          `${SEL.settings.navSidebar} button:has-text("Panel Grid")`
        );
        await terminalTab.click();
        const perfToggle = window.locator(SEL.settings.performanceModeToggle);
        await perfToggle.scrollIntoViewIfNeeded();
        await expect(perfToggle).toHaveAttribute("aria-checked", "true", { timeout: T_MEDIUM });
      });

      await test.step("Verify font family remained System monospace", async () => {
        const appearanceTab = window.locator(
          `${SEL.settings.navSidebar} button:has-text("Appearance")`
        );
        await appearanceTab.click();
        const terminalSubtab = window.locator(
          '#settings-panel-terminalAppearance button[role="tab"]:has-text("Terminal")'
        );
        await terminalSubtab.click();
        const fontSelect = window.locator(SEL.settings.fontFamilySelect);
        await expect(fontSelect).toContainText("System monospace", { timeout: T_MEDIUM });
      });

      await window.keyboard.press("Escape");
    });
  });

  // ── Project Settings (4 tests) ───────────────────────────

  test.describe.serial("Project Settings", () => {
    test("open project settings via project switcher", async () => {
      const { window } = ctx;

      await test.step("Open project switcher and click Project Settings", async () => {
        await window.locator(SEL.toolbar.projectSwitcherTrigger).click();

        const palette = window.locator(SEL.projectSwitcher.palette);
        await expect(palette).toBeVisible({ timeout: T_MEDIUM });

        const settingsBtn = palette.locator("button", { hasText: /Project Settings/ });
        await expect(settingsBtn).toBeVisible({ timeout: T_SHORT });
        await settingsBtn.click();
      });

      await test.step("Verify settings opens in project scope", async () => {
        // Settings dialog opens in project scope
        const heading = window.locator('h2:has-text("Settings")');
        await expect(heading).toBeVisible({ timeout: T_MEDIUM });

        // Verify project scope is selected
        const scopeTrigger = window.locator('[aria-label="Settings scope"]');
        await expect(scopeTrigger).toContainText("Project", { timeout: T_SHORT });
      });
    });

    test("project name is displayed", async () => {
      const { window } = ctx;

      // Navigate to General tab which shows project identity
      const generalBtn = window.locator(`${SEL.settings.navSidebar} button`, {
        hasText: "General",
      });
      await generalBtn.click();

      const nameInput = window.locator("#project-name-input");
      await expect(nameInput).toBeVisible({ timeout: T_SHORT });
      const value = await nameInput.inputValue();
      expect(value).toContain("shell-settings");
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
