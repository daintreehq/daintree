import { test, expect } from "@playwright/test";
import { closeApp, type AppContext } from "../../helpers/launch";
import { launchWithSamplePlugin, waitForRichPluginReady } from "../../helpers/plugins";

/**
 * Plugin `panels` contribution (#10473). The capability-rich `rich-daintree`
 * sample declares one non-PTY panel (`id: "rich-panel"`). `PluginService`
 * namespaces the kind id as `${pluginId}.${panelId}`, so the contributed kind
 * surfaces as `daintree.rich.rich-panel`. This proves a declared panel
 * contribution actually registers a spawnable panel kind against the
 * main-process registry — the runtime source of truth the panel palette reads
 * from.
 *
 * The contribution rides on `rich-daintree` rather than the minimal
 * `hello-daintree` so the reference plugin's empty-manifest assertions (its
 * "Other" category and "No special permissions" cases) stay intact.
 */
test.describe.serial("Core: Plugin panels contribution", () => {
  let ctx: AppContext;
  let fixtureCleanup: (() => void) | undefined;

  test.beforeAll(async () => {
    const { ctx: launched, cleanup } = await launchWithSamplePlugin("plugin-panels");
    ctx = launched;
    fixtureCleanup = cleanup;
    await waitForRichPluginReady(ctx.window);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("registers the contributed panel kind in the main-process registry", async () => {
    const kinds = await ctx.window.evaluate(() => window.electron.plugin.getPanelKinds());
    const richPanel = kinds.find((kind) => kind.id === "daintree.rich.rich-panel");

    expect(richPanel).toBeDefined();
    expect(richPanel).toMatchObject({
      id: "daintree.rich.rich-panel",
      name: "Rich Panel",
      extensionId: "daintree.rich",
      hasPty: false,
      showInPalette: true,
    });
  });
});
