import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { injectFault, clearAllFaults } from "../../helpers/ipcFaults";
import {
  connectGitHub,
  clearGitHubToken,
  refreshGitHubConfig,
  selectGitHubSettingsProvider,
} from "../../helpers/githubHelpers";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM } from "../../helpers/timeouts";
import { openSettings } from "../../helpers/panels";

let ctx: AppContext;

// The error renders on the field and again as a visually hidden live-region
// copy, so resolve the field's own error through its aria-describedby.
async function expectTokenFieldError(window: Page, message: string): Promise<void> {
  const input = window.locator(SEL.github.tokenInput);
  await expect(input).toHaveAttribute("aria-invalid", "true", { timeout: T_MEDIUM });
  await expect(input).toHaveAccessibleDescription(new RegExp(`^${message}`));
  const errorId = (await input.getAttribute("aria-describedby"))?.split(/\s+/)[0];
  expect(errorId).toBeTruthy();
  const fieldError = window.locator(`[id="${errorId}"]`);
  await expect(fieldError).toHaveText(message);
  await expect(fieldError).toBeVisible();
}
let fixtureCleanup: (() => void) | undefined;

async function openGitHubSettings(window: Page): Promise<void> {
  const heading = window.locator(SEL.settings.heading);
  if (!(await heading.isVisible().catch(() => false))) {
    await openSettings(window);
  }
  await expect(heading).toBeVisible({ timeout: T_MEDIUM });

  await window
    .locator(SEL.settings.navSidebar)
    .getByRole("tab", { name: "Code forge", exact: true })
    .click();
  await expect(window.locator("h3", { hasText: "Code Forge" })).toBeVisible({ timeout: T_SHORT });
  await selectGitHubSettingsProvider(window);
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

    await expectTokenFieldError(window, "Couldn't validate token");
    // The settings surface stays intact (no error-boundary fallback).
    await expect(window.locator(SEL.errorBoundary.fallback)).not.toBeVisible();
  });

  test("Save surfaces an error when persistence fails", async () => {
    const { window } = ctx;
    await openGitHubSettings(window);

    // window.electron.forge.setCredential (the forge:set-credential IPC channel) backs the Save button.
    await injectFault(ctx.app, "forge:set-credential", "E2E_INJECTED_ERROR");

    await window.locator(SEL.github.tokenInput).fill("ghp_unsavable_token");
    await window.locator(SEL.github.saveButton).click();

    await expectTokenFieldError(window, "Couldn't save token");
    await expect(window.locator(SEL.errorBoundary.fallback)).not.toBeVisible();
  });

  test("saved state shows the token status and a Clear control", async () => {
    const { window } = ctx;
    await openGitHubSettings(window);

    // Seed an in-memory token and hydrate the renderer config store. The
    // settings tab reads the same store, so the saved status + Clear button
    // appear without any real token validation.
    await connectGitHub(ctx.app, window);

    await expect(window.locator(SEL.github.tokenSavedStatus)).toBeVisible({ timeout: T_MEDIUM });
    await expect(window.locator(SEL.github.noTokenStatus)).toHaveCount(0);
    const clearButton = window
      .locator(SEL.github.tokenBlock)
      .getByRole("button", { name: "Clear token" });
    await expect(clearButton).toBeVisible();

    // Clearing asks first; confirming removes the token and the status flips.
    await clearButton.click();
    const confirmClear = window
      .locator(SEL.confirmDialog.confirm)
      .filter({ hasText: "Clear token" });
    await expect(confirmClear).toBeVisible({ timeout: T_SHORT });
    await confirmClear.click();
    await expect(window.locator(SEL.github.noTokenStatus)).toBeVisible({ timeout: T_MEDIUM });
    await expect(window.locator(SEL.github.tokenSavedStatus)).toHaveCount(0);
    await expect(clearButton).toHaveCount(0);

    // Belt-and-braces: ensure no seeded token leaks into later specs.
    await clearGitHubToken(ctx.app);
    await refreshGitHubConfig(window);
  });
});
