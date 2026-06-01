import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM } from "../../helpers/timeouts";
import {
  injectToast,
  injectHistoryEntry,
  resetNotifications,
  getMaxVisibleToasts,
} from "../../helpers/notifications";

// E2E coverage for the toast surface (`src/components/ui/toaster.tsx`). Drives
// the notification store directly via the gated backdoor
// (`src/lib/e2eNotificationBackdoor.ts`) so each toast's type/duration/action is
// fully controlled — no priority routing or focus gating. Timing-dependent
// behavior (auto-dismiss, success dwell) uses short real durations + auto-
// retrying `expect`, never `page.clock` (which can't retro-control the booted
// renderer's already-registered timers).

let ctx: AppContext;

test.describe.serial("Panels: Notification toasts", () => {
  test.beforeAll(async () => {
    ctx = await launchApp();
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test.beforeEach(async () => {
    await resetNotifications(ctx.window);
  });

  test("toast region exposes the labelled live-region landmark", async () => {
    const { window } = ctx;
    await injectToast(window, { type: "info", message: "Region landmark check" });

    const region = window.locator(SEL.notifications.toastRegion);
    await expect(region).toBeVisible({ timeout: T_MEDIUM });
    await expect(region).toContainText("Region landmark check");
  });

  test("error toasts announce as alert, non-errors as status", async () => {
    const { window } = ctx;
    const region = window.locator(SEL.notifications.toastRegion);

    await injectToast(window, { type: "error", message: "Boom" });
    await expect(region.getByRole("alert")).toContainText("Boom", { timeout: T_MEDIUM });

    await resetNotifications(window);

    await injectToast(window, { type: "success", message: "All good" });
    await expect(region.getByRole("status")).toContainText("All good", { timeout: T_MEDIUM });
  });

  test("close button dismisses the toast", async () => {
    const { window } = ctx;
    await injectToast(window, { type: "info", message: "Dismiss me", duration: 0 });

    const region = window.locator(SEL.notifications.toastRegion);
    await expect(region).toContainText("Dismiss me", { timeout: T_MEDIUM });

    await window.locator(SEL.notifications.toastDismissButton).first().click();
    await expect(region.getByText("Dismiss me")).not.toBeVisible({ timeout: T_MEDIUM });
  });

  test("auto-dismisses after its duration elapses", async () => {
    const { window } = ctx;
    await injectToast(window, { type: "info", message: "Fades away", duration: 300 });

    const region = window.locator(SEL.notifications.toastRegion);
    await expect(region.getByText("Fades away")).toBeVisible({ timeout: T_SHORT });
    // Real-time auto-dismiss: the 300ms duration (×3 visible cap) elapses well
    // within T_MEDIUM. No clock mock — the timer runs against the native clock.
    await expect(region.getByText("Fades away")).not.toBeVisible({ timeout: T_MEDIUM });
  });

  test("hovering pauses the auto-dismiss timer", async () => {
    const { window } = ctx;
    await injectToast(window, { type: "info", message: "Sticky on hover", duration: 700 });

    const region = window.locator(SEL.notifications.toastRegion);
    const toast = region.getByText("Sticky on hover");
    await expect(toast).toBeVisible({ timeout: T_SHORT });

    // Park the cursor over the toast and confirm it outlives its 700ms duration.
    await toast.hover();
    await window.waitForTimeout(1500);
    await expect(toast).toBeVisible();

    // Move the cursor away — after the hover-grace window the timer resumes and
    // the (now overdue) toast dismisses.
    await window.mouse.move(5, 400);
    await expect(toast).not.toBeVisible({ timeout: T_MEDIUM });
  });

  test("coalesces same-correlation toasts behind a count badge", async () => {
    const { window } = ctx;
    await injectToast(window, {
      type: "info",
      message: "First event",
      correlationId: "coalesce-thread",
      duration: 0,
    });
    await injectToast(window, {
      type: "info",
      message: "Second event",
      correlationId: "coalesce-thread",
      duration: 0,
    });

    const region = window.locator(SEL.notifications.toastRegion);
    // Single merged toast showing the latest message and a count badge.
    await expect(region.getByText("Second event")).toBeVisible({ timeout: T_MEDIUM });
    const badge = window.locator(SEL.notifications.toastCoalesceBadge);
    await expect(badge).toBeVisible({ timeout: T_SHORT });
    await expect(badge).toContainText("2");
  });

  test("caps visible toasts and surfaces the overflow pill", async () => {
    const { window } = ctx;
    const max = await getMaxVisibleToasts(window);

    // Each toast is linked to a (read) history entry so eviction increments the
    // overflow counter that drives the pill.
    for (let i = 0; i < max + 1; i++) {
      const historyEntryId = await injectHistoryEntry(window, {
        type: "info",
        message: `Capped ${i}`,
        seenAsToast: true,
      });
      await injectToast(window, {
        type: "info",
        message: `Capped ${i}`,
        duration: 0,
        historyEntryId,
      });
    }

    const region = window.locator(SEL.notifications.toastRegion);
    await expect(region.getByRole("status")).toHaveCount(max, { timeout: T_MEDIUM });
    await expect(window.locator(SEL.notifications.toastOverflowPill)).toBeVisible({
      timeout: T_MEDIUM,
    });
  });

  test("async action button shows spinner then success confirmation", async () => {
    const { window } = ctx;
    await injectToast(window, {
      type: "info",
      message: "Pending op",
      duration: 0,
      actionLabel: "Retry",
      successLabel: "Retried",
      asyncAction: true,
      asyncDelayMs: 800,
    });

    const region = window.locator(SEL.notifications.toastRegion);
    await region.getByRole("button", { name: "Retry" }).click();

    // 150ms after click the in-flight spinner appears (visible for the ~800ms op).
    await expect(window.locator(SEL.notifications.toastActionSpinner)).toBeVisible({
      timeout: T_SHORT,
    });
    // On resolve, the success flash swaps in the checkmark + past-tense label.
    await expect(window.locator(SEL.notifications.toastActionCheckmark)).toBeVisible({
      timeout: T_MEDIUM,
    });
    await expect(region).toContainText("Retried");
  });

  test("restores focus to the prior element after keyboard-driven dismiss", async () => {
    const { window } = ctx;
    // Anchor focus on a stable toolbar control before the toast mounts — the
    // toast captures document.activeElement as its restore target on mount.
    const sidebarToggle = window.locator(SEL.toolbar.toggleSidebar);
    await sidebarToggle.focus();
    await expect(sidebarToggle).toBeFocused();

    await injectToast(window, { type: "info", message: "Focus return", duration: 0 });
    const dismiss = window.locator(SEL.notifications.toastDismissButton).first();
    await expect(dismiss).toBeVisible({ timeout: T_MEDIUM });

    // Move focus into the toast, then dismiss — focus must return to the anchor.
    await dismiss.focus();
    await dismiss.click();
    await expect(sidebarToggle).toBeFocused({ timeout: T_MEDIUM });
  });
});
