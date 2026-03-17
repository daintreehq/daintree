import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM } from "../helpers/timeouts";

const mod = process.platform === "darwin" ? "Meta" : "Control";

let ctx: AppContext;

test.describe.serial("Core: Diagnostics & Notifications", () => {
  test.beforeAll(async () => {
    ctx = await launchApp();
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  // ── Diagnostics Dock ──────────────────────────────────────

  test.describe.serial("Diagnostics Dock", () => {
    test("opens via keyboard shortcut with Problems tab active", async () => {
      const { window } = ctx;

      await window.keyboard.press(`${mod}+Shift+D`);

      const dock = window.locator(SEL.diagnostics.dock);
      await expect(dock).toBeVisible({ timeout: T_MEDIUM });

      const problemsTab = window.locator(SEL.diagnostics.tab("problems"));
      await expect(problemsTab).toHaveAttribute("aria-selected", "true", {
        timeout: T_SHORT,
      });
    });

    test("switches between tabs", async () => {
      const { window } = ctx;

      const logsTab = window.locator(SEL.diagnostics.tab("logs"));
      await logsTab.click();
      await expect(logsTab).toHaveAttribute("aria-selected", "true", {
        timeout: T_SHORT,
      });
      await expect(window.locator(SEL.diagnostics.tab("problems"))).toHaveAttribute(
        "aria-selected",
        "false"
      );

      const logsPanel = window.locator(SEL.diagnostics.panel("logs"));
      await expect(logsPanel).toBeVisible({ timeout: T_SHORT });

      const eventsTab = window.locator(SEL.diagnostics.tab("events"));
      await eventsTab.click();
      await expect(eventsTab).toHaveAttribute("aria-selected", "true", {
        timeout: T_SHORT,
      });
      await expect(logsTab).toHaveAttribute("aria-selected", "false");

      const eventsPanel = window.locator(SEL.diagnostics.panel("events"));
      await expect(eventsPanel).toBeVisible({ timeout: T_SHORT });
    });

    test("resizes via keyboard", async () => {
      const { window } = ctx;

      const handle = window.locator(SEL.diagnostics.resizeHandle);
      await handle.focus();

      const before = Number(await handle.getAttribute("aria-valuenow"));
      expect(before).toBeGreaterThan(0);

      await window.keyboard.press("ArrowUp");

      await expect
        .poll(async () => Number(await handle.getAttribute("aria-valuenow")), { timeout: T_SHORT })
        .toBeGreaterThan(before);
    });

    test("closes via close button", async () => {
      const { window } = ctx;

      await window.locator(SEL.diagnostics.closeButton).click();
      await expect(window.locator(SEL.diagnostics.dock)).not.toBeVisible({
        timeout: T_SHORT,
      });
    });

    test("reopens via toggle shortcut", async () => {
      const { window } = ctx;

      await window.keyboard.press(`${mod}+Shift+D`);

      await expect(window.locator(SEL.diagnostics.dock)).toBeVisible({
        timeout: T_MEDIUM,
      });

      // Clean up: close dock for subsequent tests
      await window.locator(SEL.diagnostics.closeButton).click();
      await expect(window.locator(SEL.diagnostics.dock)).not.toBeVisible({
        timeout: T_SHORT,
      });
    });
  });

  // ── Notification Center ───────────────────────────────────

  test.describe.serial("Notification Center", () => {
    test("bell button opens popover with empty state", async () => {
      const { window } = ctx;

      const bell = window.locator(SEL.notifications.bellButton);
      await expect(bell).toBeVisible({ timeout: T_MEDIUM });
      await bell.click();

      await expect(bell).toHaveAttribute("aria-expanded", "true", {
        timeout: T_SHORT,
      });
      await expect(window.locator(SEL.notifications.emptyState)).toBeVisible({
        timeout: T_MEDIUM,
      });
    });

    test("empty state shows Configure but not Clear all", async () => {
      const { window } = ctx;

      await expect(window.locator(SEL.notifications.configureButton)).toBeVisible({
        timeout: T_SHORT,
      });
      await expect(window.locator(SEL.notifications.clearAllButton)).not.toBeVisible();
    });

    test("closes via Escape", async () => {
      const { window } = ctx;

      await window.keyboard.press("Escape");

      await expect(window.locator(SEL.notifications.bellButton)).toHaveAttribute(
        "aria-expanded",
        "false",
        { timeout: T_SHORT }
      );
      await expect(window.locator(SEL.notifications.emptyState)).not.toBeVisible({
        timeout: T_SHORT,
      });
    });

    test("closes via outside click", async () => {
      const { window } = ctx;

      // Reopen
      await window.locator(SEL.notifications.bellButton).click();
      await expect(window.locator(SEL.notifications.emptyState)).toBeVisible({
        timeout: T_MEDIUM,
      });

      // Click outside the popover (on the sidebar toggle)
      await window.locator(SEL.toolbar.toggleSidebar).click({ force: true });

      await expect(window.locator(SEL.notifications.emptyState)).not.toBeVisible({
        timeout: T_SHORT,
      });
    });
  });
});
