import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";
import {
  navigateToAgentSettings,
  addCustomPreset,
  countPresetOptions,
  getPresetOptionLabels,
  removeCcrConfig,
  writeCcrConfig,
  waitForCcrPresets,
} from "../../helpers/presets";

let ctx: AppContext;
let fixtureCleanup: (() => void) | undefined;

test.describe.serial("Adversarial E2E Tests: System Breakage", () => {
  test.beforeAll(async () => {
    removeCcrConfig();
    ctx = await launchApp();
    const { dir: fixtureDir, cleanup } = createFixtureRepo({ name: "adversarial-e2e" });
    fixtureCleanup = cleanup;
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Adversarial E2E Test"
    );
  });

  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  const goToClaudeSettings = async () => {
    await navigateToAgentSettings(ctx.window, "claude");
  };

  // The section only holds the selected preset's editor, so its Edit button
  // is the one to open.
  const openFirstPresetEditor = async () => {
    const section = ctx.window.locator(SEL.preset.section);
    await expect(section).toBeVisible({ timeout: T_SHORT });
    const input = section.locator("[data-testid='preset-edit-input']");
    await expect(async () => {
      if ((await input.count()) > 0) return;
      const editBtn = section.locator(SEL.preset.editButton).first();
      await editBtn.scrollIntoViewIfNeeded();
      await editBtn.click({ force: true, noWaitAfter: true, timeout: T_SHORT });
      await expect(input).toBeVisible({ timeout: T_SHORT });
    }).toPass({ timeout: T_LONG });
    return input;
  };

  test("Resource exhaustion via massive preset creation", async () => {
    await goToClaudeSettings();
    const optionsBefore = await countPresetOptions(ctx.window);

    const presetCount = process.env.CI ? 10 : 100;
    for (let i = 0; i < presetCount; i++) {
      await addCustomPreset(ctx.window);
    }

    // Every rapid add must land exactly once in the rendered preset list — a
    // dropped or doubled write under load shows up as a wrong option count.
    await expect(ctx.window.locator(SEL.preset.section)).toBeVisible({ timeout: T_LONG });
    await expect
      .poll(() => countPresetOptions(ctx.window), { timeout: T_LONG })
      .toBe(optionsBefore + presetCount);
  });

  test("Race condition: CCR config changes during UI interaction", async () => {
    await goToClaudeSettings();
    const optionsBefore = await countPresetOptions(ctx.window);

    const renamed = "Race Condition Test";
    const input = await openFirstPresetEditor();
    await input.fill(renamed);

    // The CCR config file changes on disk while the rename is still in the input.
    writeCcrConfig([{ id: "race", name: "Race Preset", model: "race-model" }]);

    await input.press("Enter");
    await waitForCcrPresets(ctx.window, ["Race Preset"]);

    // Both writes must survive in what the user sees: the committed rename and
    // the newly discovered CCR preset, with no custom preset lost or doubled.
    await navigateToAgentSettings(ctx.window, "claude");
    await expect
      .poll(() => getPresetOptionLabels(ctx.window), { timeout: T_MEDIUM })
      .toEqual(
        expect.arrayContaining([
          expect.stringContaining(renamed),
          expect.stringContaining("Race Preset"),
        ])
      );
    expect(await countPresetOptions(ctx.window)).toBe(optionsBefore + 1);
  });
});
