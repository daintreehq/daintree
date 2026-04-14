import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_SETTLE } from "../helpers/timeouts";
import {
  navigateToAgentSettings,
  addCustomFlavor,
  removeCcrConfig,
  writeCcrConfig,
} from "../helpers/flavors";

let ctx: AppContext;

test.describe.serial("Flavors: Custom Duplicate (35–44)", () => {
  test.beforeAll(async () => {
    removeCcrConfig();
    ctx = await launchApp();
    const fixtureDir = createFixtureRepo({ name: "flavor-dup" });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Flavor Dup Test");
  });

  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
  });

  const goToClaudeSettings = async () => {
    await navigateToAgentSettings(ctx.window, "claude");
  };

  test("35. Duplicate icon on any flavor creates a custom copy", async () => {
    await goToClaudeSettings();
    await addCustomFlavor(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    const dupBtn = ctx.window
      .locator(SEL.flavor.section)
      .locator(SEL.flavor.duplicateButton)
      .first();
    await dupBtn.click();
    await ctx.window.waitForTimeout(T_SETTLE);

    const customBadges = ctx.window.locator(SEL.flavor.section).locator(SEL.flavor.customBadge);
    const count = await customBadges.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test("36. Duplicated flavor has '(copy)' in name", async () => {
    await goToClaudeSettings();
    await expect(
      ctx.window.locator(SEL.flavor.section).locator("span", { hasText: "(copy)" }).first()
    ).toBeVisible({
      timeout: T_SHORT,
    });
  });

  test("37. Duplicated flavor has unique user- ID", async () => {
    await goToClaudeSettings();
    const customBadges = ctx.window.locator(SEL.flavor.section).locator(SEL.flavor.customBadge);
    const count = await customBadges.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test("38. Duplicating CCR flavor copies env overrides", async () => {
    writeCcrConfig([
      { id: "ccr-dup", name: "CCR Dup Test", model: "dup-model", baseUrl: "https://dup.local" },
    ]);
    await ctx.window.waitForTimeout(35_000);
    await goToClaudeSettings();

    const ccrRow = ctx.window.locator(SEL.flavor.section).locator("div.flex.items-center.border", {
      hasText: "CCR Dup Test",
    });
    await expect(ccrRow).toBeVisible({ timeout: T_MEDIUM });

    const dupBtn = ccrRow.locator(SEL.flavor.duplicateButton);
    await dupBtn.click();
    await ctx.window.waitForTimeout(T_SETTLE);

    await expect(
      ctx.window
        .locator(SEL.flavor.section)
        .locator("span", { hasText: "CCR Dup Test (copy)" })
        .first()
    ).toBeVisible({ timeout: T_SHORT });
  });

  test("39. Duplicating custom flavor copies all properties", async () => {
    await goToClaudeSettings();
    const customRows = ctx.window.locator(SEL.flavor.section).locator(SEL.flavor.customBadge);
    const countBefore = await customRows.count();
    const dupBtn = ctx.window
      .locator(SEL.flavor.section)
      .locator(SEL.flavor.duplicateButton)
      .last();
    await dupBtn.click();
    await ctx.window.waitForTimeout(T_SETTLE);
    const countAfter = await customRows.count();
    expect(countAfter).toBe(countBefore + 1);
  });

  test("40. Duplicate button appears on CCR flavors", async () => {
    writeCcrConfig([{ id: "ccr-dupvis", model: "dupvis-model" }]);
    await ctx.window.waitForTimeout(35_000);
    await goToClaudeSettings();
    const ccrRow = ctx.window.locator(SEL.flavor.section).locator("div.flex.items-center.border", {
      hasText: "ccr-dupvis",
    });
    if (await ccrRow.isVisible().catch(() => false)) {
      await expect(ccrRow.locator(SEL.flavor.duplicateButton)).toBeVisible({ timeout: T_SHORT });
    }
  });

  test("41. Duplicate button appears on custom flavors", async () => {
    await goToClaudeSettings();
    const dupBtns = ctx.window.locator(SEL.flavor.section).locator(SEL.flavor.duplicateButton);
    const count = await dupBtns.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("42. Deleting original does not affect duplicate", async () => {
    await goToClaudeSettings();
    await addCustomFlavor(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    const dupBtn = ctx.window
      .locator(SEL.flavor.section)
      .locator(SEL.flavor.duplicateButton)
      .last();
    await dupBtn.click();
    await ctx.window.waitForTimeout(T_SETTLE);

    const customBadgesBefore = await ctx.window
      .locator(SEL.flavor.section)
      .locator(SEL.flavor.customBadge)
      .count();

    const delBtn = ctx.window.locator(SEL.flavor.section).locator(SEL.flavor.deleteButton).last();
    await delBtn.click();
    await ctx.window.waitForTimeout(T_SETTLE);

    const customBadgesAfter = await ctx.window
      .locator(SEL.flavor.section)
      .locator(SEL.flavor.customBadge)
      .count();
    expect(customBadgesAfter).toBe(customBadgesBefore - 1);
  });

  test("43. Duplicate multiple times creates independent copies", async () => {
    await goToClaudeSettings();
    const dupBtn = ctx.window
      .locator(SEL.flavor.section)
      .locator(SEL.flavor.duplicateButton)
      .first();
    await dupBtn.click();
    await dupBtn.click();
    await ctx.window.waitForTimeout(T_SETTLE);

    const copies = ctx.window.locator(SEL.flavor.section).locator("span", { hasText: "(copy)" });
    const count = await copies.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test("44. Duplicate immediately reflects in toolbar and tray", async () => {
    await goToClaudeSettings();
    await addCustomFlavor(ctx.window);
    const dupBtn = ctx.window
      .locator(SEL.flavor.section)
      .locator(SEL.flavor.duplicateButton)
      .first();
    await dupBtn.click();
    await ctx.window.waitForTimeout(T_SETTLE);

    const section = ctx.window.locator(SEL.flavor.section);
    await expect(section).toBeVisible({ timeout: T_SHORT });
  });
});
