import { test, expect, type Page } from "@playwright/test";
import { closeApp, type AppContext } from "../../helpers/launch";
import { launchWithSamplePlugin, waitForRichPluginReady } from "../../helpers/plugins";
import { T_LONG } from "../../helpers/timeouts";

/** Dispatch a renderer action through the E2E-only bridge. */
async function dispatchAction(page: Page, actionId: string, args?: unknown): Promise<unknown> {
  return page.evaluate(
    async (payload) => {
      const dispatch = (
        window as unknown as {
          __daintreeDispatchAction?: (
            id: string,
            a?: unknown,
            opts?: { source: string }
          ) => Promise<unknown>;
        }
      ).__daintreeDispatchAction;
      if (typeof dispatch !== "function") {
        throw new Error("__daintreeDispatchAction is not available");
      }
      return dispatch(payload.actionId, payload.args, { source: "menu" });
    },
    { actionId, args }
  );
}

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
    await waitForRichPluginReady(ctx.app, ctx.window);
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

  // Regression for #10512: registration alone (above) is NOT enough — the bug
  // was that a registered plugin panel never reached a mounted GridPanel because
  // the grid membership selectors dropped non-built-in kinds. This opens the
  // panel and asserts its React component actually MOUNTS over `plugin://`,
  // which is the coverage gap that let the bug ship.
  test("mounts the contributed view's React component in the grid", async () => {
    await dispatchAction(ctx.window, "panel.openPluginPanel", {
      kind: "daintree.rich.rich-panel",
    });

    // The view lazy-imports over `plugin://`; allow generous time for the cold
    // protocol load.
    await expect(ctx.window.getByText("Rich panel view mounted")).toBeVisible({
      timeout: T_LONG,
    });
  });
});
