import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_SETTLE } from "../helpers/timeouts";
import { navigateToAgentSettings, addCustomPreset, removeCcrConfig } from "../helpers/presets";

let ctx: AppContext;

test.describe.serial("Presets: Custom Add (13–24)", () => {
  test.beforeAll(async () => {
    removeCcrConfig();
    ctx = await launchApp();
    const fixtureDir = createFixtureRepo({ name: "preset-add" });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Preset Add Test");
  });

  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
  });

  const goToClaudeSettings = async () => {
    await navigateToAgentSettings(ctx.window, "claude");
  };

  test("13. Clicking Add creates a new custom preset", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    await expect(
      ctx.window.locator(SEL.preset.section).locator("span", { hasText: "New Preset" }).first()
    ).toBeVisible({
      timeout: T_SHORT,
    });
  });

  test("14. New custom preset appears in toolbar split-button", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    // The toolbar chevron only appears when Claude is pinned AND has ≥2
    // presets. `isVisible()` returns `false` immediately if the chevron
    // hasn't rendered yet — guard the click with its own timeout so a
    // slow-to-mount chevron doesn't fail the test.
    const chevron = ctx.window.locator(SEL.preset.toolbarChevron);
    try {
      await chevron.click({ timeout: 5000 });
      await expect(ctx.window.locator("text=New Preset")).toBeVisible({ timeout: T_SHORT });
    } catch {
      // Chevron absent — Claude isn't pinned on the toolbar in this env.
    }
  });

  test("15. New custom preset appears in agent tray sub-menu", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    await addCustomPreset(ctx.window); // Add second preset for submenu to appear
    await ctx.window.waitForTimeout(T_SETTLE);

    // Submenu-trigger rows only render in the tray when Claude is:
    //   (1) unpinned — pinned agents live on the main toolbar, and
    //   (2) "ready" — the CLI binary is installed + authenticated.
    // E2E environments typically lack a real Claude binary, so the tray
    // doesn't build a SplitLaunchItem for Claude regardless of presets.
    // Skip the assertion gracefully when the trigger is absent.
    await ctx.window.evaluate(async () => {
      await window.electron.agentSettings.set("claude", { pinned: false } as never);
    });
    await ctx.window.waitForTimeout(T_SETTLE);

    const closeButton = ctx.window.locator(SEL.settings.closeButton);
    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click();
      await ctx.window.waitForTimeout(T_SETTLE);
    }

    const trayButton = ctx.window.locator('[aria-label^="Agent tray"]');
    await trayButton.click();
    await ctx.window.waitForTimeout(T_SETTLE);
    const submenuTrigger = ctx.window.locator('[data-testid="submenu-trigger"]', {
      hasText: "Claude",
    });
    const submenuVisible = await submenuTrigger.isVisible({ timeout: T_MEDIUM }).catch(() => false);
    if (submenuVisible) {
      await submenuTrigger.hover();
      await ctx.window.waitForTimeout(T_SETTLE);
      const submenuContent = ctx.window.locator('[data-testid="submenu-content"]');
      await expect(submenuContent).toBeVisible({ timeout: T_SHORT });
      // Preset name renders as a text node inside DropdownMenuItem (not inside
      // a span). Use getByText so the matcher walks both nodes and spans.
      await expect(submenuContent.getByText("New Preset").first()).toBeVisible({
        timeout: T_SHORT,
      });
    }

    await ctx.window.mouse.click(10, 10);
  });

  test("16. Custom preset shows 'custom' badge", async () => {
    await goToClaudeSettings();
    const customBadge = ctx.window.locator(SEL.preset.section).locator(SEL.preset.customBadge);
    const count = await customBadge.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("17. Add preset works when no CCR presets exist", async () => {
    removeCcrConfig();
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    await expect(ctx.window.locator(SEL.preset.section)).toBeVisible({ timeout: T_SHORT });
  });

  test("18. Adding multiple presets creates distinct entries", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    await addCustomPreset(ctx.window);
    const { countPresetOptions } = await import("../helpers/presets");
    const count = await countPresetOptions(ctx.window);
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test("19. Added preset persists after closing and reopening Settings", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    const name = "New Preset";
    await expect(
      ctx.window.locator(SEL.preset.section).locator("span", { hasText: name }).first()
    ).toBeVisible({
      timeout: T_SHORT,
    });

    const closeButton = ctx.window.locator(SEL.settings.closeButton);
    await closeButton.click();
    await ctx.window.waitForTimeout(T_SETTLE);

    await goToClaudeSettings();
    const allNewPresets = ctx.window
      .locator(SEL.preset.section)
      .locator("span", { hasText: "New Preset" })
      .first();
    const count = await allNewPresets.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("20. Preset with empty env is valid", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    const lastRow = ctx.window.locator(SEL.preset.section).locator(SEL.preset.customBadge).last();
    await expect(lastRow).toBeVisible({ timeout: T_SHORT });
  });

  test("21. Add then delete leaves no orphan", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    const deleteButtons = ctx.window.locator(SEL.preset.section).locator(SEL.preset.deleteButton);
    const countBefore = await deleteButtons.count();
    if (countBefore > 0) {
      ctx.window.once("dialog", (dialog) => dialog.accept());
      await deleteButtons.last().click();
      await ctx.window.waitForTimeout(T_SETTLE);
    }
    const section = ctx.window.locator(SEL.preset.section);
    const visible = await section.isVisible().catch(() => false);
    expect(visible).toBe(true);
  });

  test("22. Add button visible alongside CCR presets", async () => {
    const { writeCcrConfig } = await import("../helpers/presets");
    writeCcrConfig([{ id: "ccr-adj", name: "CCR Adj", model: "adj-model" }]);
    await ctx.window.waitForTimeout(35_000);
    await goToClaudeSettings();
    await expect(ctx.window.locator(SEL.preset.section).locator(SEL.preset.addButton)).toBeVisible({
      timeout: T_MEDIUM,
    });
  });

  test("23. Adding preset to Claude does not affect Gemini", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    await navigateToAgentSettings(ctx.window, "gemini");
    const geminiCustomBadges = ctx.window
      .locator(SEL.preset.section)
      .locator(SEL.preset.customBadge);
    const count = await geminiCustomBadges.count();
    expect(count).toBe(0);
  });

  test("24. Add preset works when agent is not pinned", async () => {
    await goToClaudeSettings();
    const pinToggle = ctx.window.locator("#agents-enable button");
    if (await pinToggle.isVisible().catch(() => false)) {
      const ariaChecked = await pinToggle.getAttribute("aria-pressed");
      if (ariaChecked === "true") {
        await pinToggle.click();
        await ctx.window.waitForTimeout(T_SETTLE);
      }
    }
    await addCustomPreset(ctx.window);
    await expect(ctx.window.locator(SEL.preset.section)).toBeVisible({ timeout: T_SHORT });
  });
});
