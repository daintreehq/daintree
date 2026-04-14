import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { SEL } from "../helpers/selectors";
import { T_MEDIUM } from "../helpers/timeouts";
import { writeCcrConfig, removeCcrConfig, navigateToAgentSettings } from "../helpers/flavors";

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
    const row = ctx.window.locator(SEL.flavor.section).locator("div.flex.items-center.border", {
      hasText: "UI Debug",
    });
    await expect(row).toBeVisible({ timeout: T_MEDIUM });
  });
});
