import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { ensureWindowFocused } from "../../helpers/focus";
import { getGridPanelIds, getDockPanelCount, openTerminal } from "../../helpers/panels";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_SETTLE } from "../../helpers/timeouts";

// Regression pin for #8161 — `dockPopoverGuard.ts` Guard 2 used to match the
// global Radix-internal `[data-radix-popper-content-wrapper]`. Any unrelated
// Radix overlay in the document blocked the dock popover from dismissing.
// The fix replaces that selector with a project-owned `[data-dock-popover-child]`
// attribute, stamped only on Radix content descended from the dock popover's
// React subtree (via `DockPopoverChildContext`).
//
// This spec asserts the contract end-to-end in the real Electron environment
// with the real Radix Popover wiring:
//   1. A click on a `[data-dock-popover-child]` ancestor does NOT dismiss the
//      dock popover (the original Guard 2 purpose, preserved).
//   2. A click on a bare `[data-radix-popper-content-wrapper]` (no project
//      attribute) DOES dismiss the dock popover (the bug that's now fixed).
//
// Unit tests in `dockPopoverGuard.test.ts` exercise the selector logic in
// isolation; this spec validates the integration with Radix Popover's
// `onInteractOutside` event flow.

async function dispatchAction(page: Page, actionId: string, args?: unknown): Promise<unknown> {
  return page.evaluate(
    ([id, a]) =>
      (
        window as unknown as {
          __daintreeDispatchAction: (id: string, a?: unknown) => unknown;
        }
      ).__daintreeDispatchAction(id, a),
    [actionId, args] as const
  );
}

test.describe.serial("Core: Dock popover dismissal guard", () => {
  let ctx: AppContext;
  let fixtureDir: string;
  let fixtureCleanup: (() => void) | undefined;

  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "dock-popover-dismissal" });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Dock Dismissal Test"
    );
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("scopes Guard 2 to project-owned data-dock-popover-child, not global Radix internals", async () => {
    const { window, app } = ctx;
    await ensureWindowFocused(app);

    // Two terminals: one stays in the grid so the project view doesn't tear
    // down when the other moves to the dock (see #4898).
    await openTerminal(window);
    await window.waitForTimeout(T_SETTLE);
    await openTerminal(window);
    await window.waitForTimeout(T_SETTLE);

    const gridIds = await getGridPanelIds(window);
    expect(gridIds.length).toBeGreaterThanOrEqual(2);

    const dockedId = gridIds[0]!;
    await dispatchAction(window, "terminal.moveToDock", { terminalId: dockedId });
    await expect.poll(() => getDockPanelCount(window), { timeout: T_MEDIUM }).toBe(1);

    const dockChip = window
      .locator(`${SEL.dock.container} [aria-label*="Click to preview"]`)
      .first();
    await expect(dockChip).toBeVisible({ timeout: T_MEDIUM });

    const portalTarget = window.locator(`[data-dock-portal-target="${dockedId}"]`);

    const openDockPopover = async () => {
      await ensureWindowFocused(app);
      if (!(await portalTarget.isVisible({ timeout: 1_000 }).catch(() => false))) {
        await dockChip.click();
      }
      await expect(portalTarget).toBeVisible({ timeout: T_MEDIUM });
    };

    await openDockPopover();
    await window.waitForTimeout(T_SETTLE);
    await expect(portalTarget).toBeVisible({ timeout: T_SHORT });

    // Contract 1: clicking on an element marked data-dock-popover-child must
    // NOT dismiss the dock popover. This is the original Guard 2 purpose
    // (preserved after the fix), now scoped to dock-owned descendants only.
    await window.evaluate(() => {
      const overlay = document.createElement("div");
      overlay.id = "test-dock-popover-child";
      overlay.setAttribute("data-dock-popover-child", "");
      Object.assign(overlay.style, {
        position: "fixed",
        top: "96px",
        right: "48px",
        width: "120px",
        height: "32px",
        background: "rgba(0,128,255,0.4)",
        pointerEvents: "auto",
        zIndex: "99999",
      });
      document.body.appendChild(overlay);
    });
    await expect(window.locator("#test-dock-popover-child")).toBeVisible({ timeout: T_SHORT });
    await window.locator("#test-dock-popover-child").click();
    await window.waitForTimeout(T_SETTLE);
    await expect(portalTarget).toBeVisible({ timeout: T_SHORT });
    await window.evaluate(() => document.getElementById("test-dock-popover-child")?.remove());

    // Contract 2: clicking on a bare Radix popper wrapper that is NOT a
    // dock-popover descendant must dismiss the dock popover. Before the fix,
    // Guard 2 matched this selector globally and incorrectly held the popover
    // open whenever any unrelated Radix overlay was nearby.
    await window.evaluate(() => {
      const overlay = document.createElement("div");
      overlay.id = "test-radix-popper";
      overlay.setAttribute("data-radix-popper-content-wrapper", "");
      Object.assign(overlay.style, {
        position: "fixed",
        top: "144px",
        right: "48px",
        width: "120px",
        height: "32px",
        background: "rgba(255,128,0,0.4)",
        pointerEvents: "auto",
        zIndex: "99999",
      });
      document.body.appendChild(overlay);
    });
    await expect(window.locator("#test-radix-popper")).toBeVisible({ timeout: T_SHORT });
    await window.locator("#test-radix-popper").click();
    await expect(portalTarget).not.toBeVisible({ timeout: T_MEDIUM });
    await window.evaluate(() => document.getElementById("test-radix-popper")?.remove());
  });
});
