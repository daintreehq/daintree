import { test, expect } from "@playwright/test";
import { closeApp, type AppContext } from "../../helpers/launch";
import { launchWithSamplePlugin, getPluginToolbarButtonIds } from "../../helpers/plugins";
import { T_MEDIUM } from "../../helpers/timeouts";

/**
 * Plugin contribution rendering (#9286, #9558). The host-contract spec proves a
 * contributed action reaches the action palette and a handler round-trips over
 * IPC; this asserts the complementary surface neither existing spec covers — a
 * declared `toolbarButtons` contribution actually painting into the live main
 * toolbar DOM, matched against the main-process registry as ground truth.
 *
 * The sample manifest declares one toolbar button (`id: "ping"`, label
 * "Hello ping"). The launch window maximizes to ≥1920px, so a single contributed
 * button stays in the main toolbar rather than the overflow menu.
 */
test.describe.serial("Core: Plugin contributions", () => {
  let ctx: AppContext;
  let fixtureCleanup: (() => void) | undefined;

  test.beforeAll(async () => {
    const { ctx: launched, cleanup } = await launchWithSamplePlugin("plugin-contributions");
    ctx = launched;
    fixtureCleanup = cleanup;
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("registers the contributed toolbar button in the main-process registry", async () => {
    // The registry namespaces ids as `${pluginId}.${manifestButtonId}`, so the
    // manifest's `ping` surfaces as `daintree.hello.ping`.
    const buttonIds = await getPluginToolbarButtonIds(ctx.window);
    expect(buttonIds).toContain("daintree.hello.ping");
  });

  test("renders the contributed toolbar button in the live toolbar", async () => {
    const { window } = ctx;
    const toolbar = window.getByRole("toolbar", { name: "Main toolbar" });
    await expect(toolbar.getByRole("button", { name: "Hello ping" })).toBeVisible({
      timeout: T_MEDIUM,
    });
  });
});
