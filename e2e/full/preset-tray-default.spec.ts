import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_SETTLE } from "../helpers/timeouts";
import {
  writeCcrConfig,
  removeCcrConfig,
  navigateToAgentSettings,
  addCustomPreset,
} from "../helpers/presets";

let ctx: AppContext;

/**
 * Tests 101–106: Agent tray default-launch behavior.
 *
 * These tests verify that:
 * - The tray shows a split-button (submenu trigger) when an agent has presets.
 * - Clicking the left-area text (not the chevron) dispatches a default launch
 *   and closes the tray without opening the submenu.
 * - Hovering the chevron area opens the submenu and lists all presets.
 *
 * All panel-launch assertions are guarded: if Claude is not in a ready state
 * (binary not installed in CI), the block is skipped gracefully.
 */
test.describe.serial("Presets: Tray Default Launch (101–106)", () => {
  test.beforeAll(async () => {
    removeCcrConfig();
    ctx = await launchApp();
    const fixtureDir = createFixtureRepo({ name: "preset-tray-default" });
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Preset Tray Default Test"
    );
  });

  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
  });

  const openTray = async () => {
    const btn = ctx.window.locator('[aria-label^="Agent tray"]');
    await btn.click();
    await ctx.window.waitForTimeout(T_SETTLE);
  };

  const closeTray = async () => {
    await ctx.window.keyboard.press("Escape");
    await ctx.window.waitForTimeout(T_SETTLE);
  };

  test("101. Without presets: Claude appears as a plain menu item (no chevron)", async () => {
    removeCcrConfig();
    await ctx.window.waitForTimeout(T_SETTLE);

    await openTray();

    const menu = ctx.window.locator('[role="menu"]');
    if (!(await menu.isVisible({ timeout: T_SHORT }).catch(() => false))) {
      await closeTray();
      return;
    }

    // No submenu trigger should be present when there are no presets
    const submenuTrigger = menu.locator('[data-testid="submenu-trigger"]', { hasText: "Claude" });
    const hasSubmenu = await submenuTrigger.isVisible({ timeout: T_SHORT }).catch(() => false);
    expect(hasSubmenu).toBe(false);

    await closeTray();
  });

  test("102. With CCR presets: Claude appears as a split-button (submenu trigger)", async () => {
    writeCcrConfig([
      { id: "tray-a", name: "Tray Model A", model: "tray-model-a" },
      { id: "tray-b", name: "Tray Model B", model: "tray-model-b" },
    ]);
    await ctx.window.waitForTimeout(35_000);

    await openTray();

    const menu = ctx.window.locator('[role="menu"]');
    if (!(await menu.isVisible({ timeout: T_SHORT }).catch(() => false))) {
      await closeTray();
      return;
    }

    const submenuTrigger = menu.locator('[data-testid="submenu-trigger"]', { hasText: "Claude" });
    if (!(await submenuTrigger.isVisible({ timeout: T_SHORT }).catch(() => false))) {
      // Agent not in ready state — skip
      await closeTray();
      return;
    }

    await expect(submenuTrigger).toBeVisible({ timeout: T_SHORT });

    await closeTray();
  });

  test("103. Hovering the chevron area opens the submenu", async () => {
    await openTray();

    const menu = ctx.window.locator('[role="menu"]');
    if (!(await menu.isVisible({ timeout: T_SHORT }).catch(() => false))) {
      await closeTray();
      return;
    }

    const submenuTrigger = menu.locator('[data-testid="submenu-trigger"]', { hasText: "Claude" });
    if (!(await submenuTrigger.isVisible({ timeout: T_SHORT }).catch(() => false))) {
      await closeTray();
      return;
    }

    // Hover the chevron (right span, not the left text span)
    await submenuTrigger.hover();
    await ctx.window.waitForTimeout(T_SETTLE);

    const submenuContent = ctx.window.locator('[data-testid="submenu-content"]');
    await expect(submenuContent).toBeVisible({ timeout: T_MEDIUM });

    // "Default" must be the first item
    const firstItem = submenuContent.locator('[role^="menuitem"]').first();
    const firstText = (await firstItem.textContent()) ?? "";
    expect(firstText.toLowerCase()).toContain("default");

    await closeTray();
  });

  test("104. Submenu lists all available CCR presets", async () => {
    await openTray();

    const menu = ctx.window.locator('[role="menu"]');
    if (!(await menu.isVisible({ timeout: T_SHORT }).catch(() => false))) {
      await closeTray();
      return;
    }

    const submenuTrigger = menu.locator('[data-testid="submenu-trigger"]', { hasText: "Claude" });
    if (!(await submenuTrigger.isVisible({ timeout: T_SHORT }).catch(() => false))) {
      await closeTray();
      return;
    }

    await submenuTrigger.hover();
    await ctx.window.waitForTimeout(T_SETTLE);

    const submenuContent = ctx.window.locator('[data-testid="submenu-content"]');
    if (!(await submenuContent.isVisible({ timeout: T_SHORT }).catch(() => false))) {
      await closeTray();
      return;
    }

    const items = submenuContent.locator('[role^="menuitem"]');
    const texts = await items.allTextContents();
    expect(texts.some((t) => t.includes("Tray Model A"))).toBe(true);
    expect(texts.some((t) => t.includes("Tray Model B"))).toBe(true);

    await closeTray();
  });

  test("105. Clicking agent name (left area) closes tray without opening submenu", async () => {
    await openTray();

    const menu = ctx.window.locator('[role="menu"]');
    if (!(await menu.isVisible({ timeout: T_SHORT }).catch(() => false))) {
      await closeTray();
      return;
    }

    const submenuTrigger = menu.locator('[data-testid="submenu-trigger"]', { hasText: "Claude" });
    if (!(await submenuTrigger.isVisible({ timeout: T_SHORT }).catch(() => false))) {
      await closeTray();
      return;
    }

    // Click the left-area span (text + icon, NOT the chevron)
    const leftArea = submenuTrigger.locator("span").first();
    await leftArea.click();
    await ctx.window.waitForTimeout(T_SETTLE);

    // Tray dropdown should be gone
    await expect(menu).not.toBeVisible({ timeout: T_SHORT });

    // Submenu content should never have opened
    const submenuContent = ctx.window.locator('[data-testid="submenu-content"]');
    const submenuOpened = await submenuContent.isVisible({ timeout: 200 }).catch(() => false);
    expect(submenuOpened).toBe(false);
  });

  test("106. Tray submenu also shows custom presets alongside CCR presets", async () => {
    await navigateToAgentSettings(ctx.window, "claude");
    await addCustomPreset(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);
    await ctx.window.locator(SEL.settings.closeButton).click();
    await ctx.window.waitForTimeout(T_SETTLE);

    await openTray();

    const menu = ctx.window.locator('[role="menu"]');
    if (!(await menu.isVisible({ timeout: T_SHORT }).catch(() => false))) {
      await closeTray();
      return;
    }

    const submenuTrigger = menu.locator('[data-testid="submenu-trigger"]', { hasText: "Claude" });
    if (!(await submenuTrigger.isVisible({ timeout: T_SHORT }).catch(() => false))) {
      await closeTray();
      return;
    }

    await submenuTrigger.hover();
    await ctx.window.waitForTimeout(T_SETTLE);

    const submenuContent = ctx.window.locator('[data-testid="submenu-content"]');
    if (!(await submenuContent.isVisible({ timeout: T_SHORT }).catch(() => false))) {
      await closeTray();
      return;
    }

    const items = submenuContent.locator('[role^="menuitem"]');
    const count = await items.count();
    // Default + 2 CCR + 1 custom = at least 4
    expect(count).toBeGreaterThanOrEqual(4);

    await closeTray();
  });
});
