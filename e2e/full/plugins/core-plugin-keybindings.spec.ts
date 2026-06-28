import { test, expect } from "@playwright/test";
import { closeApp, type AppContext } from "../../helpers/launch";
import { launchWithSamplePlugin, waitForRichPluginReady } from "../../helpers/plugins";

/**
 * Plugin `keybindings` contribution (#10473). The `rich-daintree` sample
 * declares one keybinding (`CmdOrCtrl+Shift+R`) bound to the plugin's own
 * `daintree.rich.ready` action. This asserts the declared binding reaches the
 * main-process keybinding registry — the runtime source the renderer's
 * `usePluginKeybindings` hook pulls from.
 *
 * The assertion is registry-only by design: firing the combo and observing the
 * effect is flaky in headless CI (scope matching needs a focused element, and
 * `CmdOrCtrl` resolves to `Control` on Linux vs `Meta` on macOS), so the
 * registry is the stable cross-platform proof the contribution point is wired.
 */
test.describe.serial("Core: Plugin keybindings contribution", () => {
  let ctx: AppContext;
  let fixtureCleanup: (() => void) | undefined;

  test.beforeAll(async () => {
    const { ctx: launched, cleanup } = await launchWithSamplePlugin("plugin-keybindings");
    ctx = launched;
    fixtureCleanup = cleanup;
    await waitForRichPluginReady(ctx.app, ctx.window);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("registers the contributed keybinding in the main-process registry", async () => {
    const keybindings = await ctx.window.evaluate(() => window.electron.plugin.keybindings());
    const richBinding = keybindings.find((entry) => entry.item.actionId === "daintree.rich.ready");

    expect(richBinding).toBeDefined();
    expect(richBinding).toMatchObject({
      pluginId: "daintree.rich",
      item: {
        actionId: "daintree.rich.ready",
        combo: "CmdOrCtrl+Shift+R",
        scope: "global",
      },
    });
  });
});
