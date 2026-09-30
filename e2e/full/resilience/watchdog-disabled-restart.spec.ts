import { test, expect } from "@playwright/test";
import {
  launchApp,
  closeApp,
  openSecondWindow,
  getWindowPage,
  type AppContext,
} from "../../helpers/launch";
import { createFixtureRepos } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_LONG, T_SHORT } from "../../helpers/timeouts";

// Exercises the watchdog cap-hit → disabled-banner → manual-restart → re-arm
// cycle. The real path requires three genuine watchdog-host crashes inside the
// rapid-crash window; the fault-mode hook `__daintreeSimulateWatchdogDisabled`
// fires the same `notifyDisabled()` → `watchdog:disabled` broadcast instead.
// The banner (`WatchdogDisabledBanner`, role="status") then drives the real
// `watchdog.restart` action, which broadcasts `watchdog:active` and resets the
// once-per-cycle `disabledNotified` guard so a second cap-hit can re-fire.
// The signal is app-wide: it reaches every window through the EVENTS_PUSH
// fan-out, so a second window must show the banner too.

let ctx: AppContext;
let fixtureCleanups: Array<() => void> = [];
let secondRepoDir = "";

async function simulateWatchdogDisabled(app: AppContext["app"]): Promise<void> {
  await app.evaluate(() => {
    const g = globalThis as Record<string, unknown>;
    const fn = g.__daintreeSimulateWatchdogDisabled as (() => void) | undefined;
    if (!fn) throw new Error("__daintreeSimulateWatchdogDisabled not present");
    fn();
  });
}

test.describe.serial("Resilience: watchdog disabled banner + restart", () => {
  test.beforeAll(async () => {
    test.setTimeout(180_000);
    const [repo, secondRepo] = createFixtureRepos(2);
    fixtureCleanups = [repo.cleanup, secondRepo.cleanup];
    secondRepoDir = secondRepo.dir;
    ctx = await launchApp({ env: { DAINTREE_E2E_FAULT_MODE: "1" } });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, repo.dir, "watchdog-project");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    for (const cleanup of fixtureCleanups) cleanup();
  });

  test("disabled signal surfaces the banner, restart clears it, and a second signal re-fires", async () => {
    const banner = ctx.window.locator(SEL.recovery.watchdogDisabledBanner);

    // 1. Synthetic cap-hit → banner appears (IPC push + render).
    await simulateWatchdogDisabled(ctx.app);
    await expect(banner).toBeVisible({ timeout: T_LONG });

    // 2. Restart via the banner's own action. This dispatches `watchdog.restart`
    //    (re-wires the broadcast, calls client.restart(), broadcasts
    //    `watchdog:active`) so the banner clears.
    await ctx.window.locator(SEL.recovery.watchdogRestartButton).click();
    await expect(banner).toBeHidden({ timeout: T_LONG });

    // 3. A second synthetic cap-hit must re-fire — proving restart() reset the
    //    once-per-cycle `disabledNotified` guard. Without the reset the
    //    notifyDisabled() short-circuit would swallow this and the banner would
    //    never reappear.
    await simulateWatchdogDisabled(ctx.app);
    await expect(banner).toBeVisible({ timeout: T_LONG });
  });

  test("the disabled banner exposes exactly one recovery action", async () => {
    // Self-contained: re-arm the banner so this test passes in isolation too.
    await simulateWatchdogDisabled(ctx.app);
    const banner = ctx.window.locator(SEL.recovery.watchdogDisabledBanner);
    await expect(banner).toBeVisible({ timeout: T_LONG });

    // One contextual action plus the session dismiss, nothing else.
    await expect(banner.locator(SEL.recovery.watchdogRestartButton)).toHaveCount(1, {
      timeout: T_SHORT,
    });
    await expect(banner.locator('button[aria-label="Dismiss watchdog warning"]')).toHaveCount(1, {
      timeout: T_SHORT,
    });
    await expect(banner.locator("button")).toHaveCount(2, { timeout: T_SHORT });
    await expect(ctx.window.locator(SEL.recovery.watchdogRestartButton)).toBeVisible({
      timeout: T_SHORT,
    });
  });

  test("disabled signal is broadcast to every window", async () => {
    const bannerA = ctx.window.locator(SEL.recovery.watchdogDisabledBanner);

    // Arm (a no-op if the previous test left it armed), then restart to clear
    // the banner and reset the once-per-cycle guard, so the signal below is a
    // fresh cap-hit.
    await simulateWatchdogDisabled(ctx.app);
    await expect(bannerA).toBeVisible({ timeout: T_LONG });
    await ctx.window.locator(SEL.recovery.watchdogRestartButton).click();
    await expect(bannerA).toBeHidden({ timeout: T_LONG });

    const handle = await openSecondWindow(ctx.app, ctx.window, { projectPath: secondRepoDir });
    const pageB = await getWindowPage(ctx.app, handle.windowId);
    await expect(pageB.getByRole("toolbar", { name: "Main toolbar" })).toBeVisible({
      timeout: T_LONG,
    });
    const bannerB = pageB.locator(SEL.recovery.watchdogDisabledBanner);
    await expect(bannerB).toBeHidden({ timeout: T_SHORT });

    await simulateWatchdogDisabled(ctx.app);

    await expect(bannerA).toBeVisible({ timeout: T_LONG });
    await expect(bannerB).toBeVisible({ timeout: T_LONG });
  });
});
