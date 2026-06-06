import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { injectFault, clearAllFaults } from "../../helpers/ipcFaults";
import { connectGitHub, clearGitHubToken, refreshGitHubConfig } from "../../helpers/githubHelpers";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM } from "../../helpers/timeouts";
import { openSettings } from "../../helpers/panels";

let ctx: AppContext;
let fixtureCleanup: (() => void) | undefined;

async function openGitHubSettings(window: Page): Promise<void> {
  const heading = window.locator(SEL.settings.heading);
  if (!(await heading.isVisible().catch(() => false))) {
    await openSettings(window);
  }
  await expect(heading).toBeVisible({ timeout: T_MEDIUM });

  await window
    .locator(SEL.settings.navSidebar)
    .getByRole("tab", { name: "Code Forge", exact: true })
    .click();
  await expect(window.locator("h3", { hasText: "Code Forge" })).toBeVisible({ timeout: T_SHORT });
  await expect(window.locator("text=Loading GitHub settings...")).not.toBeVisible({
    timeout: T_MEDIUM,
  });
  await expect(window.locator(SEL.github.tokenBlock)).toBeVisible({ timeout: T_SHORT });
}

test.describe.serial("Core: GitHub settings token flow", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "github-settings" });
    fixtureCleanup = cleanup;
    ctx = await launchApp({ env: { DAINTREE_E2E_FAULT_MODE: "1" } });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, dir, "GitHub Settings Test");
  });

  test.afterEach(async () => {
    await clearAllFaults(ctx.app);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("token block renders with Test/Save disabled until input is entered", async () => {
    const { window } = ctx;
    await openGitHubSettings(window);

    const input = window.locator(SEL.github.tokenInput);
    const testButton = window.locator(SEL.github.testButton);
    const saveButton = window.locator(SEL.github.saveButton);

    await expect(input).toBeVisible();
    await expect(testButton).toBeDisabled();
    await expect(saveButton).toBeDisabled();

    await input.fill("ghp_some_typed_token");
    await expect(testButton).toBeEnabled();
    await expect(saveButton).toBeEnabled();

    await input.fill("");
    await expect(testButton).toBeDisabled();
    await expect(saveButton).toBeDisabled();
  });

  test("Test surfaces an error when validation fails", async () => {
    const { window } = ctx;
    await openGitHubSettings(window);

    // forge.validateToken backs the Test button; fault it so validation
    // deterministically fails without reaching the network.
    await injectFault(ctx.app, "forge:validate-token", "E2E_INJECTED_ERROR");

    await window.locator(SEL.github.tokenInput).fill("ghp_invalid_token");
    await window.locator(SEL.github.testButton).click();

    await expect(window.locator("text=Couldn't validate token")).toBeVisible({
      timeout: T_MEDIUM,
    });
    // The settings surface stays intact (no error-boundary fallback).
    await expect(window.locator(SEL.errorBoundary.fallback)).not.toBeVisible();
  });

  test("Save surfaces an error when persistence fails", async () => {
    const { window } = ctx;
    await openGitHubSettings(window);

    // github.setToken backs the Save button.
    await injectFault(ctx.app, "github:set-token", "E2E_INJECTED_ERROR");

    await window.locator(SEL.github.tokenInput).fill("ghp_unsavable_token");
    await window.locator(SEL.github.saveButton).click();

    await expect(window.locator("text=Couldn't save token")).toBeVisible({ timeout: T_MEDIUM });
    await expect(window.locator(SEL.errorBoundary.fallback)).not.toBeVisible();
  });

  test("connected state shows the badge and a Clear control", async () => {
    const { window } = ctx;
    await openGitHubSettings(window);

    // Seed an in-memory token and hydrate the renderer config store. The
    // settings tab reads the same store, so the connected badge + Clear button
    // appear without any real token validation.
    await connectGitHub(ctx.app, window);

    await expect(window.locator(SEL.github.connectedBadge)).toBeVisible({ timeout: T_MEDIUM });
    const clearButton = window
      .locator(SEL.github.tokenBlock)
      .getByRole("button", { name: "Clear token" });
    await expect(clearButton).toBeVisible();

    // Clearing removes the token and the connected affordances disappear.
    await clearButton.click();
    await expect(window.locator(SEL.github.connectedBadge)).not.toBeVisible({ timeout: T_MEDIUM });

    // Belt-and-braces: ensure no seeded token leaks into later specs.
    await clearGitHubToken(ctx.app);
    await refreshGitHubConfig(window);
  });
});
