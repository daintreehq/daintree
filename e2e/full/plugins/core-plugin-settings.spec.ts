import { test, expect, type Page } from "@playwright/test";
import { closeApp, type AppContext } from "../../helpers/launch";
import { SEL } from "../../helpers/selectors";
import { T_MEDIUM } from "../../helpers/timeouts";
import {
  launchWithSamplePlugin,
  openPluginManager,
  closePluginManager,
  waitForRichPluginReady,
  RICH_PLUGIN_LABEL,
} from "../../helpers/plugins";

const PLUGIN_ID = "daintree.rich";

/** Read the rich plugin's stored user-scope setting values over IPC. */
async function userValues(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(async (pluginId) => {
    const res = await window.electron.plugin.getSettingValues(pluginId, "user", null);
    return res.values;
  }, PLUGIN_ID);
}

/** Read the rich plugin's stored user-scope secret key ids over IPC. */
async function userSecretsSet(page: Page): Promise<string[]> {
  return page.evaluate(async (pluginId) => {
    const res = await window.electron.plugin.getSettingValues(pluginId, "user", null);
    return res.secretsSet;
  }, PLUGIN_ID);
}

/** Remove user-scope rich-plugin settings so the serial form tests start clean. */
async function resetUserSettings(page: Page): Promise<void> {
  await page.evaluate(async (pluginId) => {
    await Promise.all(
      ["greeting", "retries", "verbose", "level", "config", "apiKey"].map((key) =>
        window.electron.plugin.deleteSettingValue(pluginId, key, "user", null)
      )
    );
  }, PLUGIN_ID);
}

/** Open the manager, select the rich plugin, and switch to its Settings tab. */
async function openRichSettings(page: Page): Promise<void> {
  await openPluginManager(page);
  const option = page.locator(SEL.plugin.option).filter({ hasText: RICH_PLUGIN_LABEL }).first();
  await expect(option).toBeVisible({ timeout: T_MEDIUM });
  if ((await option.getAttribute("aria-selected")) !== "true") {
    await option.click();
  }

  const settingsTab = page.locator(SEL.plugin.tabSettings);
  await expect(settingsTab).toBeVisible({ timeout: T_MEDIUM });
  await settingsTab.click();
  await expect(settingsTab).toHaveAttribute("aria-selected", "true");
}

/**
 * Plugin Settings form coverage (#9592). `hello-daintree` declares no
 * `contributes.settings`, so the generated form has no E2E coverage. This drives
 * the form against `rich-daintree`, which declares one field of every supported
 * type, and asserts the fill → blur-commit → persisted round-trip for each
 * (verified over IPC), plus number/JSON validation, secret reveal, reset, and a
 * project-scoped field.
 *
 * The form disables controls until `getSettingValues` resolves and commits text
 * fields on blur, so every interaction gates on `toBeEnabled()` and then blurs
 * (Tab / click elsewhere) before asserting persistence.
 */
test.describe.serial("Core: Plugin settings form", () => {
  let ctx: AppContext;
  let fixtureCleanup: (() => void) | undefined;

  test.beforeAll(async () => {
    const { ctx: launched, cleanup } = await launchWithSamplePlugin("plugin-settings");
    ctx = launched;
    fixtureCleanup = cleanup;
    await waitForRichPluginReady(ctx.app, ctx.window);
    await resetUserSettings(ctx.window);
  });

  test.afterAll(async () => {
    if (ctx?.window) await resetUserSettings(ctx.window);
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("persists a string field on blur", async () => {
    const { window } = ctx;
    await openRichSettings(window);

    const input = window.getByLabel("Greeting", { exact: true });
    await expect(input).toBeEnabled({ timeout: T_MEDIUM });
    await input.fill("howdy");
    await window.keyboard.press("Tab");

    await expect.poll(() => userValues(window)).toMatchObject({ greeting: "howdy" });

    await closePluginManager(window);
  });

  test("persists a valid number and rejects an out-of-range one", async () => {
    const { window } = ctx;
    await openRichSettings(window);

    const input = window.getByLabel("Retries", { exact: true });
    await expect(input).toBeEnabled({ timeout: T_MEDIUM });
    await input.fill("7");
    await window.keyboard.press("Tab");
    await expect.poll(() => userValues(window)).toMatchObject({ retries: 7 });

    // Above max (10) → inline error, stored value unchanged.
    await input.fill("99");
    await window.keyboard.press("Tab");
    await expect(window.getByText("Must be at most 10")).toBeVisible();
    await expect.poll(() => userValues(window)).toMatchObject({ retries: 7 });

    await closePluginManager(window);
  });

  test("toggles a boolean field", async () => {
    const { window } = ctx;
    await openRichSettings(window);

    const toggle = window.getByRole("switch", { name: "Verbose mode" });
    await expect(toggle).toBeEnabled({ timeout: T_MEDIUM });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    await expect.poll(() => userValues(window)).toMatchObject({ verbose: true });

    await closePluginManager(window);
  });

  test("persists an enum selection", async () => {
    const { window } = ctx;
    await openRichSettings(window);

    const select = window.getByLabel("Log level", { exact: true });
    await expect(select).toBeEnabled({ timeout: T_MEDIUM });
    await select.selectOption("warn");

    await expect.poll(() => userValues(window)).toMatchObject({ level: "warn" });

    await closePluginManager(window);
  });

  test("persists valid JSON and rejects malformed JSON", async () => {
    const { window } = ctx;
    await openRichSettings(window);

    const textarea = window.getByLabel("Extra config", { exact: true });
    await expect(textarea).toBeEnabled({ timeout: T_MEDIUM });
    await textarea.fill('{"key":"val"}');
    await window.keyboard.press("Tab");
    await expect.poll(() => userValues(window)).toMatchObject({ config: { key: "val" } });

    // Malformed JSON → inline error, stored value unchanged.
    await textarea.fill("{bad");
    await window.keyboard.press("Tab");
    await expect(window.getByText("Enter valid JSON")).toBeVisible();
    await expect.poll(() => userValues(window)).toMatchObject({ config: { key: "val" } });

    await closePluginManager(window);
  });

  test("stores a secret and reveals it on demand", async () => {
    const { window } = ctx;
    await openRichSettings(window);

    const input = window.getByLabel("API key", { exact: true });
    await expect(input).toBeEnabled({ timeout: T_MEDIUM });
    await expect(input).toHaveAttribute("type", "password");
    await input.fill("s3cr3t");
    await window.keyboard.press("Tab");

    // The secret is reported as set (its value never rides on getSettingValues).
    await expect.poll(() => userSecretsSet(window)).toContain("apiKey");

    // Revealing flips the input to plaintext and surfaces the stored value.
    const reveal = window.getByRole("button", { name: "Reveal API key" });
    await expect(reveal).toBeVisible({ timeout: T_MEDIUM });
    await reveal.click();
    await expect(input).toHaveAttribute("type", "text");
    await expect(input).toHaveValue("s3cr3t");

    await closePluginManager(window);
  });

  test("resets a field back to its default", async () => {
    const { window } = ctx;
    await openRichSettings(window);

    // Give greeting a stored override.
    const input = window.getByLabel("Greeting", { exact: true });
    await expect(input).toBeEnabled({ timeout: T_MEDIUM });
    await input.fill("temporary");
    await window.keyboard.press("Tab");
    await expect.poll(() => userValues(window)).toMatchObject({ greeting: "temporary" });

    // The reset affordance only appears once a value is stored, and the form
    // reads `storedValue` at mount — so remount the tab to pick up the override.
    await window.locator(SEL.plugin.tabOverview).click();
    await window.locator(SEL.plugin.tabSettings).click();

    const reset = window.getByRole("button", { name: "Reset Greeting to default" });
    await expect(reset).toBeVisible({ timeout: T_MEDIUM });
    await reset.click();

    // Reset drops the stored override (the field falls back to the manifest default).
    await expect
      .poll(async () => Object.prototype.hasOwnProperty.call(await userValues(window), "greeting"))
      .toBe(false);

    await closePluginManager(window);
  });

  test("persists a project-scoped field, verified by reload", async () => {
    const { window } = ctx;
    await openRichSettings(window);

    const input = window.getByLabel("Project note", { exact: true });
    await expect(input).toBeEnabled({ timeout: T_MEDIUM });
    await input.fill("scoped-note");
    await window.keyboard.press("Tab");

    // Project-scoped values are keyed by the active project id (not exposed to
    // the test), so verify persistence the way the form itself does: remount the
    // tab and confirm the stored value re-hydrates the control.
    await window.locator(SEL.plugin.tabOverview).click();
    await window.locator(SEL.plugin.tabSettings).click();

    const reloaded = window.getByLabel("Project note", { exact: true });
    await expect(reloaded).toBeEnabled({ timeout: T_MEDIUM });
    await expect(reloaded).toHaveValue("scoped-note");

    await closePluginManager(window);
  });
});
