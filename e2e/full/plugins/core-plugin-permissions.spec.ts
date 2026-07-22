import { test, expect } from "@playwright/test";
import { closeApp, type AppContext } from "../../helpers/launch";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM } from "../../helpers/timeouts";
import {
  launchWithSamplePlugin,
  openPluginManager,
  closePluginManager,
  waitForRichPluginReady,
  RICH_PLUGIN_LABEL,
  SAMPLE_PLUGIN_LABEL,
} from "../../helpers/plugins";

/**
 * Plugin Permissions tab coverage (#9592). The existing manager spec only
 * asserts the empty case ("No special permissions") against `hello-daintree`.
 * This drives the populated case against `rich-daintree`, which declares
 * `fs:project-read` (neutral), `fs:project-write` (warning + elevates the whole
 * plugin to `pluginDanger: "confirm"`), and a scoped `network:fetch`.
 *
 * Asserts the danger summary banner, the per-capability rows with their
 * severity-driven labels, and the scoped network URL — then re-checks the
 * `hello-daintree` empty case so the two plugins coexisting under "Built-in"
 * doesn't regress the original assertion.
 */
test.describe.serial("Core: Plugin permissions tab", () => {
  let ctx: AppContext;
  let fixtureCleanup: (() => void) | undefined;

  test.beforeAll(async () => {
    const { ctx: launched, cleanup } = await launchWithSamplePlugin("plugin-permissions");
    ctx = launched;
    fixtureCleanup = cleanup;
    await waitForRichPluginReady(ctx.app, ctx.window);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("shows the danger summary and capability rows for a capability-rich plugin", async () => {
    const { window } = ctx;
    await openPluginManager(window);

    await window.locator(SEL.plugin.option).filter({ hasText: RICH_PLUGIN_LABEL }).first().click();

    await window.locator(SEL.plugin.tabPermissions).click();
    await expect(window.locator(SEL.plugin.tabPermissions)).toHaveAttribute(
      "aria-selected",
      "true"
    );

    // fs:project-write elevates the whole plugin to "confirm", so the warning
    // summary banner renders above the capability list.
    await expect(
      window.getByText("Requests sensitive permissions — review before enabling")
    ).toBeVisible({ timeout: T_MEDIUM });

    // Warning-severity capability (write) and neutral-severity capability (read).
    await expect(window.getByText("Write project files")).toBeVisible();
    await expect(window.getByText("Read project files")).toBeVisible();

    // network:fetch row plus its scoped allow-list URL rendered inline.
    await expect(window.getByText("Make network requests")).toBeVisible();
    await expect(window.getByText("https://api.example.com")).toBeVisible();

    await closePluginManager(window);
  });

  test("hides the Permissions tab entirely for the capability-free sample (#11302)", async () => {
    const { window } = ctx;
    await openPluginManager(window);

    await window
      .locator(SEL.plugin.option)
      .filter({ hasText: SAMPLE_PLUGIN_LABEL })
      .first()
      .click();

    // Overview must be present so the pane isn't just failing to render.
    await expect(window.locator(SEL.plugin.tabOverview)).toBeVisible({ timeout: T_SHORT });
    // A tab whose whole content was "No special permissions" is now absent.
    await expect(window.locator(SEL.plugin.tabPermissions)).toHaveCount(0);
    await expect(window.getByText("No special permissions")).toHaveCount(0);

    // The danger banner must NOT appear for a plugin with no capabilities.
    await expect(
      window.getByText("Requests sensitive permissions — review before enabling")
    ).toHaveCount(0);

    await closePluginManager(window);
  });
});
