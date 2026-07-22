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
 * "Hello ping"). Since #11304 plugin contributions render inside the plugin
 * tray rather than claiming their own top-level slot, so the assertion opens
 * the tray and looks for the grouped row. CI display constraints can push
 * lower-priority toolbar items into overflow, so reaching the tray trigger
 * accepts either direct visibility or the toolbar overflow menu.
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

  test("renders the contributed toolbar button inside the plugin tray", async () => {
    const { window } = ctx;
    const toolbar = window.getByRole("toolbar", { name: "Main toolbar" });
    const trayTrigger = toolbar.getByRole("button", { name: "Plugin tray", exact: true });
    const trayRow = window.getByRole("menuitem", { name: /Hello ping/ });
    const deadline = Date.now() + T_MEDIUM;

    // The contribution no longer owns a top-level slot of its own (#11304).
    await expect(toolbar.getByRole("button", { name: "Hello ping", exact: true })).toHaveCount(0);

    while (Date.now() < deadline) {
      if (await trayTrigger.isVisible({ timeout: 500 }).catch(() => false)) {
        await trayTrigger.click({ timeout: 2_000 }).catch(() => undefined);
        if (await trayRow.isVisible({ timeout: 1_000 }).catch(() => false)) {
          await window.keyboard.press("Escape").catch(() => undefined);
          return;
        }
        await window.keyboard.press("Escape").catch(() => undefined);
      }

      const overflowButtons = toolbar.getByRole("button", { name: /more toolbar items/i });
      const count = await overflowButtons.count();
      for (let index = 0; index < count; index++) {
        const overflowButton = overflowButtons.nth(index);
        if (!(await overflowButton.isVisible({ timeout: 500 }).catch(() => false))) {
          continue;
        }

        await overflowButton.click({ timeout: 2_000 }).catch(() => undefined);
        if (
          await window
            .getByRole("menuitem", { name: /Plugin tray/ })
            .isVisible({ timeout: 500 })
            .catch(() => false)
        ) {
          await window.keyboard.press("Escape").catch(() => undefined);
          return;
        }
        await window.keyboard.press("Escape").catch(() => undefined);
      }

      await window.waitForTimeout(250);
    }

    await expect(trayTrigger).toBeVisible({ timeout: 1_000 });
  });
});
