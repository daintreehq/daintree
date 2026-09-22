import { test, expect } from "@playwright/test";
import { closeApp, type AppContext } from "../../helpers/launch";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM } from "../../helpers/timeouts";
import {
  launchWithSamplePlugin,
  openPluginManager,
  SAMPLE_PLUGIN_LABEL,
} from "../../helpers/plugins";

/**
 * Plugin enable/disable lifecycle + restart gating (#9284, #9558). Toggling a
 * plugin is built in, so disabling it transitions the live plugin registry in
 * place (#9304): the switch carries disabled state without moving the row or
 * requiring a restart.
 */
test.describe.serial("Core: Plugin enable/disable", () => {
  let ctx: AppContext;
  let fixtureCleanup: (() => void) | undefined;

  test.beforeAll(async () => {
    const { ctx: launched, cleanup } = await launchWithSamplePlugin("plugin-enable-disable");
    ctx = launched;
    fixtureCleanup = cleanup;
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("disabling a built-in plugin keeps its row stable and updates live state without a restart", async () => {
    const { window } = ctx;
    await openPluginManager(window);

    const toggle = window.getByRole("switch", { name: `Enable ${SAMPLE_PLUGIN_LABEL}` });
    await expect(toggle).toBeChecked();

    const sampleRow = window.locator(SEL.plugin.option).filter({ hasText: SAMPLE_PLUGIN_LABEL });
    const initialBounds = await sampleRow.boundingBox();
    expect(initialBounds).not.toBeNull();

    const isDisabled = () =>
      window.evaluate(async () => {
        const plugins = await window.electron.plugin.list();
        return (
          plugins.find((plugin) => plugin.manifest.name === "daintree.hello")?.disabled === true
        );
      });

    await toggle.click();

    await expect(toggle).not.toBeChecked();
    await expect.poll(isDisabled, { timeout: T_MEDIUM }).toBe(true);
    await expect(sampleRow).toBeVisible();
    await expect.poll(() => sampleRow.boundingBox()).toEqual(initialBounds);

    await expect(window.getByText("Restart required to apply plugin changes")).not.toBeVisible({
      timeout: T_MEDIUM,
    });

    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect.poll(isDisabled, { timeout: T_MEDIUM }).toBe(false);
    await expect(window.getByText("Restart required to apply plugin changes")).not.toBeVisible({
      timeout: T_MEDIUM,
    });
  });

  test("re-enabling a built-in plugin does not require a restart confirmation", async () => {
    const { window } = ctx;
    // Self-contained: open() is idempotent, so this is safe whether or not the
    // previous serial test left the manager open.
    await openPluginManager(window);
    const toggle = window.getByRole("switch", { name: `Enable ${SAMPLE_PLUGIN_LABEL}` });
    await toggle.click();

    await expect(window.getByText("Restart required to apply plugin changes")).not.toBeVisible({
      timeout: T_MEDIUM,
    });

    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect(window.getByText("Restart Daintree now?")).not.toBeVisible({
      timeout: T_SHORT,
    });
  });
});
