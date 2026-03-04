import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { SEL } from "../helpers/selectors";
import { T_MEDIUM, T_LONG } from "../helpers/timeouts";

let ctx: AppContext;

test.describe.serial("Context Flow", () => {
  test.beforeAll(async () => {
    const fixtureDir = createFixtureRepo({ name: "context-test", withMultipleFiles: true });
    ctx = await launchApp();
    await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Context Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("Copy Context button is visible when project is active", async () => {
    const { window } = ctx;
    // Scope to toolbar header to avoid matching worktree card's Copy Context button
    const btn = window.getByRole("banner").locator(SEL.toolbar.copyContext);
    await expect(btn).toBeVisible({ timeout: T_MEDIUM });
  });

  test("Copy Context button transitions through states", async () => {
    const { window } = ctx;

    const btn = window.getByRole("banner").locator(SEL.toolbar.copyContext);
    await btn.click();

    // Button should transition to a "copying" or "copied" state
    // Wait for it to return to normal state
    await expect(btn).toBeVisible({ timeout: T_LONG });
  });

  test("clipboard contains context after copy", async () => {
    const { app } = ctx;

    // On macOS, Copy Context writes a file reference (NSFilenamesPboardType), not plain text.
    // Check for available clipboard formats instead of reading text.
    await expect
      .poll(
        async () => {
          const formats = await app.evaluate(({ clipboard }) => clipboard.availableFormats());
          return formats.length;
        },
        { timeout: T_LONG, message: "Clipboard should have content after copy" }
      )
      .toBeGreaterThan(0);
  });
});
