/**
 * Core: List Mount Perf Budget
 *
 * Mounts ReviewHub with 1000 unstaged files and asserts two count-based ceilings:
 * - DOM node count delta (before → after mount) ≤ MAX_DOM_DELTA
 * - Long-animation-frame occurrence count ≤ MAX_LONG_TASKS
 *
 * Count metrics are used deliberately over millisecond-based INP/LCP because
 * lab/CI shared-runner CPU variance makes timing thresholds unreliable.
 * These complement the existing static baselines (bundle-size,
 * compiler-bailout, eager-import) — they don't replace them.
 *
 * @see https://github.com/GoogleChrome/web-vitals/issues/180
 */

import { test, expect, type Locator } from "@playwright/test";
import { execSync } from "child_process";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../../helpers/timeouts";

interface E2EPerfWindow extends Window {
  __daintreeE2ePerfEntries?: Array<{ duration: number; startTime: number }>;
  __daintreeE2ePerfObserver?: PerformanceObserver;
  __daintreeE2eMountStart?: number;
}

const FILE_COUNT = 1000;
const MAX_DOM_DELTA = 25_000;
// Hosted macOS release runners consistently report more count entries than
// Linux for the same stable DOM delta. Keep this as a count gate, but calibrate
// by platform so runner scheduling noise does not fail otherwise healthy builds.
const MAX_LONG_TASKS = process.platform === "darwin" ? 25 : process.platform === "win32" ? 20 : 10;

// The 1000-row ReviewHub list mounts non-virtualized by design (this test
// measures its DOM-node and long-animation-frame budgets, not its render
// speed). On a release runner executing every E2E bucket at once, painting the
// full span can take well past T_LONG before the last row attaches — that slow
// paint timed out at T_LONG and masqueraded as a failure on both macOS and
// Linux. Give the full-list mount a generous ceiling (still well under the
// per-test coreTimeout) so only a genuinely stuck mount fails here.
const T_LIST_MOUNT = T_LONG * 3;

const clickReviewHubSetupButton = async (locator: Locator) => {
  await expect(locator).toBeVisible({ timeout: T_LONG });
  await expect(locator).toBeEnabled({ timeout: T_LONG });
  await locator.evaluate(
    (element) => {
      (element as HTMLElement).click();
    },
    undefined,
    { timeout: 120_000 }
  );
};

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;

const resetFixtureIndexToUnstaged = async () => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      execSync("git reset --mixed HEAD -- .", { cwd: fixtureDir, stdio: "pipe" });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to reset fixture index to unstaged state");
};

test.describe.serial("Core: List Mount Perf Budget", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({
      name: "perf-budget",
      unstagedFileCount: FILE_COUNT,
    });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Perf Budget Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("ReviewHub working-tree mode stays within node count and longtask budgets", async () => {
    const { window } = ctx;

    const lastFileName = `bulk-unstaged/file-${FILE_COUNT}.txt`;
    const midFileName = `bulk-unstaged/file-0500.txt`;

    // PR #7890 collapsed the file list by default and auto-stages all unstaged
    // files when the hub is launched from a worktree card. To preserve the
    // original "mount the unstaged list" measurement, we run a setup phase
    // (open hub, reset the git index, settle) BEFORE installing the observer or
    // snapshotting the baseline DOM. The actual measurement then times the
    // toggle-to-expanded path — this is the closest analogue to the pre-#7890
    // first-mount cost.
    await test.step("Open ReviewHub, unstage, and let the list settle", async () => {
      const reviewBtn = window.locator(SEL.worktree.reviewHubButton);
      await reviewBtn.first().click();

      const hub = window.locator(SEL.reviewHub.container);
      await expect(hub).toBeVisible({ timeout: T_LONG });
      await expect(hub.locator(SEL.reviewHub.cleanState)).not.toBeVisible({ timeout: T_SHORT });

      const fileListToggle = hub.locator(SEL.reviewHub.fileListToggle);
      await expect(fileListToggle).toBeVisible({ timeout: T_LONG });
      await expect(fileListToggle).toHaveAttribute("aria-expanded", "false", {
        timeout: T_MEDIUM,
      });

      await window.waitForTimeout(T_SETTLE);
      await resetFixtureIndexToUnstaged();

      // Ensure the measurement starts from a collapsed list.
      if ((await fileListToggle.getAttribute("aria-expanded")) === "true") {
        await clickReviewHubSetupButton(fileListToggle);
        await expect(fileListToggle).toHaveAttribute("aria-expanded", "false", {
          timeout: T_MEDIUM,
        });
      }
      await window.waitForTimeout(T_SETTLE);
    });

    let beforeNodeCount = 0;
    await test.step("Snapshot baseline DOM node count before mount", async () => {
      beforeNodeCount = await window.evaluate(() => document.getElementsByTagName("*").length);
    });

    let observerInstalled = false;
    await test.step("Install long-animation-frame PerformanceObserver and record mount start", async () => {
      // Install a PerformanceObserver for long-animation-frames before triggering
      // the mount. Do NOT use buffered: true — it captures startup noise.
      observerInstalled = await window.evaluate(() => {
        if (!("PerformanceObserver" in window)) return false;
        const supported = PerformanceObserver.supportedEntryTypes ?? [];
        if (!supported.includes("long-animation-frame")) return false;

        const win = window as unknown as E2EPerfWindow;
        win.__daintreeE2ePerfEntries = [];
        try {
          const obs = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              win.__daintreeE2ePerfEntries!.push(entry.toJSON());
            }
          });
          obs.observe({ type: "long-animation-frame", durationThreshold: 100 });
          win.__daintreeE2ePerfObserver = obs;
        } catch {
          return false;
        }
        return true;
      });

      // Record mount start time for entry filtering
      await window.evaluate(() => {
        (window as unknown as E2EPerfWindow).__daintreeE2eMountStart = performance.now();
      });
    });

    await test.step("Expand file list and verify list span renders end-to-end", async () => {
      const hub = window.locator(SEL.reviewHub.container);
      const fileListToggle = hub.locator(SEL.reviewHub.fileListToggle);

      await clickReviewHubSetupButton(fileListToggle);
      await expect(fileListToggle).toHaveAttribute("aria-expanded", "true", { timeout: T_MEDIUM });

      // Wait for both last and mid-range rows — confirms full list span
      const lastStageBtn = hub.locator(SEL.reviewHub.stageButton(lastFileName));
      const midStageBtn = hub.locator(SEL.reviewHub.stageButton(midFileName));
      await expect(lastStageBtn).toBeVisible({ timeout: T_LIST_MOUNT });
      await expect(midStageBtn).toBeVisible({ timeout: T_MEDIUM });

      // Allow a brief settle for final paints and observer callbacks
      await window.waitForTimeout(T_SETTLE);
    });

    let afterNodeCount = 0;
    let longTaskEntries: Array<{ duration: number; startTime: number }> = [];
    await test.step("Collect post-mount DOM count and long-animation-frame entries", async () => {
      afterNodeCount = await window.evaluate(() => document.getElementsByTagName("*").length);

      longTaskEntries = await window.evaluate(() => {
        const win = window as unknown as E2EPerfWindow;
        win.__daintreeE2ePerfObserver?.disconnect();
        const mountStart = win.__daintreeE2eMountStart ?? 0;
        const entries = (win.__daintreeE2ePerfEntries ?? []).filter(
          (e) => e.startTime >= mountStart
        );
        delete win.__daintreeE2ePerfObserver;
        delete win.__daintreeE2ePerfEntries;
        delete win.__daintreeE2eMountStart;
        return entries;
      });
    });

    await test.step("Assert DOM delta and long-animation-frame budgets", async () => {
      const domDelta = afterNodeCount - beforeNodeCount;
      console.log(
        `[perf-budget] DOM delta: ${domDelta} (before=${beforeNodeCount}, after=${afterNodeCount})`
      );
      expect(domDelta).toBeLessThanOrEqual(MAX_DOM_DELTA);

      if (observerInstalled) {
        const longTaskCount = longTaskEntries.length;
        console.log(`[perf-budget] Long-animation-frames: ${longTaskCount}`);
        expect(longTaskCount).toBeLessThanOrEqual(MAX_LONG_TASKS);
      } else {
        // Fail rather than skip — a release gate must not silently drop coverage
        throw new Error("long-animation-frame API must be supported for the perf budget gate");
      }
    });
  });
});
