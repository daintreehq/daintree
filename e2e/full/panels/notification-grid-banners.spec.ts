import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { ensureWindowFocused } from "../../helpers/focus";
import { openTerminal } from "../../helpers/panels";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM } from "../../helpers/timeouts";
import {
  injectGridNotification,
  backdateNotification,
  getGridBarDwellFloorMs,
  resetNotifications,
  setBackendStatus,
  setWatchdogStatus,
  setSafeMode,
  setRestoreConfirmation,
} from "../../helpers/notifications";

// E2E coverage for the single-slot grid-bar (`GridNotificationBar.tsx`) and the
// coordinator-arbitrated global recovery banners (`GlobalBannerCoordinator.tsx`).
// Both surfaces are driven by injecting renderer store state via the gated
// backdoor. The grid-bar requires a content grid (so a project + terminal is
// opened); the banner coordinator mounts at the app-layout level. Banner store
// state (backendStatus, safeMode, restoreConfirmation, watchdog) is set
// directly — none of these are driven by a live heartbeat once connected, so an
// injected value persists until the test resets it.

let ctx: AppContext;
let fixtureCleanup: (() => void) | undefined;

test.describe.serial("Panels: Grid-bar & global banners", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "notification-surfaces" });
    fixtureCleanup = cleanup;
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, dir, "Notification Surfaces");
    await ensureWindowFocused(ctx.app);
    // A grid panel is required for ContentGrid* (and thus GridNotificationBar) to mount.
    await openTerminal(ctx.window);
    await expect(ctx.window.locator(SEL.panel.gridPanel).first()).toBeVisible({
      timeout: T_MEDIUM,
    });
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test.beforeEach(async () => {
    await resetNotifications(ctx.window);
  });

  // ── Grid-bar ──────────────────────────────────────────────

  test.describe.serial("Grid-bar", () => {
    test("renders an injected grid-bar notification in its live region", async () => {
      const { window } = ctx;
      await injectGridNotification(window, {
        type: "info",
        title: "BUILD",
        message: "Building project",
      });

      const status = window.locator(SEL.notifications.gridBarStatus);
      await expect(status).toContainText("Building project", { timeout: T_MEDIUM });
    });

    test("holds the displayed notification through its dwell floor", async () => {
      const { window } = ctx;
      await injectGridNotification(window, { type: "info", message: "First grid event" });
      const status = window.locator(SEL.notifications.gridBarStatus);
      await expect(status).toContainText("First grid event", { timeout: T_MEDIUM });

      // A higher-severity newcomer arriving inside the dwell floor must NOT
      // preempt the in-read notification.
      await injectGridNotification(window, {
        type: "error",
        priority: "watch",
        message: "Second grid event",
      });
      await expect(status).toContainText("First grid event", { timeout: T_SHORT });
      await expect(status).not.toContainText("Second grid event");
    });

    test("a higher-severity notification preempts once the dwell floor expires", async () => {
      const { window } = ctx;
      const firstId = await injectGridNotification(window, {
        type: "info",
        message: "Stale grid event",
      });
      const status = window.locator(SEL.notifications.gridBarStatus);
      await expect(status).toContainText("Stale grid event", { timeout: T_MEDIUM });

      // Backdate past the dwell floor so the lock is already expired, then a
      // higher-severity newcomer can take the slot. Read the floor from the
      // store constant so the test tracks it if the value changes.
      const dwellFloorMs = await getGridBarDwellFloorMs(window);
      await backdateNotification(window, firstId, dwellFloorMs + 1_000);
      await injectGridNotification(window, {
        type: "error",
        priority: "watch",
        message: "Fresh grid event",
      });
      await expect(status).toContainText("Fresh grid event", { timeout: T_MEDIUM });
    });
  });

  // ── Global banner coordinator ─────────────────────────────

  test.describe.serial("Global banner coordinator", () => {
    test("safe-mode banner mounts and unmounts with store state", async () => {
      const { window } = ctx;
      await setSafeMode(window, true);
      await expect(window.getByText(/Safe mode/)).toBeVisible({ timeout: T_MEDIUM });

      await setSafeMode(window, true, true); // dismissed
      await expect(window.getByText(/Safe mode/)).not.toBeVisible({ timeout: T_MEDIUM });
    });

    test("restore-confirmation banner mounts when visible", async () => {
      const { window } = ctx;
      await setRestoreConfirmation(window, true);
      await expect(window.getByText(/Session recovered/)).toBeVisible({ timeout: T_MEDIUM });
    });

    test("renders only the highest-priority banner when several are active", async () => {
      const { window } = ctx;
      // Safe-mode outranks restore-confirmation: only safe-mode shows.
      await setSafeMode(window, true);
      await setRestoreConfirmation(window, true);
      await expect(window.getByText(/Safe mode/)).toBeVisible({ timeout: T_MEDIUM });
      await expect(window.getByText(/Session recovered/)).not.toBeVisible();

      // Clearing safe-mode hands the slot to the next-highest active banner.
      await setSafeMode(window, false);
      await expect(window.getByText(/Session recovered/)).toBeVisible({ timeout: T_MEDIUM });
      await expect(window.getByText(/Safe mode/)).not.toBeVisible();
    });

    test("watchdog-disabled outranks safe-mode", async () => {
      const { window } = ctx;
      await setSafeMode(window, true);
      await setWatchdogStatus(window, "disabled");
      await expect(window.getByText(/Crash watchdog disabled/)).toBeVisible({ timeout: T_MEDIUM });
      await expect(window.getByText(/Safe mode/)).not.toBeVisible();
    });

    test("host-crash banner appears on backend disconnect and clears on reconnect", async () => {
      const { window } = ctx;
      await setBackendStatus(window, "disconnected");
      const banner = window.getByRole("alert").filter({ hasText: /Terminal service/ });
      await expect(banner).toBeVisible({ timeout: T_MEDIUM });

      await setBackendStatus(window, "connected");
      await expect(banner).not.toBeVisible({ timeout: T_MEDIUM });
    });
  });
});
