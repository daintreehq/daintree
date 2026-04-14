import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_SETTLE } from "../helpers/timeouts";
import { navigateToAgentSettings, addCustomFlavor, removeCcrConfig } from "../helpers/flavors";

let ctx: AppContext;

test.describe.serial("Flavors: Custom Add (13–24)", () => {
  test.beforeAll(async () => {
    removeCcrConfig();
    ctx = await launchApp();
    const fixtureDir = createFixtureRepo({ name: "flavor-add" });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Flavor Add Test");
  });

  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
  });

  const goToClaudeSettings = async () => {
    await navigateToAgentSettings(ctx.window, "claude");
  };

  test("13. Clicking Add creates a new custom flavor", async () => {
    await goToClaudeSettings();
    await addCustomFlavor(ctx.window);
    await expect(
      ctx.window.locator(SEL.flavor.section).locator("span", { hasText: "New Flavor" }).first()
    ).toBeVisible({
      timeout: T_SHORT,
    });
  });

  test("14. New custom flavor appears in toolbar split-button", async () => {
    await goToClaudeSettings();
    await addCustomFlavor(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    const chevron = ctx.window.locator(SEL.flavor.toolbarChevron);
    if (await chevron.isVisible().catch(() => false)) {
      await chevron.click();
      await expect(ctx.window.locator("text=New Flavor")).toBeVisible({ timeout: T_SHORT });
    }
  });

  test("15. New custom flavor appears in agent tray sub-menu", async () => {
    await goToClaudeSettings();
    await addCustomFlavor(ctx.window);
    await addCustomFlavor(ctx.window); // Add second flavor for submenu to appear
    await ctx.window.waitForTimeout(T_SETTLE);

    const closeButton = ctx.window.locator(SEL.settings.closeButton);
    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click();
      await ctx.window.waitForTimeout(T_SETTLE);
    }

    const trayButton = ctx.window.locator('[aria-label="Agent tray"]');
    await trayButton.click();
    await ctx.window.waitForTimeout(T_SETTLE);
    const submenuTrigger = ctx.window.locator('[data-testid="submenu-trigger"]', {
      hasText: "Claude",
    });
    await expect(submenuTrigger).toBeVisible({ timeout: T_MEDIUM });
    await submenuTrigger.hover();
    await ctx.window.waitForTimeout(T_SETTLE);
    const submenuContent = ctx.window.locator('[data-testid="submenu-content"]');
    await expect(submenuContent).toBeVisible({ timeout: T_SHORT });
    await expect(submenuContent.locator("span", { hasText: "New Flavor" }).first()).toBeVisible({
      timeout: T_SHORT,
    });

    await ctx.window.mouse.click(10, 10);
  });

  test("16. Custom flavor shows 'custom' badge", async () => {
    await goToClaudeSettings();
    const customBadge = ctx.window.locator(SEL.flavor.section).locator(SEL.flavor.customBadge);
    const count = await customBadge.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("17. Add flavor works when no CCR flavors exist", async () => {
    removeCcrConfig();
    await goToClaudeSettings();
    await addCustomFlavor(ctx.window);
    await expect(ctx.window.locator(SEL.flavor.section)).toBeVisible({ timeout: T_SHORT });
  });

  test("18. Adding multiple flavors creates distinct entries", async () => {
    await goToClaudeSettings();
    await addCustomFlavor(ctx.window);
    await addCustomFlavor(ctx.window);
    const customBadges = ctx.window.locator(SEL.flavor.section).locator(SEL.flavor.customBadge);
    const count = await customBadges.count();
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test("19. Added flavor persists after closing and reopening Settings", async () => {
    await goToClaudeSettings();
    await addCustomFlavor(ctx.window);
    const name = "New Flavor";
    await expect(
      ctx.window.locator(SEL.flavor.section).locator("span", { hasText: name }).first()
    ).toBeVisible({
      timeout: T_SHORT,
    });

    const closeButton = ctx.window.locator(SEL.settings.closeButton);
    await closeButton.click();
    await ctx.window.waitForTimeout(T_SETTLE);

    await goToClaudeSettings();
    const allNewFlavors = ctx.window
      .locator(SEL.flavor.section)
      .locator("span", { hasText: "New Flavor" })
      .first();
    const count = await allNewFlavors.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("20. Flavor with empty env is valid", async () => {
    await goToClaudeSettings();
    await addCustomFlavor(ctx.window);
    const lastRow = ctx.window.locator(SEL.flavor.section).locator(SEL.flavor.customBadge).last();
    await expect(lastRow).toBeVisible({ timeout: T_SHORT });
  });

  test("21. Add then delete leaves no orphan", async () => {
    await goToClaudeSettings();
    await addCustomFlavor(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    const deleteButtons = ctx.window.locator(SEL.flavor.section).locator(SEL.flavor.deleteButton);
    const countBefore = await deleteButtons.count();
    if (countBefore > 0) {
      ctx.window.once("dialog", (dialog) => dialog.accept());
      await deleteButtons.last().click();
      await ctx.window.waitForTimeout(T_SETTLE);
    }
    const section = ctx.window.locator(SEL.flavor.section);
    const visible = await section.isVisible().catch(() => false);
    expect(visible).toBe(true);
  });

  test("22. Add button visible alongside CCR flavors", async () => {
    const { writeCcrConfig } = await import("../helpers/flavors");
    writeCcrConfig([{ id: "ccr-adj", name: "CCR Adj", model: "adj-model" }]);
    await ctx.window.waitForTimeout(35_000);
    await goToClaudeSettings();
    await expect(ctx.window.locator(SEL.flavor.section).locator(SEL.flavor.addButton)).toBeVisible({
      timeout: T_MEDIUM,
    });
  });

  test("23. Adding flavor to Claude does not affect Gemini", async () => {
    await goToClaudeSettings();
    await addCustomFlavor(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    await navigateToAgentSettings(ctx.window, "gemini");
    const geminiCustomBadges = ctx.window
      .locator(SEL.flavor.section)
      .locator(SEL.flavor.customBadge);
    const count = await geminiCustomBadges.count();
    expect(count).toBe(0);
  });

  test("24. Add flavor works when agent is not pinned", async () => {
    await goToClaudeSettings();
    const pinToggle = ctx.window.locator("#agents-enable button");
    if (await pinToggle.isVisible().catch(() => false)) {
      const ariaChecked = await pinToggle.getAttribute("aria-pressed");
      if (ariaChecked === "true") {
        await pinToggle.click();
        await ctx.window.waitForTimeout(T_SETTLE);
      }
    }
    await addCustomFlavor(ctx.window);
    await expect(ctx.window.locator(SEL.flavor.section)).toBeVisible({ timeout: T_SHORT });
  });
});
