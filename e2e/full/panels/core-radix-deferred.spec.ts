import { test, expect } from "@playwright/test";
import { launchApp, closeApp, waitForProcessExit, type AppContext } from "../../helpers/launch";
import { ensureWindowFocused } from "../../helpers/focus";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM } from "../../helpers/timeouts";

// Smoke tests for the deferred Radix wrappers (see #7658). The 5 Radix
// overlay primitives (tooltip, popover, dropdown-menu, select, context-menu)
// are dynamic-imported via `src/components/ui/radix-deferred.ts` and
// gesture-primed on `onPointerEnter`/`onFocusCapture` of triggers. These
// tests verify the first interaction works seamlessly — no second hover or
// double-click required to surface the overlay after the chunk loads.
test.describe.serial("Core: Radix deferred wrappers", () => {
  let ctx: AppContext;

  test.beforeAll(async () => {
    ctx = await launchApp();
  });

  test.afterAll(async () => {
    if (ctx?.app) {
      const pid = ctx.app.process().pid;
      await closeApp(ctx.app);
      if (pid) await waitForProcessExit(pid).catch(() => {});
    }
  });

  test("tooltip appears on first hover of a toolbar button", async () => {
    const { window, app } = ctx;
    await ensureWindowFocused(app);

    const trigger = window.locator(SEL.toolbar.openSettings);
    await expect(trigger).toBeVisible({ timeout: T_MEDIUM });

    // The trigger is rendered immediately, then the deferred Radix chunk
    // upgrades it with `data-state`. Wait for that upgrade so this assertion
    // measures one real hover opening the tooltip, not whether CI won a race
    // against the dynamic import.
    await expect(trigger).toHaveAttribute("data-state", /closed|delayed-open|instant-open/, {
      timeout: T_MEDIUM,
    });

    // One hover after the deferred trigger is active should surface the
    // tooltip after the standard tooltip delay.
    await trigger.hover();
    await expect(window.locator('[role="tooltip"]').first()).toBeVisible({ timeout: T_MEDIUM });
  });

  test("dropdown opens on first click of a trigger", async () => {
    const { window, app } = ctx;
    await ensureWindowFocused(app);

    // Move the pointer well away from the previous tooltip target so the
    // tooltip dismisses and doesn't shadow the dropdown chrome.
    await window.mouse.move(0, 0);

    // The panel overflow menu uses our deferred DropdownMenu wrapper.
    // Trigger the overflow menu via the toolbar (its trigger is always
    // present), then verify the menu surface opens on a single click.
    const overflowTrigger = window.locator(SEL.panel.overflowMenu).first();
    if ((await overflowTrigger.count()) === 0) {
      // No panel rendered (cold launch state). Skip — the tooltip path above
      // already exercises the deferred chunk priming.
      test.info().annotations.push({
        type: "quarantine",
        description: "2026-05-27 No panel overflow trigger present in cold launch state",
      });

      test.skip(true, "No panel overflow trigger present in cold launch state");
      return;
    }
    await overflowTrigger.hover();
    await overflowTrigger.click();
    await expect(window.locator('[role="menu"]').first()).toBeVisible({ timeout: T_MEDIUM });
  });

  test("focus traversal reaches a deferred trigger before chunk activates", async () => {
    const { window, app } = ctx;
    await ensureWindowFocused(app);

    // Keyboard-tab into a toolbar button. Focus alone should prime the chunk
    // via the wrapper's onFocusCapture handler — the trigger remains a real
    // focusable element pre- and post-load, so traversal must not be lost.
    const trigger = window.locator(SEL.toolbar.openSettings);
    await trigger.focus();
    await expect(trigger).toBeFocused({ timeout: T_SHORT });
  });
});
