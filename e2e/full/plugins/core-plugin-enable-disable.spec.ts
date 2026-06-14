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
 * place (#9304): the row dims in place and gains a "Disabled" badge, but no
 * restart gate is needed.
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

  test("disabling a built-in plugin dims the row in place without a restart banner", async () => {
    const { window } = ctx;
    await openPluginManager(window);

    const toggle = window.getByRole("switch", { name: `Enable ${SAMPLE_PLUGIN_LABEL}` });
    await expect(toggle).toBeChecked();

    // No restart pending and no Disabled badge on a clean start.
    const sampleRow = window.locator(SEL.plugin.option).filter({ hasText: SAMPLE_PLUGIN_LABEL });
    await expect(sampleRow.getByText("Disabled", { exact: true })).toHaveCount(0);

    await toggle.click();

    // Desired state flips: the row stays in its category section (disabled
    // plugins dim in place, never relocate) and gains the Disabled badge.
    await expect(sampleRow.getByText("Disabled", { exact: true })).toBeVisible({
      timeout: T_MEDIUM,
    });
    await expect(toggle).not.toBeChecked();

    await expect(window.getByText("Restart required to apply plugin changes")).not.toBeVisible({
      timeout: T_MEDIUM,
    });

    // Re-enabling clears the desired/running mismatch and the banner with it.
    await toggle.click();
    await expect(toggle).toBeChecked();
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
