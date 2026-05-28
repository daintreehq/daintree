import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { SEL } from "../../helpers/selectors";
import { T_MEDIUM, T_SHORT } from "../../helpers/timeouts";

let ctx: AppContext;

test.describe.serial("Core: Diagnostics Dock — auto-open preserves focus", () => {
  test.beforeAll(async () => {
    ctx = await launchApp();
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("auto-promotion to Problems tab does not steal terminal focus", async () => {
    const { window } = ctx;

    const textarea = window.locator(SEL.terminal.xtermHelperTextarea);
    await expect(textarea.first()).toBeVisible({ timeout: T_MEDIUM });

    await textarea.first().focus();
    await expect(textarea.first()).toBeFocused({ timeout: T_SHORT });

    await window.evaluate(() => {
      window.__DAINTREE_E2E_ADD_ERROR__?.("E2E focus preservation test error");
    });

    const dock = window.locator(SEL.diagnostics.dock);
    await expect(dock).toBeVisible({ timeout: T_MEDIUM });

    const problemsTab = window.locator(SEL.diagnostics.tab("problems"));
    await expect(problemsTab).toHaveAttribute("aria-selected", "true", {
      timeout: T_SHORT,
    });

    await expect(textarea.first()).toBeFocused({ timeout: T_SHORT });

    await window.evaluate(() => {
      window.__DAINTREE_E2E_CLEAR_ERRORS__?.();
    });

    await window.locator(SEL.diagnostics.closeButton).click();
    await expect(dock).not.toBeVisible({ timeout: T_SHORT });
  });
});
