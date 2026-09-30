import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";

function toolbarButton(page: AppContext["window"], name: string) {
  return page.getByRole("toolbar", { name: "Main toolbar" }).getByRole("button", {
    name,
    exact: true,
  });
}

// Right-side overflow trigger, only matched while it is actually surfacing
// hidden items (`data-visible="true"`). The default right group owns all the
// priority-5 buttons (settings, copy-tree, notification-center, problems), so
// it is the group that overflows first at narrow widths.
function rightOverflowTrigger(page: AppContext["window"]) {
  return page
    .getByRole("toolbar", { name: "Main toolbar" })
    .locator(
      '[data-toolbar-overflow-trigger][data-toolbar-overflow-side="right"][data-visible="true"]'
    );
}

// Wrapper div around a toolbar button. Overflowed items get aria-hidden="true";
// visible items omit the attribute.
function toolbarItemWrapper(page: AppContext["window"], id: string) {
  return page
    .getByRole("toolbar", { name: "Main toolbar" })
    .locator(`[data-toolbar-button-id="${id}"]`);
}

async function setWindowSize(app: AppContext["app"], width: number, height: number) {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) win.setSize(size.width, size.height);
    },
    { width, height }
  );
}

// Number of hidden items encoded in the right overflow trigger's accessible
// name ("More toolbar items — N hidden" / "… N problems hidden"). Returns null
// when the trigger isn't surfacing overflow, so callers can poll for it.
async function rightOverflowHiddenCount(page: AppContext["window"]): Promise<number | null> {
  const trigger = rightOverflowTrigger(page);
  if ((await trigger.count()) === 0) return null;
  const label = await trigger.first().getAttribute("aria-label");
  const match = label?.match(/—\s*(\d+)\s+(?:problems?\s+)?hidden/);
  return match ? Number(match[1]) : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const overflowMenuLabels: Record<string, string> = {
  "Open settings": "Settings",
  "Open terminal": "Terminal",
};

async function expectToolbarActionReachable(page: AppContext["window"], name: string) {
  const toolbar = page.getByRole("toolbar", { name: "Main toolbar" });
  const directButton = toolbar
    .getByRole("button", { name: new RegExp(`^${escapeRegExp(name)}\\b`, "i") })
    .first();
  const overflowLabel = overflowMenuLabels[name] ?? name;
  const menuItem = page.getByRole("menuitem", {
    name: new RegExp(`^${escapeRegExp(overflowLabel)}(?:\\s|$)`, "i"),
  });

  // Reachable means either a direct button or an item in one of the overflow
  // menus. The overflow button's accessible name no longer enumerates its
  // items (#8159), so open each visible one and look for the target item.
  await expect(async () => {
    if (await directButton.isVisible()) return;

    const overflowButtons = toolbar.getByRole("button", { name: /more/i });
    const count = await overflowButtons.count();
    for (let index = 0; index < count; index++) {
      const overflowButton = overflowButtons.nth(index);
      if (!(await overflowButton.isVisible())) continue;
      await overflowButton.click({ timeout: T_SHORT });
      const found = await expect(menuItem)
        .toBeVisible({ timeout: T_SHORT })
        .then(() => true)
        .catch(() => false);
      await page.keyboard.press("Escape");
      if (found) return;
    }
    throw new Error(`"${name}" is neither a visible toolbar button nor an overflow menu item`);
  }).toPass({ timeout: T_LONG });
}

/**
 * Record every change to the right overflow trigger's accessible name (which
 * carries the hidden count) until the returned stop function is called. A
 * poll-to-equal after each tick would miss a transient flip; this sees them.
 */
async function recordOverflowLabelChanges(
  page: AppContext["window"]
): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __overflowLabelLog?: string[];
      __overflowObserver?: MutationObserver;
    };
    const toolbar = document.querySelector('[role="toolbar"][aria-label="Main toolbar"]');
    if (!toolbar) throw new Error("Main toolbar missing");
    const read = () => {
      const trigger = toolbar.querySelector(
        '[data-toolbar-overflow-trigger][data-toolbar-overflow-side="right"]'
      );
      return trigger
        ? `${trigger.getAttribute("data-visible")}|${trigger.getAttribute("aria-label")}`
        : "absent";
    };
    const log: string[] = [];
    let last = read();
    const observer = new MutationObserver(() => {
      const next = read();
      if (next !== last) {
        log.push(`${last} -> ${next}`);
        last = next;
      }
    });
    observer.observe(toolbar, { subtree: true, childList: true, attributes: true });
    w.__overflowLabelLog = log;
    w.__overflowObserver = observer;
  });
  return () =>
    page.evaluate(() => {
      const w = window as unknown as {
        __overflowLabelLog?: string[];
        __overflowObserver?: MutationObserver;
      };
      w.__overflowObserver?.disconnect();
      return w.__overflowLabelLog ?? [];
    });
}

/**
 * Resolve once the renderer's viewport has moved by the same delta as the
 * window, and three more frames have run (ResizeObserver → rAF recalculate →
 * React commit).
 */
async function waitForRendererWidth(
  page: AppContext["window"],
  baseInnerWidth: number,
  deltaFromBase: number
) {
  await expect
    .poll(() => page.evaluate(() => window.innerWidth), { timeout: T_SHORT })
    .toBe(baseInnerWidth + deltaFromBase);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
      )
  );
}

test.describe.serial("Core: Toolbar Overflow", () => {
  let ctx: AppContext;
  let narrowHiddenCount: number | null = null;
  let fixtureCleanup: (() => void) | undefined;

  test.beforeAll(async () => {
    ctx = await launchApp();
    const { dir, cleanup } = createFixtureRepo({ name: "toolbar-overflow" });
    fixtureCleanup = cleanup;
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, dir, "Overflow Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("at 1920x1080 primary toolbar actions are reachable", async () => {
    const { window } = ctx;

    // At full size, project-scoped controls can still push lower-priority
    // actions into overflow on constrained CI displays; the contract is
    // reachability from the toolbar surface.
    await expectToolbarActionReachable(window, "Open settings");
    await expectToolbarActionReachable(window, "Open terminal");
    await expect(toolbarButton(window, "Toggle sidebar")).toBeVisible({ timeout: T_SHORT });
  });

  test("toolbar overflow triggers at narrow widths", async () => {
    const { window, app } = ctx;

    // Close sidebar to maximize toolbar space usage
    const aside = window.locator('aside[aria-label="Sidebar"]');
    const ariaHidden = await aside.getAttribute("aria-hidden");
    if (ariaHidden !== "true") {
      await toolbarButton(window, "Toggle sidebar").click();
      await expect(aside).toHaveAttribute("aria-hidden", "true", { timeout: T_SHORT });
    }

    // Shrink the window as small as Electron allows so the real ResizeObserver
    // → useToolbarOverflow pipeline pushes low-priority items into overflow.
    await setWindowSize(app, 400, 300);

    // The right overflow trigger surfaces only when items are actually hidden,
    // so polling it visible is the real end-to-end proof the resize drove the
    // production hook — no in-test re-implementation of the algorithm.
    const overflowTrigger = rightOverflowTrigger(window);
    await expect(overflowTrigger).toBeVisible({ timeout: T_MEDIUM });

    // Priority-5 buttons (copy-tree, settings) are first into overflow: their
    // wrapper is aria-hidden once evicted. The sidebar toggle is a priority-1
    // fixed control and must stay on the visible surface.
    await expect(toolbarItemWrapper(window, "copy-tree")).toHaveAttribute("aria-hidden", "true", {
      timeout: T_SHORT,
    });
    await expect(toolbarButton(window, "Toggle sidebar")).toBeVisible({ timeout: T_SHORT });

    // Opening the trigger must reveal the evicted priority-5 Settings item,
    // proving it routed into the real overflow dropdown.
    await overflowTrigger.first().click();
    const settingsItem = window.getByRole("menuitem", { name: /^Settings(?:\s|$)/i });
    await expect(settingsItem).toBeVisible({ timeout: T_SHORT });
    await window.keyboard.press("Escape");
  });

  test("overflow set is stable across 1px boundary jitter", async () => {
    // Regression for #8157. The guarded hook must not flip-flop when the
    // window — and therefore the toolbar container — oscillates by a pixel.
    // Driven through the real ResizeObserver → useToolbarOverflow → DOM path:
    // we settle on a narrow width that produces overflow, then jitter the
    // window ±1px and assert the hidden count (encoded in the trigger's
    // accessible name) never changes.
    const { window, app } = ctx;

    const overflowTrigger = rightOverflowTrigger(window);
    await expect(overflowTrigger).toBeVisible({ timeout: T_MEDIUM });

    // Anchor the baseline hidden count once the resize from the previous test
    // has settled.
    await expect
      .poll(() => rightOverflowHiddenCount(window), { timeout: T_MEDIUM })
      .toBeGreaterThan(0);
    const baseline = await rightOverflowHiddenCount(window);
    expect(baseline).toBeGreaterThan(0);

    const [baseWidth, baseHeight] = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return win ? win.getSize() : [0, 0];
    });

    // Oscillate around the settled width. Each tick lets the ResizeObserver
    // run and re-measure; the hysteresis guard must hold the same set, and
    // the recorder catches a flip that recovers before the next read.
    const baseInnerWidth = await window.evaluate(() => globalThis.innerWidth);
    const stopRecording = await recordOverflowLabelChanges(window);
    for (let i = 0; i < 8; i++) {
      const width = baseWidth + (i % 2 === 0 ? 1 : 0);
      await setWindowSize(app, width, baseHeight);
      await waitForRendererWidth(window, baseInnerWidth, width - baseWidth);
      expect(await rightOverflowHiddenCount(window)).toBe(baseline);
    }
    expect(await stopRecording()).toEqual([]);
    narrowHiddenCount = baseline;

    // Restore the anchor width so afterstate is deterministic.
    await setWindowSize(app, baseWidth, baseHeight);
  });

  test("restore full size and verify toolbar is complete", async () => {
    const { window, app } = ctx;

    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.setSize(1920, 1080);
        win.center();
      }
    });

    // The Toggle sidebar control is fixed and always present; poll it visible
    // so the restore reflow has actually landed before touching the sidebar.
    await expect(toolbarButton(window, "Toggle sidebar")).toBeVisible({ timeout: T_MEDIUM });

    // Re-open sidebar
    const sidebar = window.locator('aside[aria-label="Sidebar"]');
    if (!(await sidebar.isVisible())) {
      await toolbarButton(window, "Toggle sidebar").click();
      await expect(sidebar).toBeVisible({ timeout: T_SHORT });
    }

    // On constrained Linux/Xvfb displays the requested 1920px restore can
    // still leave lower-priority actions in the overflow menu once
    // project-scoped controls are present. The important regression check is
    // that the actions are restored to the toolbar surface and remain
    // reachable, either directly or through overflow.
    await expectToolbarActionReachable(window, "Open settings");
    await expectToolbarActionReachable(window, "Open terminal");

    // Reachability alone also passes through overflow, so prove the toolbar
    // actually re-expanded: fewer items hidden than at the narrow width.
    expect(narrowHiddenCount).toBeGreaterThan(0);
    await expect
      .poll(async () => (await rightOverflowHiddenCount(window)) ?? 0, { timeout: T_MEDIUM })
      .toBeLessThan(narrowHiddenCount!);
  });
});
