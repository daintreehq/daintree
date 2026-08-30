import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../../helpers/timeouts";
import { openSettings, openTerminal, selectSettingsScope } from "../../helpers/panels";
import { runTerminalCommand, waitForTerminalText } from "../../helpers/terminal";

let ctx: AppContext;
let fixtureDir: string | undefined;
let fixtureCleanup: (() => void) | undefined;

function echoGlobalEnvCommand(): string {
  if (process.platform === "win32") {
    return 'Write-Output ("ENVCHECK_" + $env:TEST_GLOBAL_KEY + "_ENVCHECK")';
  }
  return "echo ENVCHECK_${TEST_GLOBAL_KEY}_ENVCHECK";
}

test.describe.serial("Full: Global Environment Variable Inheritance", () => {
  test.beforeAll(async () => {
    ctx = await launchApp();
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("Global Environment tab works without a project", async () => {
    const { window } = ctx;
    await openSettings(window);
    await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

    await window.locator(`${SEL.settings.navSidebar} button`, { hasText: "Environment" }).click();
    await expect(window.locator("h3", { hasText: "Environment Variables" })).toBeVisible({
      timeout: T_SHORT,
    });

    // Description should mention "global"
    const description = window.locator("#environment-variables");
    await expect(description.locator("text=Global environment variables")).toBeVisible({
      timeout: T_SHORT,
    });

    // Should NOT show "No project open" message — the global tab works without a project
    await expect(window.locator("text=No project open")).not.toBeVisible({ timeout: T_SETTLE });

    await window.keyboard.press("Escape");
    await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
  });

  test("Set global environment variables", async () => {
    const { window } = ctx;
    await openSettings(window);
    await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

    await window.locator(`${SEL.settings.navSidebar} button`, { hasText: "Environment" }).click();
    await expect(window.locator("h3", { hasText: "Environment Variables" })).toBeVisible({
      timeout: T_SHORT,
    });

    // Click "Add Variable"
    await window.locator("button", { hasText: "Add Variable" }).click();

    // Fill in the key
    const nameInputs = window.locator('[aria-label="Environment variable name"]');
    await nameInputs.last().fill("TEST_GLOBAL_KEY");

    // Fill in the value
    const valueInputs = window.locator('[aria-label="Environment variable value"]');
    await valueInputs.last().fill("test_global_value");

    // Save
    await window.locator("button", { hasText: "Save" }).click();
    await window.waitForTimeout(T_SETTLE);

    // Verify save button disappears (isDirty becomes false)
    await expect(window.locator("button", { hasText: "Saving…" })).not.toBeVisible({
      timeout: T_MEDIUM,
    });

    await window.keyboard.press("Escape");
    await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
  });

  test("Global vars appear in project Variables tab", async () => {
    // Open a fixture project
    const { dir, cleanup } = createFixtureRepo({ name: "env-inheritance" });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, dir, "Env Inheritance Test");
    const { window } = ctx;

    await openSettings(window);
    await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

    // Switch to Project scope (Radix Select)
    await selectSettingsScope(window, "Project");
    await window.waitForTimeout(T_SETTLE);

    // Click Variables tab
    await window.locator(`${SEL.settings.navSidebar} button`, { hasText: "Variables" }).click();
    await expect(window.locator("h3", { hasText: "Environment Variables" })).toBeVisible({
      timeout: T_SHORT,
    });

    // Verify the global var appears with "Global" badge (scope to the tab panel
    // so we don't hit the <option value="global">Global</option> in the sidebar
    // scope selector, which also matches text="Global").
    const variablesPanel = window.locator("#settings-panel-project\\:variables");
    await expect(variablesPanel.getByText("TEST_GLOBAL_KEY")).toBeVisible({ timeout: T_MEDIUM });
    await expect(variablesPanel.getByText("Global", { exact: true })).toBeVisible({
      timeout: T_SHORT,
    });
  });

  test("Project var overrides show Overridden badge", async () => {
    const { window } = ctx;

    // We're already on the project Variables tab from the previous test.
    // Add a project variable with the same key.
    await window.locator("button", { hasText: "Add Variable" }).click();

    const nameInputs = window.locator('[aria-label="Environment variable name"]');
    await nameInputs.last().fill("TEST_GLOBAL_KEY");

    const valueInputs = window.locator('[aria-label="Environment variable value"]');
    await valueInputs.last().fill("project_override");

    // Save the project variable
    await window.locator("button", { hasText: "Save" }).click();
    await window.waitForTimeout(T_SETTLE);

    // Verify the global row now shows "Overridden" badge
    await expect(window.locator("text=Overridden")).toBeVisible({ timeout: T_MEDIUM });

    await window.keyboard.press("Escape");
    await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
  });

  test("Terminal inherits environment variables with project override", async () => {
    let { window } = ctx;

    if ((await window.locator("[data-worktree-branch]").count()) === 0) {
      expect(fixtureDir).toBeTruthy();
      ctx.window = await openAndOnboardProject(
        ctx.app,
        window,
        fixtureDir!,
        "Env Inheritance Test"
      );
      window = ctx.window;
    }

    await expect(window.locator("[data-worktree-branch]").first()).toBeVisible({
      timeout: T_LONG,
    });

    // Open a terminal
    await openTerminal(window);
    const panel = window.locator(SEL.panel.gridPanel).last();
    await expect(panel).toBeVisible({ timeout: T_LONG });
    await expect(panel.locator(SEL.terminal.xtermRows)).toBeVisible({ timeout: T_LONG });

    // Run echo command to check the env var value
    await runTerminalCommand(window, panel, echoGlobalEnvCommand());
    // Project override should win over global
    await waitForTerminalText(panel, "ENVCHECK_project_override_ENVCHECK", T_LONG);
  });
});
