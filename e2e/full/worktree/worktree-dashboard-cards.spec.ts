import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createMultiProjectFixture, type MultiProjectFixture } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { addAndSwitchToProject } from "../../helpers/workflows";
import { SEL } from "../../helpers/selectors";
import { T_MEDIUM, T_LONG } from "../../helpers/timeouts";

const mod = process.platform === "darwin" ? "Meta" : "Control";

let ctx: AppContext;
let fixture: MultiProjectFixture | undefined;

async function openFilterPopover(window: Page): Promise<void> {
  await window.locator(SEL.worktree.filterButton).click();
  await expect(window.locator(SEL.worktree.filterPopover)).toBeVisible({ timeout: T_MEDIUM });
}

async function closeFilterPopover(window: Page): Promise<void> {
  await window.keyboard.press("Escape");
  await expect(window.locator(SEL.worktree.filterPopover)).toBeHidden({ timeout: T_MEDIUM });
}

test.describe.serial("Full: Worktree Dashboard Cards", () => {
  test.beforeAll(async () => {
    fixture = createMultiProjectFixture(
      { name: "dashboard-A", withFeatureBranch: true },
      { name: "dashboard-B", withFeatureBranch: true }
    );

    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixture.repoA, "Dashboard A");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixture?.cleanup();
  });

  test("overview modal supports Ctrl-click and Shift-click range multi-select", async () => {
    const { window } = ctx;

    await window.keyboard.press(`${mod}+Shift+O`);
    await expect(window.locator(SEL.worktree.overviewModal)).toBeVisible({ timeout: T_LONG });

    const cells = window.locator(SEL.worktree.overviewCell);
    await expect(cells).toHaveCount(2, { timeout: T_LONG });

    const first = cells.nth(0);
    const second = cells.nth(1);

    // Ctrl/Cmd-click selects a single cell and surfaces the bulk-action bar.
    await first.click({ modifiers: ["ControlOrMeta"], position: { x: 20, y: 20 } });
    await expect(first).toHaveAttribute("aria-selected", "true", { timeout: T_MEDIUM });
    await expect(window.locator(SEL.worktree.overviewModal)).toContainText("1 of 2 selected");
    await expect(window.locator(SEL.worktree.bulkRemove)).toBeVisible();
    await expect(window.locator(SEL.worktree.bulkCloseSessions)).toBeVisible();

    // Shift-click extends the selection range from the anchor to the target.
    await second.click({ modifiers: ["Shift"], position: { x: 20, y: 20 } });
    await expect(second).toHaveAttribute("aria-selected", "true", { timeout: T_MEDIUM });
    await expect(window.locator(SEL.worktree.overviewModal)).toContainText("2 of 2 selected");

    // Clearing the selection dismisses the bulk-action bar and deselects both cells.
    await window.locator(SEL.worktree.clearSelection).click();
    await expect(window.locator(SEL.worktree.bulkRemove)).toHaveCount(0, { timeout: T_MEDIUM });
    await expect(first).toHaveAttribute("aria-selected", "false", { timeout: T_MEDIUM });
    await expect(second).toHaveAttribute("aria-selected", "false", { timeout: T_MEDIUM });

    // The close button dismisses in ONE click even with a selection active:
    // only Escape carries the clear-then-close contract, and the bar above has
    // its own Clear control.
    await first.click({ modifiers: ["ControlOrMeta"], position: { x: 20, y: 20 } });
    await expect(window.locator(SEL.worktree.overviewModal)).toContainText("1 of 2 selected");
    await window.locator(SEL.worktree.overviewClose).click();
    await expect(window.locator(SEL.worktree.overviewModal)).toBeHidden({ timeout: T_MEDIUM });
  });

  test("sort order can be changed in the filter popover", async () => {
    const { window } = ctx;

    await openFilterPopover(window);
    const popover = window.locator(SEL.worktree.filterPopover);

    // Default sort is "Date created".
    await expect(popover.getByRole("radio", { name: "Date created" })).toBeChecked({
      timeout: T_MEDIUM,
    });

    const alphabetical = popover.getByRole("radio", { name: "Alphabetical" });
    await alphabetical.click();
    await expect(alphabetical).toBeChecked({ timeout: T_MEDIUM });

    await closeFilterPopover(window);
  });

  test("sort order persists across a project switch", async () => {
    // Serial dependency: relies on the preceding test having set "Alphabetical".
    // orderBy is a global (cross-project) preference persisted to localStorage,
    // so a fresh project view's renderer must read back the Alphabetical choice.
    ctx.window = await addAndSwitchToProject(ctx.app, ctx.window, fixture!.repoB, "Dashboard B");

    await openFilterPopover(ctx.window);
    await expect(
      ctx.window.locator(SEL.worktree.filterPopover).getByRole("radio", { name: "Alphabetical" })
    ).toBeChecked({ timeout: T_LONG });
    await closeFilterPopover(ctx.window);
  });
});
