import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM } from "../../helpers/timeouts";
import {
  injectHistoryEntry,
  archiveHistoryEntry,
  snoozeThread,
  resetNotifications,
} from "../../helpers/notifications";

// E2E coverage for the notification center inbox (`NotificationCenter.tsx`),
// opened from the toolbar bell. Entries are seeded via the gated history-store
// backdoor. Per lesson #6289 (Radix FocusScope contamination across serial
// tests), every test closes the popover and waits for its list to unmount
// before the next one runs. Entries are seeded as "info" so they never land in
// the severity-pinned "Needs attention" rail, keeping row counts deterministic.

let ctx: AppContext;

async function openCenter(window: Page): Promise<void> {
  const bell = window.locator(SEL.notifications.bellButton);
  await expect(bell).toBeVisible({ timeout: T_MEDIUM });
  if ((await bell.getAttribute("aria-expanded")) !== "true") {
    await bell.click();
  }
  await expect(bell).toHaveAttribute("aria-expanded", "true", { timeout: T_SHORT });
}

async function closeCenter(window: Page): Promise<void> {
  const bell = window.locator(SEL.notifications.bellButton);
  if ((await bell.getAttribute("aria-expanded")) === "true") {
    await window.keyboard.press("Escape");
    await expect(bell).toHaveAttribute("aria-expanded", "false", { timeout: T_SHORT });
  }
  // Wait for the Radix popover portal to unmount so its FocusScope doesn't
  // swallow keys in the next serial test (#6289).
  await expect(window.locator(SEL.notifications.centerList)).toHaveCount(0, { timeout: T_SHORT });
}

test.describe.serial("Panels: Notification center", () => {
  test.beforeAll(async () => {
    ctx = await launchApp();
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test.beforeEach(async () => {
    await resetNotifications(ctx.window);
  });

  test.afterEach(async () => {
    await closeCenter(ctx.window);
  });

  test("All filter lists seeded entries", async () => {
    const { window } = ctx;
    await injectHistoryEntry(window, { type: "info", message: "Entry one" });
    await injectHistoryEntry(window, { type: "info", message: "Entry two" });

    await openCenter(window);
    const rows = window.locator(SEL.notifications.centerList).locator(SEL.notifications.centerRow);
    await expect(rows).toHaveCount(2, { timeout: T_MEDIUM });
  });

  test("Unread filter shows only unread entries", async () => {
    const { window } = ctx;
    await injectHistoryEntry(window, { type: "info", message: "Already read", seenAsToast: true });
    await injectHistoryEntry(window, { type: "info", message: "Still unread", seenAsToast: false });

    await openCenter(window);
    await window.locator(SEL.notifications.centerFilter("Unread")).click();

    const list = window.locator(SEL.notifications.centerList);
    await expect(list.locator(SEL.notifications.centerRow)).toHaveCount(1, { timeout: T_MEDIUM });
    await expect(list).toContainText("Still unread");
    await expect(list).not.toContainText("Already read");
  });

  test("archived entries leave All and appear under Archived", async () => {
    const { window } = ctx;
    await injectHistoryEntry(window, { type: "info", message: "Stays active" });
    const archivedId = await injectHistoryEntry(window, {
      type: "info",
      message: "Gets archived",
    });
    await archiveHistoryEntry(window, archivedId);

    await openCenter(window);
    const list = window.locator(SEL.notifications.centerList);
    await expect(list).toContainText("Stays active", { timeout: T_MEDIUM });
    await expect(list).not.toContainText("Gets archived");

    await window.locator(SEL.notifications.centerFilter("Archived")).click();
    await expect(list).toContainText("Gets archived", { timeout: T_MEDIUM });
    await expect(list).not.toContainText("Stays active");
  });

  test("snoozed threads move to the Snoozed tab and out of All", async () => {
    const { window } = ctx;
    await injectHistoryEntry(window, {
      type: "info",
      message: "Snoozed item",
      correlationId: "snooze-thread",
    });
    await snoozeThread(window, "snooze-thread", 60 * 60 * 1000);

    await openCenter(window);
    const list = window.locator(SEL.notifications.centerList);
    // Hidden from All while snoozed.
    await expect(list).not.toContainText("Snoozed item");

    await window.locator(SEL.notifications.centerFilter("Snoozed")).click();
    await expect(list).toContainText("Snoozed item", { timeout: T_MEDIUM });
  });

  test("Mark all read clears the unread state", async () => {
    const { window } = ctx;
    await injectHistoryEntry(window, { type: "info", message: "Unread A", seenAsToast: false });
    await injectHistoryEntry(window, { type: "info", message: "Unread B", seenAsToast: false });

    await openCenter(window);
    const markAllRead = window.locator(SEL.notifications.markAllReadButton);
    await expect(markAllRead).toBeVisible({ timeout: T_MEDIUM });
    await markAllRead.click();

    // With nothing unread, the Mark all read affordance disappears.
    await expect(markAllRead).not.toBeVisible({ timeout: T_MEDIUM });
  });
});
