import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { openTerminal } from "../../helpers/panels";
import { T_SHORT, T_MEDIUM, T_SETTLE } from "../../helpers/timeouts";

// #11691 — the toolbar renders the same launcher the dock does, differing only
// in trigger chrome and which side it anchors on. The unit suite mocks
// `@/components/ui/popover` and `@/components/ui/context-menu` wholesale, so the
// parts that only exist once real Radix is involved are unverifiable there:
//
//   1. Two overlay primitives share one trigger — `ContextMenuTrigger asChild`
//      wrapping `PopoverTrigger asChild` wrapping the button. Right click must
//      reach the context menu without opening the launcher, and left click must
//      open the launcher without opening the context menu.
//   2. The content anchors below the toolbar rather than above it, and the
//      toolbar sits under a `-webkit-app-region: drag` strip.
//   3. The trigger participates in the toolbar's roving tabindex, which reads
//      `[data-toolbar-item]` off the real DOM.
//   4. An `aria-disabled` row stays reachable and pinnable — the affordance the
//      issue explicitly refused to drop.
//
// The dock placement keeps its own spec (`core-dock-launcher-search`); this one
// only pins what the toolbar host adds.

const TOOLBAR_LAUNCHER = '[data-toolbar-button-id="launcher"] button';
const SEARCH_BOX = '[aria-label="Search agents, panels, and recipes"]';
const OPTION = '[role="option"]';

function searchBox(page: Page) {
  return page.locator(SEARCH_BOX);
}

async function openLauncher(page: Page) {
  await page.locator(TOOLBAR_LAUNCHER).click();
  await expect(searchBox(page)).toBeVisible({ timeout: T_MEDIUM });
}

async function closeLauncher(page: Page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (
      !(await searchBox(page)
        .isVisible({ timeout: 250 })
        .catch(() => false))
    )
      return;
    // Two presses: the first spends itself clearing a non-empty query.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(T_SETTLE);
  }
}

test.describe.serial("Core: Toolbar launcher (shared component)", () => {
  let ctx: AppContext;
  let fixtureCleanup: (() => void) | undefined;

  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "toolbar-launcher-shared" });
    fixtureCleanup = cleanup;
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, dir, "Toolbar Launcher Test");
    // Keep a panel in the grid throughout — emptying it tears the project view
    // down (#4898) and would take the toolbar's project scope with it.
    await openTerminal(ctx.window);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test.afterEach(async () => {
    await closeLauncher(ctx.window);
  });

  test("opens the shared palette from the toolbar and focuses the search box", async () => {
    await openLauncher(ctx.window);

    // Same chrome as the dock placement: this is one component, not two.
    await expect(ctx.window.locator(OPTION).first()).toBeVisible({ timeout: T_MEDIUM });
    const focused = await ctx.window.evaluate(
      (selector) => document.activeElement === document.querySelector(selector),
      SEARCH_BOX
    );
    expect(focused).toBe(true);
  });

  test("anchors below the toolbar rather than over it", async () => {
    await openLauncher(ctx.window);

    const trigger = await ctx.window.locator(TOOLBAR_LAUNCHER).boundingBox();
    const content = await ctx.window.locator(SEARCH_BOX).boundingBox();
    expect(trigger).not.toBeNull();
    expect(content).not.toBeNull();
    // The whole difference between the two placements. A popover that opened
    // upward here would be clipped by the window chrome above the toolbar.
    expect(content!.y).toBeGreaterThan(trigger!.y);
  });

  test("right click opens the toolbar context menu without opening the launcher", async () => {
    // Two Radix overlays share this trigger; the wrong one answering is the
    // failure mode nesting them introduces.
    //
    // The context-menu primitive is code-split and primes on pointer activity
    // over the trigger, so `ContextMenuTrigger` documents that a cold
    // right-click can miss until the chunk lands. Prime with a hover, then
    // retry the right-click rather than asserting on a single cold one — the
    // contract under test is which overlay answers, not how fast Radix loads.
    const launcher = ctx.window.locator(TOOLBAR_LAUNCHER);
    const menu = ctx.window.locator('[role="menu"]').first();
    await launcher.hover();
    await expect(async () => {
      await launcher.click({ button: "right" });
      await expect(menu).toBeVisible({ timeout: T_SHORT });
    }).toPass({ timeout: T_MEDIUM });

    await expect(searchBox(ctx.window)).toHaveCount(0);

    await ctx.window.keyboard.press("Escape");
    await ctx.window.waitForTimeout(T_SETTLE);
  });

  test("keeps the trigger in the toolbar's roving tabindex", async () => {
    // The toolbar's keyboard model sweeps `[data-toolbar-item]` off the real
    // DOM, so a trigger that forgot the attribute silently drops out of it.
    const isToolbarItem = await ctx.window.evaluate((selector) => {
      const button = document.querySelector(selector);
      return button?.hasAttribute("data-toolbar-item") ?? false;
    }, TOOLBAR_LAUNCHER);
    expect(isToolbarItem).toBe(true);
  });

  test("keeps an aria-disabled row reachable and pinnable", async () => {
    await openLauncher(ctx.window);
    await searchBox(ctx.window).fill("dev preview");

    const row = ctx.window.locator(`${OPTION}[aria-label^="Dev Preview,"]`).first();
    await expect(row).toBeVisible({ timeout: T_MEDIUM });

    // Whether it is gated depends on the fixture's project state; what must hold
    // either way is that the row is an option carrying its own pin control, so
    // the affordance stays reachable when it IS gated.
    await expect(row.locator("[data-launcher-pin]")).toHaveCount(1);
  });

  test("Escape clears a query before it closes the launcher", async () => {
    await openLauncher(ctx.window);
    await searchBox(ctx.window).fill("terminal");

    await ctx.window.keyboard.press("Escape");
    await expect(searchBox(ctx.window)).toBeVisible({ timeout: T_SHORT });
    await expect(searchBox(ctx.window)).toHaveValue("");

    await ctx.window.keyboard.press("Escape");
    await expect(searchBox(ctx.window)).toHaveCount(0);
  });
});
