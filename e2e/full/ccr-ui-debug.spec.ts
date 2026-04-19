import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { SEL } from "../helpers/selectors";
import { T_MEDIUM } from "../helpers/timeouts";
import {
  writeCcrConfig,
  removeCcrConfig,
  navigateToAgentSettings,
  getFlavorRowByName,
} from "../helpers/flavors";

let ctx: AppContext;
test.describe("CCR UI Debug", () => {
  test.beforeAll(async () => {
    writeCcrConfig([{ id: "uidbg", name: "UI Debug", model: "uidbg-model" }]);
    ctx = await launchApp();
    const fixtureDir = createFixtureRepo({ name: "ccr-ui-debug" });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "UI Debug");
  });
  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("flavors section appears after navigating to Claude settings", async () => {
    await navigateToAgentSettings(ctx.window, "claude");
    // Wait up to 10s for the section to appear
    const section = ctx.window.locator(SEL.flavor.section);
    await expect(section).toBeVisible({ timeout: 10_000 });
  });

  test("CCR flavor row is visible", async () => {
    await navigateToAgentSettings(ctx.window, "claude");
    // Select the CCR flavor in the Popover, then assert the detail view
    // renders with an `auto` badge (the indicator that it's a CCR flavor).
    const detail = await getFlavorRowByName(ctx.window, "UI Debug");
    await expect(detail).toBeVisible({ timeout: T_MEDIUM });
    await expect(detail.locator(SEL.flavor.autoBadge)).toBeVisible();
  });
});
