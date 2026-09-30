import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { ensureWindowFocused } from "../../helpers/focus";
import {
  getGridPanelCount,
  getGridPanelIds,
  getDockPanelIds,
  openTerminal,
} from "../../helpers/panels";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../../helpers/timeouts";

// #11521 / #11593 / #11691 — the launcher is a Radix `Popover` hosting the
// standard palette chrome, rendered from two hosts: the dock `+` button and
// the toolbar. The unit suite mocks `@/components/ui/popover` and
// `@/components/ui/context-menu` wholesale, so the parts that only exist in
// real Radix are unverifiable there:
//
//   1. `onOpenAutoFocus` must hand focus to the search box, not the content
//      wrapper — and it must win on a cold open, where `PopoverContent` renders
//      nothing until its lazy Radix chunk resolves.
//   2. Hovering a row must not move DOM focus off the input, in either the
//      browse list or the filtered results.
//   3. Escape is caught by DismissibleLayer at the *document* level with
//      capture, so "first Escape clears, second closes" needs the content's
//      `onEscapeKeyDown` veto, not a bubble-phase stopPropagation.
//   4. The popover is modal, so Tab stays inside it rather than escaping to the
//      dock behind.
//   5. On the toolbar, two overlay primitives share one trigger
//      (`ContextMenuTrigger asChild` wrapping `PopoverTrigger asChild`), the
//      content anchors below the toolbar, and the trigger joins the toolbar's
//      roving tabindex via `[data-toolbar-item]`.
//
// Plus the honesty contract that a grid-only kind launched from the launcher
// actually lands in the grid.

const DOCK_LAUNCHER = '[aria-label="Open launcher"]';
const TOOLBAR_LAUNCHER = '[data-toolbar-button-id="launcher"] button';
// The accessible name, not `[role="combobox"]` — other surfaces use that role.
const SEARCH_BOX = '[aria-label="Search agents, panels, and recipes"]';
// Scoped to the launcher's popover content: other panels (a File Viewer's
// result list, for one) also render `role="option"` rows.
const LAUNCHER_CONTENT = `[data-radix-popper-content-wrapper]:has(${SEARCH_BOX})`;
const OPTION = `${LAUNCHER_CONTENT} [role="option"]`;
const SELECTED_OPTION = `${LAUNCHER_CONTENT} [role="option"][aria-selected="true"]`;
// Negative focus checks sample every frame for this long.
const DWELL_MS = T_SETTLE;

function searchBox(page: Page) {
  return page.locator(SEARCH_BOX);
}

async function openLauncher(page: Page, trigger = DOCK_LAUNCHER) {
  await page.locator(trigger).click();
  await expect(searchBox(page)).toBeVisible({ timeout: T_MEDIUM });
}

async function closeLauncher(page: Page) {
  await expect(async () => {
    if ((await searchBox(page).count()) > 0) {
      // Two presses: the first spends itself clearing a non-empty query.
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
    }
    await expect(searchBox(page)).toHaveCount(0, { timeout: T_SHORT });
  }).toPass({ timeout: T_MEDIUM });
}

/** True while the search box holds real DOM focus. */
async function searchBoxHasFocus(page: Page): Promise<boolean> {
  return page.evaluate(
    (selector) => document.activeElement === document.querySelector(selector),
    SEARCH_BOX
  );
}

/**
 * Sample DOM focus on every animation frame for `ms`. `scope: "input"` requires
 * the search box itself to hold focus; `scope: "popover"` requires focus to
 * stay anywhere inside the launcher's popover content. Returns a description
 * of the first frame that broke the rule, or null if it held throughout.
 */
async function focusBreakWithin(page: Page, scope: "input" | "popover", ms: number) {
  return page.evaluate(
    ([selector, mode, duration]) =>
      new Promise<string | null>((resolve) => {
        const start = performance.now();
        const tick = () => {
          const input = document.querySelector(selector);
          const content = input?.closest("[data-radix-popper-content-wrapper]");
          const active = document.activeElement;
          const held = mode === "input" ? active === input : !!content && content.contains(active);
          const elapsed = performance.now() - start;
          if (!held) {
            const desc = active
              ? `${active.tagName.toLowerCase()}[aria-label="${active.getAttribute("aria-label") ?? ""}"]`
              : "null";
            return resolve(`${Math.round(elapsed)}ms: focus on ${desc}`);
          }
          if (elapsed >= duration) return resolve(null);
          requestAnimationFrame(tick);
        };
        tick();
      }),
    [SEARCH_BOX, scope, ms] as const
  );
}

test.describe("Core: Launcher (dock and toolbar hosts)", () => {
  let ctx: AppContext;
  let fixtureCleanup: (() => void) | undefined;

  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "dock-launcher-search" });
    fixtureCleanup = cleanup;
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, dir, "Dock Launcher Test");
    // Keep a panel in the grid throughout — emptying it tears the project view
    // down (#4898) and would take the dock and the toolbar's project scope
    // with it.
    await openTerminal(ctx.window);
    await expect.poll(() => getGridPanelCount(ctx.window), { timeout: T_LONG }).toBe(1);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test.beforeEach(async () => {
    await ensureWindowFocused(ctx.app);
  });

  test.afterEach(async () => {
    await closeLauncher(ctx.window);
    await expect(ctx.window.locator('[role="menu"]')).toHaveCount(0, { timeout: T_SHORT });
  });

  test.describe("dock host", () => {
    test("hands focus to the search box instead of the content wrapper", async () => {
      const { window } = ctx;

      // This is the first open of the session, so it is also the cold-load
      // case: the lazy Radix chunk resolves after the click, and
      // `onOpenAutoFocus` is what covers the frame the open-state rAF can miss.
      await openLauncher(window);
      await expect.poll(() => searchBoxHasFocus(window), { timeout: T_MEDIUM }).toBe(true);

      await window.keyboard.press("Escape");
      await expect(searchBox(window)).not.toBeVisible({ timeout: T_MEDIUM });
    });

    test("arrow keys drive one selection across the unfiltered bands", async () => {
      const { window } = ctx;
      await openLauncher(window);

      // Popover carries no roving focus, so the browse list is navigated by the
      // same selectedIndex the filtered results use — not by moving DOM focus.
      await expect(window.locator(SELECTED_OPTION)).toHaveCount(1);
      const first = await window.locator(SELECTED_OPTION).textContent();

      await window.keyboard.press("ArrowDown");
      await expect(window.locator(SELECTED_OPTION)).toHaveCount(1);
      expect(await window.locator(SELECTED_OPTION).textContent()).not.toBe(first);
      expect(await searchBoxHasFocus(window)).toBe(true);

      await window.keyboard.press("Escape");
      await expect(searchBox(window)).not.toBeVisible({ timeout: T_MEDIUM });
    });

    test("keeps focus in the input while the pointer crosses rows", async () => {
      const { window } = ctx;
      await openLauncher(window);

      // Browse rows first — the state the user is in the instant the menu
      // opens, and the one the old DropdownMenu left unguarded.
      const browseRows = window.locator(OPTION);
      await expect.poll(() => browseRows.count(), { timeout: T_MEDIUM }).toBeGreaterThan(1);
      await browseRows.nth(1).hover();
      expect(await focusBreakWithin(window, "input", DWELL_MS)).toBeNull();

      await searchBox(window).fill("e");
      const rows = window.locator(OPTION);
      await expect.poll(() => rows.count(), { timeout: T_MEDIUM }).toBeGreaterThan(1);

      const hovered = rows.nth(1);
      const hoveredLabel = await hovered.getAttribute("aria-label");
      expect(hoveredLabel).toBeTruthy();
      await hovered.hover();
      expect(await focusBreakWithin(window, "input", DWELL_MS)).toBeNull();

      // The hovered row becomes the selection, and only that one.
      await expect(window.locator(SELECTED_OPTION)).toHaveCount(1);
      await expect(window.locator(SELECTED_OPTION)).toHaveAttribute("aria-label", hoveredLabel!);

      // Typing still reaches the input.
      await window.keyboard.type("vi");
      await expect(searchBox(window)).toHaveValue("evi");

      await window.keyboard.press("Escape");
      await expect(searchBox(window)).toHaveValue("");
      await window.keyboard.press("Escape");
      await expect(searchBox(window)).not.toBeVisible({ timeout: T_MEDIUM });
    });

    test("Tab stays inside the modal popover", async () => {
      const { window } = ctx;
      await openLauncher(window);

      await window.keyboard.press("Tab");
      // Focus stays within the popover through the dwell, so the launcher is
      // still up rather than dismissed by a focus-outside.
      expect(await focusBreakWithin(window, "popover", DWELL_MS)).toBeNull();
      await expect(searchBox(window)).toBeVisible();

      await window.keyboard.press("Escape");
      await expect(searchBox(window)).not.toBeVisible({ timeout: T_MEDIUM });
    });

    test("first Escape clears the query, second closes the menu", async () => {
      const { window } = ctx;
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
      const { window } = ctx;

      const gridBefore = (await getGridPanelIds(window)).length;
      const dockBefore = (await getDockPanelIds(window)).length;

      await openLauncher(window);
      await searchBox(window).fill("review");
      // Enter confirms whatever `selectedIndex` points at, so pin the row
      // itself first — otherwise a failure here can't tell "launched the wrong
      // thing" apart from "launched nothing".
      await expect(window.locator(SELECTED_OPTION)).toContainText("Review", { timeout: T_MEDIUM });
      expect(await searchBoxHasFocus(window)).toBe(true);

      // Typing and confirming in quick succession must rank against the query
      // the user actually typed, not the previous one.
      await window.keyboard.press("Enter");

      await expect(searchBox(window)).not.toBeVisible({ timeout: T_MEDIUM });

      // Review opts out of the dock, and the launcher says so ("Open in grid")
      // — so it must land in the grid, never silently redirected.
      await expect
        .poll(() => getGridPanelIds(window).then((ids) => ids.length), { timeout: T_MEDIUM })
        .toBe(gridBefore + 1);
      expect((await getDockPanelIds(window)).length).toBe(dockBefore);
    });

    test("Enter launches a searched dockable panel into the dock", async () => {
      const { window } = ctx;

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

    // #11689 — the per-row pin. Stopping propagation on pointerdown in a nested
    // control costs the real DismissableLayer the event it uses to classify
    // the NEXT outside click, and the launcher then takes two clicks to dismiss.
    test("pinning from a row leaves the launcher usable and still dismissable in one click", async () => {
      const { window } = ctx;
      const openBrowserButton = window.locator('[aria-label="Open browser"]');
      await expect(openBrowserButton).toHaveCount(0);

      await openLauncher(window);
      await searchBox(window).fill("browser");

      // By the option's own accessible name, anchored at the start — `hasText`
      // is a substring match and "browser" also ranks File Browser.
      const pin = window.locator(`${OPTION}[aria-label^="Browser,"] [data-launcher-pin]`);
      await expect(pin).toHaveAttribute("data-pinned", "false", { timeout: T_MEDIUM });

      await pin.click();

      // Pinning is a change to the list, not an exit from it: the popover stays
      // open, the query survives, and focus never left the search box.
      await expect(searchBox(window)).toBeVisible();
      await expect(searchBox(window)).toHaveValue("browser");
      expect(await searchBoxHasFocus(window)).toBe(true);
      await expect(pin).toHaveAttribute("data-pinned", "true", { timeout: T_MEDIUM });

      // The toolbar button beside the launcher is how a pin becomes visible.
      // The write is optimistic through an async IPC, so this waits.
      await expect(openBrowserButton).toBeAttached({ timeout: T_MEDIUM });

      // The regression: ONE outside click must dismiss. Aimed relative to the
      // search box — the launcher anchors to the dock's left edge, so a
      // hard-coded coordinate risks landing on the trigger. `mouse.click`, not
      // a locator click: the popover is modal, so everything outside it has
      // pointer events disabled and actionability would retry forever.
      const surface = await window.locator(SEARCH_BOX).boundingBox();
      if (!surface) throw new Error("launcher surface has no box");
      await window.mouse.click(surface.x + surface.width + 240, surface.y);
      await expect(searchBox(window)).not.toBeVisible({ timeout: T_MEDIUM });

      // Leave the toolbar as this suite found it — later tests share the window.
      await openLauncher(window);
      await searchBox(window).fill("browser");
      const pinAgain = window.locator(`${OPTION}[aria-label^="Browser,"] [data-launcher-pin]`);
      await expect(pinAgain).toHaveAttribute("data-pinned", "true", { timeout: T_MEDIUM });
      await pinAgain.click();
      await expect(pinAgain).toHaveAttribute("data-pinned", "false", { timeout: T_MEDIUM });
      await searchBox(window).fill("");
      await window.keyboard.press("Escape");
      await expect(searchBox(window)).not.toBeVisible({ timeout: T_MEDIUM });
      await expect(openBrowserButton).toHaveCount(0, { timeout: T_MEDIUM });
    });
  });

  test.describe("toolbar host", () => {
    test("opens the shared palette from the toolbar and focuses the search box", async () => {
      await openLauncher(ctx.window, TOOLBAR_LAUNCHER);

      // Same chrome as the dock placement: this is one component, not two.
      await expect(ctx.window.locator(OPTION).first()).toBeVisible({ timeout: T_MEDIUM });
      expect(await searchBoxHasFocus(ctx.window)).toBe(true);
    });

    test("anchors below the toolbar rather than over it", async () => {
      await openLauncher(ctx.window, TOOLBAR_LAUNCHER);

      const trigger = await ctx.window.locator(TOOLBAR_LAUNCHER).boundingBox();
      const content = await ctx.window.locator(SEARCH_BOX).boundingBox();
      expect(trigger).not.toBeNull();
      expect(content).not.toBeNull();
      // A popover that opened upward here would be clipped by the window chrome
      // above the toolbar.
      expect(content!.y).toBeGreaterThan(trigger!.y);
    });

    test("right click opens the toolbar context menu without opening the launcher", async () => {
      // The context-menu primitive is code-split and primes on pointer activity
      // over the trigger, so a cold right-click can miss until the chunk lands.
      // Prime with a hover, then retry the right-click — the contract under
      // test is which overlay answers, not how fast Radix loads.
      const launcher = ctx.window.locator(TOOLBAR_LAUNCHER);
      const menu = ctx.window.locator('[role="menu"]').first();
      await launcher.hover();
      await expect(async () => {
        await launcher.click({ button: "right" });
        await expect(menu).toBeVisible({ timeout: T_SHORT });
      }).toPass({ timeout: T_MEDIUM });

      await expect(searchBox(ctx.window)).toHaveCount(0);

      await ctx.window.keyboard.press("Escape");
      await expect(menu).toBeHidden({ timeout: T_SHORT });
    });

    test("keeps the trigger in the toolbar's roving tabindex", async () => {
      // The toolbar's keyboard model sweeps `[data-toolbar-item]` off the real
      // DOM, so a trigger that forgot the attribute silently drops out of it.
      await expect(ctx.window.locator(TOOLBAR_LAUNCHER)).toHaveAttribute("data-toolbar-item");
    });

    test("keeps an aria-disabled row reachable and pinnable", async () => {
      await openLauncher(ctx.window, TOOLBAR_LAUNCHER);
      await searchBox(ctx.window).fill("dev preview");

      const row = ctx.window.locator(`${OPTION}[aria-label^="Dev preview,"]`).first();
      await expect(row).toBeVisible({ timeout: T_MEDIUM });

      // Whether it is gated depends on the fixture's project state; what must
      // hold either way is that the row is an option carrying its own pin
      // control, so the affordance stays reachable when it IS gated.
      await expect(row.locator("[data-launcher-pin]")).toHaveCount(1);
    });

    test("Escape clears a query before it closes the launcher", async () => {
      await openLauncher(ctx.window, TOOLBAR_LAUNCHER);
      await searchBox(ctx.window).fill("terminal");

      await ctx.window.keyboard.press("Escape");
      await expect(searchBox(ctx.window)).toBeVisible({ timeout: T_SHORT });
      await expect(searchBox(ctx.window)).toHaveValue("");

      await ctx.window.keyboard.press("Escape");
      await expect(searchBox(ctx.window)).toHaveCount(0);
    });
  });
});
