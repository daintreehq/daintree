import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { ensureWindowFocused } from "../../helpers/focus";
import { getGridPanelIds, getDockPanelIds, openTerminal } from "../../helpers/panels";
import { T_SHORT, T_MEDIUM, T_SETTLE } from "../../helpers/timeouts";

// #11521 — the dock `+` launcher gained a search field and a complete panel
// list. The unit suite mocks `@/components/ui/dropdown-menu` wholesale, so the
// parts that only exist in real Radix are unverifiable there:
//
//   1. `onOpenAutoFocus` must hand focus to the search box, not the first item.
//   2. Radix menu items focus themselves on pointer move — the launcher
//      preventDefaults that, or hovering a row while typing kills the input.
//   3. Escape is caught by DismissibleLayer at the *document* level with
//      capture, so "first Escape clears, second closes" needs the content's
//      `onEscapeKeyDown` veto, not a bubble-phase stopPropagation.
//   4. Radix's typeahead steals printable keys unless the input stops them.
//
// This spec pins all four against the real wiring, plus the honesty contract
// that a grid-only kind launched from the launcher actually lands in the grid.

const LAUNCH_BUTTON = '[aria-label="Open launcher"]';
const SEARCH_BOX = '[role="searchbox"]';

function searchBox(page: Page) {
  return page.locator(SEARCH_BOX);
}

async function openLauncher(page: Page) {
  await page.locator(LAUNCH_BUTTON).click();
  await expect(searchBox(page)).toBeVisible({ timeout: T_MEDIUM });
}

/** True while the search box holds real DOM focus. */
async function searchBoxHasFocus(page: Page): Promise<boolean> {
  return page.evaluate(
    (selector) => document.activeElement === document.querySelector(selector),
    SEARCH_BOX
  );
}

test.describe.serial("Core: Dock launcher search", () => {
  let ctx: AppContext;
  let fixtureCleanup: (() => void) | undefined;

  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "dock-launcher-search" });
    fixtureCleanup = cleanup;
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, dir, "Dock Launcher Test");
    // Keep a panel in the grid throughout — emptying it tears the project view
    // down (#4898) and would take the dock with it.
    await openTerminal(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("hands focus to the search box instead of the first menu item", async () => {
    const { window, app } = ctx;
    await ensureWindowFocused(app);

    await openLauncher(window);
    // Radix's default onOpenAutoFocus focuses the first item; the rAF-deferred
    // override must win that race.
    await expect.poll(() => searchBoxHasFocus(window), { timeout: T_MEDIUM }).toBe(true);

    await window.keyboard.press("Escape");
    await expect(searchBox(window)).not.toBeVisible({ timeout: T_MEDIUM });
  });

  test("keeps focus in the input while the pointer crosses result rows", async () => {
    const { window, app } = ctx;
    await ensureWindowFocused(app);
    await openLauncher(window);

    await searchBox(window).fill("e");
    const rows = window.locator("[data-selected-row]");
    await expect.poll(() => rows.count(), { timeout: T_MEDIUM }).toBeGreaterThan(1);

    // Radix's own pointer-move handler would call .focus() on the row here.
    await rows.nth(1).hover();
    await window.waitForTimeout(T_SETTLE);
    expect(await searchBoxHasFocus(window)).toBe(true);

    // The hovered row becomes the selection, and only that one.
    await expect(window.locator("[data-selected-row='true']")).toHaveCount(1);

    // Typing still reaches the input rather than Radix's typeahead.
    await window.keyboard.type("vi");
    await expect(searchBox(window)).toHaveValue("evi");

    await window.keyboard.press("Escape");
    await window.keyboard.press("Escape");
    await expect(searchBox(window)).not.toBeVisible({ timeout: T_MEDIUM });
  });

  test("first Escape clears the query, second closes the menu", async () => {
    const { window, app } = ctx;
    await ensureWindowFocused(app);
    await openLauncher(window);

    await searchBox(window).fill("review");
    await expect(searchBox(window)).toHaveValue("review");

    // The document-level dismiss layer must be vetoed by onEscapeKeyDown here.
    await window.keyboard.press("Escape");
    await expect(searchBox(window)).toBeVisible({ timeout: T_SHORT });
    await expect(searchBox(window)).toHaveValue("");

    await window.keyboard.press("Escape");
    await expect(searchBox(window)).not.toBeVisible({ timeout: T_MEDIUM });
  });

  test("Enter launches a searched grid-only panel into the grid", async () => {
    const { window, app } = ctx;
    await ensureWindowFocused(app);

    const gridBefore = (await getGridPanelIds(window)).length;
    const dockBefore = (await getDockPanelIds(window)).length;

    await openLauncher(window);
    await searchBox(window).fill("review");
    // Typing and confirming in quick succession must rank against the query the
    // user actually typed, not the previous one.
    await window.keyboard.press("Enter");

    await expect(searchBox(window)).not.toBeVisible({ timeout: T_MEDIUM });

    // Review opts out of the dock, and the launcher says so ("Open in grid") —
    // so it must land in the grid, never silently redirected from a dock claim.
    await expect
      .poll(() => getGridPanelIds(window).then((ids) => ids.length), { timeout: T_MEDIUM })
      .toBe(gridBefore + 1);
    expect((await getDockPanelIds(window)).length).toBe(dockBefore);
  });

  test("Enter launches a searched dockable panel into the dock", async () => {
    const { window, app } = ctx;
    await ensureWindowFocused(app);

    const dockBefore = (await getDockPanelIds(window)).length;

    await openLauncher(window);
    await searchBox(window).fill("file viewer");
    await window.keyboard.press("Enter");

    await expect(searchBox(window)).not.toBeVisible({ timeout: T_MEDIUM });

    // File Viewer is dockable and listed under "Open in dock".
    await expect
      .poll(() => getDockPanelIds(window).then((ids) => ids.length), { timeout: T_MEDIUM })
      .toBe(dockBefore + 1);
  });
});
