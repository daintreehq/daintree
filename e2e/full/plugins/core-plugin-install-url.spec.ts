import { test, expect } from "@playwright/test";
import { closeApp, type AppContext } from "../../helpers/launch";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM } from "../../helpers/timeouts";
import {
  launchWithSamplePlugin,
  openPluginManager,
  closePluginManager,
} from "../../helpers/plugins";

/**
 * Install-from-URL dialog coverage (#9592). The actual download runs in the main
 * process (`window.electron.plugin.installFromUrl`), so `page.route()` can't
 * intercept it — this spec deliberately covers the renderer-side dialog flow
 * only: open the dialog, the URL-gated enablement of the Install button, and the
 * HTTPS-vs-HTTP confirm gate. No real install is performed (the HTTP path is
 * always cancelled, and an HTTPS submit is never confirmed).
 */
test.describe.serial("Core: Plugin install-from-URL dialog", () => {
  let ctx: AppContext;
  let fixtureCleanup: (() => void) | undefined;

  test.beforeAll(async () => {
    const { ctx: launched, cleanup } = await launchWithSamplePlugin("plugin-install-url");
    ctx = launched;
    fixtureCleanup = cleanup;
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("opens the dialog and gates the Install button on a non-empty URL", async () => {
    const { window } = ctx;
    await openPluginManager(window);

    await window.locator(SEL.plugin.installFromUrlButton).click();

    const urlInput = window.locator(SEL.plugin.urlInput);
    await expect(urlInput).toBeVisible({ timeout: T_MEDIUM });

    // Empty URL → Install disabled (footer button, matched exactly so it doesn't
    // collide with the "Install from file"/"Install from URL" trigger buttons).
    const installButton = window.getByRole("button", { name: "Install", exact: true });
    await expect(installButton).toBeDisabled();

    await urlInput.fill("https://example.com/plugin.dntr");
    await expect(installButton).toBeEnabled();

    // Close without installing.
    await window.getByRole("button", { name: "Cancel" }).click();
    await expect(urlInput).toBeHidden({ timeout: T_SHORT });

    await closePluginManager(window);
  });

  test("an http:// URL routes through the HTTP confirm gate, which can be cancelled", async () => {
    const { window } = ctx;
    await openPluginManager(window);

    await window.locator(SEL.plugin.installFromUrlButton).click();

    const urlInput = window.locator(SEL.plugin.urlInput);
    await expect(urlInput).toBeVisible({ timeout: T_MEDIUM });
    await urlInput.fill("http://example.com/plugin.dntr");

    await window.getByRole("button", { name: "Install", exact: true }).click();

    // The non-HTTPS URL surfaces the "Install over HTTP?" confirm before any
    // download starts.
    const httpDialog = window.locator(SEL.plugin.httpWarningDialog);
    await expect(httpDialog).toBeVisible({ timeout: T_MEDIUM });

    // Cancel the gate — no install happens.
    await httpDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(httpDialog).toBeHidden({ timeout: T_SHORT });

    // The URL dialog stays open behind the dismissed gate — close it before the
    // manager so its focus trap doesn't swallow the manager-close click.
    const urlDialogCancel = window.getByRole("button", { name: "Cancel" });
    if (await urlDialogCancel.isVisible().catch(() => false)) {
      await urlDialogCancel.click();
      await expect(urlInput).toBeHidden({ timeout: T_SHORT });
    }

    await closePluginManager(window);
  });
});
