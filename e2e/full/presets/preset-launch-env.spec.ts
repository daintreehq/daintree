import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM } from "../../helpers/timeouts";
import {
  writeCcrConfig,
  removeCcrConfig,
  waitForCcrPresets,
  getPresetRowByName,
  getSelectedPresetLabel,
} from "../../helpers/presets";

let ctx: AppContext;
let fixtureCleanup: (() => void) | undefined;

test.describe.serial("Presets: Launch Env Overrides (63–70)", () => {
  test.beforeAll(async () => {
    removeCcrConfig();
    ctx = await launchApp();
    const { dir: fixtureDir, cleanup } = createFixtureRepo({ name: "preset-launch-env" });
    fixtureCleanup = cleanup;
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Preset Launch Env Test"
    );
  });

  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("63. CCR preset with model shows ANTHROPIC_MODEL env key in preset row", async () => {
    writeCcrConfig([{ id: "env-model", name: "Env Model", model: "claude-sonnet-4" }]);
    await waitForCcrPresets(ctx.window, ["Env Model"]);

    const row = await getPresetRowByName(ctx.window, "Env Model");
    await expect(row).toBeVisible({ timeout: T_MEDIUM });
    await expect(row.getByText("ANTHROPIC_MODEL")).toBeVisible({ timeout: T_SHORT });
  });

  test("64. CCR preset with baseUrl shows ANTHROPIC_BASE_URL env key", async () => {
    writeCcrConfig([
      {
        id: "env-url",
        name: "Env Url",
        model: "test-model",
        baseUrl: "https://proxy.internal/v1",
      },
    ]);
    await waitForCcrPresets(ctx.window, ["Env Url"]);

    const row = await getPresetRowByName(ctx.window, "Env Url");
    await expect(row).toBeVisible({ timeout: T_MEDIUM });
    await expect(row.getByText("ANTHROPIC_BASE_URL")).toBeVisible({ timeout: T_SHORT });
  });

  test("65. Selecting default option (empty value) clears preset overrides", async () => {
    writeCcrConfig([{ id: "default-test", name: "Default Test", model: "default-model" }]);
    await waitForCcrPresets(ctx.window, ["Default Test"]);

    await expect(ctx.window.locator(SEL.preset.section)).toBeVisible({ timeout: T_MEDIUM });

    // First select the CCR preset so the trigger shows a non-default label.
    await getPresetRowByName(ctx.window, "Default Test");
    expect(await getSelectedPresetLabel(ctx.window)).toContain("Default Test");

    // Open the popover listbox and pick the default (blank) option.
    const trigger = ctx.window.locator(SEL.preset.selectorTrigger);
    await trigger.click({ force: true, noWaitAfter: true });
    const listbox = ctx.window.locator(SEL.preset.selectorListbox);
    await expect(listbox).toBeVisible({ timeout: T_SHORT });
    const defaultOption = listbox.locator(SEL.preset.defaultOption);
    await expect(defaultOption).toBeVisible({ timeout: T_SHORT });
    await defaultOption.click({ force: true, noWaitAfter: true });
    await expect(listbox).not.toBeVisible({ timeout: T_SHORT });

    await expect
      .poll(() => getSelectedPresetLabel(ctx.window), { timeout: T_MEDIUM })
      .toContain("Default");
  });

  test("66. Preset with 3 env vars shows all keys in row", async () => {
    writeCcrConfig([
      {
        id: "multi-env",
        name: "Multi Env",
        model: "multi-model",
        baseUrl: "https://multi.local",
        apiKeyEnv: "MY_SECRET_KEY",
      },
    ]);
    await waitForCcrPresets(ctx.window, ["Multi Env"]);

    const row = await getPresetRowByName(ctx.window, "Multi Env");
    await expect(row).toBeVisible({ timeout: T_MEDIUM });
    await expect(row.getByText("ANTHROPIC_MODEL")).toBeVisible({ timeout: T_SHORT });
    await expect(row.getByText("ANTHROPIC_BASE_URL")).toBeVisible({ timeout: T_SHORT });
    await expect(row.getByText("ANTHROPIC_API_KEY")).toBeVisible({ timeout: T_SHORT });
  });

  test("67. Select preset then switch to default clears default selection", async () => {
    writeCcrConfig([{ id: "select-a", name: "Select A", model: "select-a-model" }]);
    await waitForCcrPresets(ctx.window, ["Select A"]);

    await expect(ctx.window.locator(SEL.preset.section)).toBeVisible({ timeout: T_MEDIUM });

    // Select the named preset via the popover listbox.
    await getPresetRowByName(ctx.window, "Select A");
    await expect
      .poll(() => getSelectedPresetLabel(ctx.window), { timeout: T_MEDIUM })
      .toContain("Select A");

    // Switch back to the default (blank) option and verify the override clears.
    const trigger = ctx.window.locator(SEL.preset.selectorTrigger);
    await trigger.click({ force: true, noWaitAfter: true });
    const listbox = ctx.window.locator(SEL.preset.selectorListbox);
    await expect(listbox).toBeVisible({ timeout: T_SHORT });
    const defaultOption = listbox.locator(SEL.preset.defaultOption);
    await expect(defaultOption).toBeVisible({ timeout: T_SHORT });
    await defaultOption.click({ force: true, noWaitAfter: true });
    await expect(listbox).not.toBeVisible({ timeout: T_SHORT });

    await expect
      .poll(() => getSelectedPresetLabel(ctx.window), { timeout: T_MEDIUM })
      .toContain("Default");
  });

  test("68. Env var display uses font-mono truncated text in preset row", async () => {
    writeCcrConfig([
      {
        id: "mono-env",
        name: "Mono Env",
        model: "mono-model",
        baseUrl: "https://very-long-base-url.example.com/api/v1/longer-path",
      },
    ]);
    await waitForCcrPresets(ctx.window, ["Mono Env"]);

    const row = await getPresetRowByName(ctx.window, "Mono Env");
    await expect(row).toBeVisible({ timeout: T_MEDIUM });

    // Env vars must render in a monospace element, not just as plain row text.
    const envMono = row.locator(".font-mono", { hasText: "ANTHROPIC_MODEL" });
    await expect(envMono.first()).toBeVisible({ timeout: T_SHORT });
    await expect(envMono.first()).toContainText("ANTHROPIC_MODEL");
  });

  test("69. Two presets with same env key — select each and verify", async () => {
    writeCcrConfig([
      { id: "dup-first", name: "Dup First", model: "dup-model-a" },
      { id: "dup-second", name: "Dup Second", model: "dup-model-b" },
    ]);
    await waitForCcrPresets(ctx.window, ["Dup First", "Dup Second"]);

    // Select first preset and check its env key
    const row1 = await getPresetRowByName(ctx.window, "Dup First");
    await expect(row1).toBeVisible({ timeout: T_MEDIUM });
    await expect(row1.getByText("ANTHROPIC_MODEL")).toBeVisible({ timeout: T_SHORT });
    await expect
      .poll(() => getSelectedPresetLabel(ctx.window), { timeout: T_MEDIUM })
      .toContain("Dup First");

    // Select second preset and check its env key
    const row2 = await getPresetRowByName(ctx.window, "Dup Second");
    await expect(row2).toBeVisible({ timeout: T_MEDIUM });
    await expect(row2.getByText("ANTHROPIC_MODEL")).toBeVisible({ timeout: T_SHORT });

    // Verify second is now the selected preset via the trigger label.
    const label = await getSelectedPresetLabel(ctx.window);
    expect(label).toContain("Dup Second");
  });

  test("70. Settings section shows env keys correctly for created preset", async () => {
    writeCcrConfig([
      {
        id: "section-env",
        name: "Section Env",
        model: "section-model",
        baseUrl: "https://section.test",
        apiKeyEnv: "SECTION_KEY",
      },
    ]);
    await waitForCcrPresets(ctx.window, ["Section Env"]);

    const section = ctx.window.locator(SEL.preset.section);
    await expect(section).toBeVisible({ timeout: T_MEDIUM });

    const row = await getPresetRowByName(ctx.window, "Section Env");
    await expect(row).toBeVisible({ timeout: T_MEDIUM });

    const rowText = await row.textContent();
    expect(rowText).toContain("ANTHROPIC_MODEL");
    expect(rowText).toContain("ANTHROPIC_BASE_URL");
    expect(rowText).toContain("ANTHROPIC_API_KEY");
  });
});
