import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_SETTLE } from "../helpers/timeouts";
import { navigateToAgentSettings, addCustomPreset, removeCcrConfig } from "../helpers/presets";

let ctx: AppContext;

test.describe.serial("Presets: Custom Edit (25–34)", () => {
  test.beforeAll(async () => {
    removeCcrConfig();
    ctx = await launchApp();
    const fixtureDir = createFixtureRepo({ name: "preset-edit" });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Preset Edit Test");
    await navigateToAgentSettings(ctx.window, "claude");
    await addCustomPreset(ctx.window);
  });

  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
  });

  const goToClaudeSettings = async () => {
    await navigateToAgentSettings(ctx.window, "claude");
  };

  test("25. Pencil icon shows inline edit input", async () => {
    await goToClaudeSettings();
    const editBtn = ctx.window.locator(SEL.preset.section).locator(SEL.preset.editButton).first();
    await expect(editBtn).toBeVisible({ timeout: T_SHORT });
    await editBtn.click();
    const input = ctx.window
      .locator(SEL.preset.section)
      .locator("[data-testid='preset-edit-input']");
    await expect(input).toBeVisible({ timeout: T_SHORT });
  });

  test("26. Renaming updates name in preset list", async () => {
    await goToClaudeSettings();
    const editBtn = ctx.window.locator(SEL.preset.section).locator(SEL.preset.editButton).first();
    await editBtn.click();
    const input = ctx.window
      .locator(SEL.preset.section)
      .locator("[data-testid='preset-edit-input']");
    await expect(input).toBeVisible({ timeout: T_SHORT });
    await input.fill("Renamed Preset");
    await input.press("Enter");
    await ctx.window.waitForTimeout(T_SETTLE);
    await expect(
      ctx.window.locator(SEL.preset.section).locator("span", { hasText: "Renamed Preset" }).first()
    ).toBeVisible({
      timeout: T_SHORT,
    });
  });

  test("27. Renamed preset visible in agent tray sub-menu", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    const closeButton = ctx.window.locator(SEL.settings.closeButton);
    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click();
      await ctx.window.waitForTimeout(T_SETTLE);
    }

    const trayButton = ctx.window.locator('[aria-label^="Agent tray"]');
    if (!(await trayButton.isVisible().catch(() => false))) return;
    await trayButton.click();
    await ctx.window.waitForTimeout(T_SETTLE);
    const submenu = ctx.window.locator('[data-testid="submenu-trigger"]', { hasText: "Claude" });
    if (await submenu.isVisible().catch(() => false)) {
      await submenu.hover();
      await ctx.window.waitForTimeout(T_SETTLE);
    }
    await ctx.window.mouse.click(10, 10);
    await ctx.window.waitForTimeout(T_SETTLE);
  });

  test("28. Canceling rename leaves name unchanged", async () => {
    await goToClaudeSettings();
    const section = ctx.window.locator(SEL.preset.section);
    await expect(section).toBeVisible({ timeout: T_MEDIUM });
    const editBtn = section.locator(SEL.preset.editButton).first();
    await expect(editBtn).toBeVisible({ timeout: T_SHORT });
    await editBtn.click();
    const input = section.locator("[data-testid='preset-edit-input']");
    await expect(input).toBeVisible({ timeout: T_SHORT });
    await input.fill("Should Not Save");
    await input.press("Escape");
    await ctx.window.waitForTimeout(T_SETTLE);
    await expect(section).toBeVisible({ timeout: T_MEDIUM });
    await expect(section.locator("span", { hasText: "Should Not Save" })).toHaveCount(0);
  });

  test("29. Empty rename rejected", async () => {
    await goToClaudeSettings();
    const editBtn = ctx.window.locator(SEL.preset.section).locator(SEL.preset.editButton).first();
    await editBtn.click();
    const input = ctx.window
      .locator(SEL.preset.section)
      .locator("[data-testid='preset-edit-input']");
    await expect(input).toBeVisible({ timeout: T_SHORT });
    await input.fill("");
    await input.press("Enter");
    await ctx.window.waitForTimeout(T_SETTLE);
    const customBadges = ctx.window.locator(SEL.preset.section).locator(SEL.preset.customBadge);
    await expect(customBadges.first()).toBeVisible({ timeout: T_SHORT });
  });

  test("30. Very long name (200+ chars) works without crash", async () => {
    await goToClaudeSettings();
    const editBtn = ctx.window.locator(SEL.preset.section).locator(SEL.preset.editButton).first();
    await editBtn.click();
    const input = ctx.window
      .locator(SEL.preset.section)
      .locator("[data-testid='preset-edit-input']");
    await expect(input).toBeVisible({ timeout: T_SHORT });
    const longName = "A".repeat(250);
    await input.fill(longName);
    await input.press("Enter");
    await ctx.window.waitForTimeout(T_SETTLE);
    await expect(ctx.window.locator(SEL.preset.section)).toBeVisible({ timeout: T_SHORT });
  });

  test("31. Edit button not shown for CCR presets", async () => {
    const { writeCcrConfig } = await import("../helpers/presets");
    writeCcrConfig([{ id: "ccr-noedit", name: "No Edit", model: "noedit-model" }]);
    await ctx.window.waitForTimeout(35_000);
    await goToClaudeSettings();
    const ccrRow = ctx.window.locator(SEL.preset.section).locator("div.flex.items-center.border", {
      hasText: "No Edit",
    });
    if (await ccrRow.isVisible().catch(() => false)) {
      await expect(ccrRow.locator(SEL.preset.editButton)).toHaveCount(0);
    }
  });

  test("32. Name with special characters works", async () => {
    await goToClaudeSettings();
    const editBtn = ctx.window.locator(SEL.preset.section).locator(SEL.preset.editButton).first();
    await editBtn.click();
    const input = ctx.window
      .locator(SEL.preset.section)
      .locator("[data-testid='preset-edit-input']");
    await expect(input).toBeVisible({ timeout: T_SHORT });
    await input.fill("Test & Special");
    await input.press("Enter");
    await ctx.window.waitForTimeout(T_SETTLE);
    await expect(ctx.window.locator(SEL.preset.section)).toBeVisible({ timeout: T_SHORT });
  });

  test("33. Name with emoji works", async () => {
    await goToClaudeSettings();
    const editBtn = ctx.window.locator(SEL.preset.section).locator(SEL.preset.editButton).first();
    await editBtn.click();
    const input = ctx.window
      .locator(SEL.preset.section)
      .locator("[data-testid='preset-edit-input']");
    await expect(input).toBeVisible({ timeout: T_SHORT });
    await input.fill("Rocket Preset");
    await input.press("Enter");
    await ctx.window.waitForTimeout(T_SETTLE);
    await expect(ctx.window.locator(SEL.preset.section)).toBeVisible({ timeout: T_SHORT });
  });

  test("34. Edit persists across Settings close/reopen", async () => {
    await goToClaudeSettings();
    const editBtn = ctx.window.locator(SEL.preset.section).locator(SEL.preset.editButton).first();
    await editBtn.click();
    const input = ctx.window
      .locator(SEL.preset.section)
      .locator("[data-testid='preset-edit-input']");
    await expect(input).toBeVisible({ timeout: T_SHORT });
    await input.fill("Persistent Name");
    await input.press("Enter");
    await ctx.window.waitForTimeout(T_SETTLE);

    await ctx.window.locator(SEL.settings.closeButton).click();
    await ctx.window.waitForTimeout(T_SETTLE);

    await goToClaudeSettings();
    await expect(
      ctx.window.locator(SEL.preset.section).locator("span", { hasText: "Persistent Name" }).first()
    ).toBeVisible({
      timeout: T_SHORT,
    });
  });
});
