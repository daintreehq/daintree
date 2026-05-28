import path from "path";
import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";

const mod = process.platform === "darwin" ? "Meta" : "Control";
const ROOT = path.resolve(import.meta.dirname, "../../..");
const SAMPLE_PLUGINS_DIR = path.join(ROOT, "dist-electron/plugins/sample");

/**
 * Plugin host-contract harness (#9286). Sideloads the `hello-daintree` sample
 * plugin through `DAINTREE_E2E_SIDELOAD_PLUGIN_DIR` (the env-var-stripped
 * production binary ignores this), then exercises three host-API surfaces
 * end-to-end:
 *
 *   1. `host.showToast` during `activate()` → durable inbox entry
 *   2. `host.registerAction` → action visible in the action palette
 *   3. dispatch from the palette → handler's `host.showToast` → second inbox entry
 *
 * Inbox-based assertions are chosen over live toast assertions because the
 * inbox is durable: `notify()` writes to history regardless of toast
 * suppression / dismiss timing, so the spec is not racing the toast queue.
 */

test.describe.serial("Core: Plugin host-contract harness", () => {
  let ctx: AppContext;
  let fixtureCleanup: (() => void) | undefined;

  test.beforeAll(async () => {
    ctx = await launchApp({
      env: { DAINTREE_E2E_SIDELOAD_PLUGIN_DIR: SAMPLE_PLUGINS_DIR },
    });
    const { dir, cleanup } = createFixtureRepo({ name: "plugin-host-contract" });
    fixtureCleanup = cleanup;
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, dir, "Plugin Host Contract");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("activation toast lands in the notification inbox", async () => {
    const { window } = ctx;
    const bell = window.locator(SEL.notifications.bellButton);
    await expect(bell).toBeVisible({ timeout: T_LONG });
    await bell.click();
    await expect(bell).toHaveAttribute("aria-expanded", "true", { timeout: T_SHORT });

    // Plugin activation toasts are prefixed with `{pluginId}: ...` by the host
    // (see PluginService.showToast). Look for the prefixed form so we also
    // verify the provenance namespacing.
    await expect(
      window.locator("text=daintree.hello: Hello Daintree plugin activated").first()
    ).toBeVisible({ timeout: T_LONG });

    await window.keyboard.press("Escape");
    await expect(bell).toHaveAttribute("aria-expanded", "false", { timeout: T_SHORT });
  });

  test("registerAction surfaces the action in the action palette", async () => {
    const { window } = ctx;
    await window.keyboard.press(`${mod}+Shift+P`);
    const dialog = window.locator(SEL.actionPalette.dialog);
    await expect(dialog).toBeVisible({ timeout: T_MEDIUM });

    const searchInput = window.locator(SEL.actionPalette.searchInput);
    await searchInput.fill("Hello: Greet");

    const greetOption = window
      .locator(SEL.actionPalette.options)
      .filter({ hasText: "Hello: Greet" });
    await expect(greetOption.first()).toBeVisible({ timeout: T_MEDIUM });

    await window.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible({ timeout: T_SHORT });
  });

  test("dispatching the action through the palette fires showToast end-to-end", async () => {
    const { window } = ctx;
    await window.keyboard.press(`${mod}+Shift+P`);
    const dialog = window.locator(SEL.actionPalette.dialog);
    await expect(dialog).toBeVisible({ timeout: T_MEDIUM });

    const searchInput = window.locator(SEL.actionPalette.searchInput);
    await searchInput.fill("Hello: Greet");
    const greetOption = window
      .locator(SEL.actionPalette.options)
      .filter({ hasText: "Hello: Greet" });
    await expect(greetOption.first()).toBeVisible({ timeout: T_MEDIUM });
    await greetOption.first().click();
    await expect(dialog).not.toBeVisible({ timeout: T_MEDIUM });

    // The handler calls host.showToast — same provenance prefix applies.
    const bell = window.locator(SEL.notifications.bellButton);
    await bell.click();
    await expect(bell).toHaveAttribute("aria-expanded", "true", { timeout: T_SHORT });
    await expect(
      window.locator("text=daintree.hello: Hello from the greet action").first()
    ).toBeVisible({ timeout: T_LONG });

    await window.keyboard.press("Escape");
  });
});
