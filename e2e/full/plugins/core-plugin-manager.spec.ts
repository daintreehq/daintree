import { test, expect } from "@playwright/test";
import { closeApp, type AppContext } from "../../helpers/launch";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM } from "../../helpers/timeouts";
import {
  launchWithSamplePlugin,
  openPluginManager,
  closePluginManager,
  SAMPLE_PLUGIN_LABEL,
} from "../../helpers/plugins";

/**
 * Plugin manager view smoke (#9558). The graduated full-screen manager — master
 * list of installed plugins + tabbed detail pane — has no E2E coverage yet; the
 * existing plugin specs exercise the host-API contract (platform bucket) and
 * cross-view contribution snapshots (resilience bucket), not this UI.
 *
 * Drives the live overlay against the sideloaded `hello-daintree` sample: open,
 * find the row under the "Built-in" group, populate the detail pane, switch
 * tabs, and dismiss. The sample declares `capabilities: []`, so the Permissions
 * tab is asserted to read "No special permissions".
 */
test.describe.serial("Core: Plugin manager view", () => {
  let ctx: AppContext;
  let fixtureCleanup: (() => void) | undefined;

  test.beforeAll(async () => {
    const { ctx: launched, cleanup } = await launchWithSamplePlugin("plugin-manager");
    ctx = launched;
    fixtureCleanup = cleanup;
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("opens the manager and lists the sample plugin under its category", async () => {
    const { window } = ctx;
    await openPluginManager(window);

    // The list groups by catalog category. The sample declares no `category`;
    // its contributed skill derives it to "AI & agents" (see
    // resolvePluginCategory). The header carries a trailing count, so match on
    // the aria-label, not text.
    const list = window.locator(SEL.plugin.list);
    await expect(list.getByRole("option", { name: "AI & agents", exact: true })).toBeVisible({
      timeout: T_MEDIUM,
    });
    // SEL.plugin.option already scopes to the listbox, so don't re-nest it under
    // `list` (that yields a `listbox listbox option` selector matching nothing).
    const sampleRow = window.locator(SEL.plugin.option).filter({ hasText: SAMPLE_PLUGIN_LABEL });
    await expect(sampleRow).toBeVisible({ timeout: T_MEDIUM });

    // Nothing is disabled yet, so no row carries the Disabled badge — disabled
    // plugins dim in place now instead of moving to a quarantine section.
    await expect(sampleRow.getByText("Disabled", { exact: true })).toHaveCount(0);

    await closePluginManager(window);
  });

  test("selecting a plugin fills the detail pane and switches tabs", async () => {
    const { window } = ctx;
    await openPluginManager(window);

    await window
      .locator(SEL.plugin.option)
      .filter({ hasText: SAMPLE_PLUGIN_LABEL })
      .first()
      .click();

    // Overview tab is the default and names the plugin + version. The detail
    // header is the only heading in the view, so scope the version assertion to
    // it — the list row also renders "v0.1.0", which would otherwise satisfy a
    // loose page-wide match without proving the detail pane populated.
    await expect(window.locator(SEL.plugin.tabOverview)).toHaveAttribute("aria-selected", "true");
    const detailHeading = window.getByRole("heading", { name: SAMPLE_PLUGIN_LABEL });
    await expect(detailHeading).toBeVisible({ timeout: T_MEDIUM });
    await expect(detailHeading.locator("..").getByText("v0.1.0")).toBeVisible();

    // Permissions tab: hello-daintree declares no capabilities.
    await window.locator(SEL.plugin.tabPermissions).click();
    await expect(window.locator(SEL.plugin.tabPermissions)).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await expect(window.getByText("No special permissions")).toBeVisible({ timeout: T_SHORT });

    await closePluginManager(window);
  });

  test("the back button dismisses the overlay", async () => {
    const { window } = ctx;
    await openPluginManager(window);

    await window.locator(SEL.plugin.back).click();
    await expect(window.locator(SEL.plugin.manager)).not.toBeVisible({ timeout: T_SHORT });
  });
});
