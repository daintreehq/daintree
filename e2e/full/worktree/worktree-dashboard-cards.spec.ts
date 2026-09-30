import path from "path";
import { execFileSync } from "child_process";
import { statSync } from "fs";
import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createMultiProjectFixture, type MultiProjectFixture } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import {
  ensureFilterSectionOpen,
  addAndSwitchToProject,
  selectExistingProjectAndRefresh,
  switchWorktree,
} from "../../helpers/workflows";
import { SEL } from "../../helpers/selectors";
import { T_MEDIUM, T_LONG } from "../../helpers/timeouts";

const mod = process.platform === "darwin" ? "Meta" : "Control";
const FEATURE = "feature/test-branch";
const PROJECT_A = "dashboard-A";
const PROJECT_B = "dashboard-B";

// Created in this order after the fixture's feature/test-branch, so "Date
// created" (newest first) and "Alphabetical" disagree at every position.
const SORT_BRANCHES = ["feature/alpha-sort", "feature/zeta-sort"];
const ORDER_BY_CREATED = ["feature/zeta-sort", "feature/alpha-sort", FEATURE];
const ORDER_ALPHABETICAL = ["feature/alpha-sort", FEATURE, "feature/zeta-sort"];
const WORKTREE_COUNT = 1 + 1 + SORT_BRANCHES.length;

let ctx: AppContext;
let fixture: MultiProjectFixture | undefined;

function addSortWorktrees(repoDir: string): void {
  const worktreesDir = path.join(path.dirname(repoDir), path.basename(repoDir) + "-worktrees");
  let previous = effectiveCreatedAt(path.join(worktreesDir, "feature-test-branch"));
  for (const branch of SORT_BRANCHES) {
    // The app orders "Date created" by the worktree directory's birthtime
    // (ctime where birthtime is unsupported), so each directory must be born
    // strictly after the previous one at the filesystem's resolution.
    while (Date.now() <= previous + 50) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    const dir = path.join(worktreesDir, branch.replace("/", "-"));
    execFileSync("git", ["worktree", "add", "-b", branch, dir], { cwd: repoDir, stdio: "ignore" });
    const created = effectiveCreatedAt(dir);
    if (created <= previous) {
      throw new Error(`${dir} was not created after its predecessor (${created} <= ${previous})`);
    }
    previous = created;
  }
}

function effectiveCreatedAt(dir: string): number {
  const stats = statSync(dir);
  return stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.ctimeMs;
}

async function sidebarBranchOrder(window: Page): Promise<string[]> {
  return window
    .locator('[data-variant="sidebar"][data-worktree-branch]:not([data-worktree-is-main="true"])')
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-worktree-branch") ?? ""));
}

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
      { name: PROJECT_A, withFeatureBranch: true },
      { name: PROJECT_B, withFeatureBranch: true }
    );
    addSortWorktrees(fixture.repoA);
    addSortWorktrees(fixture.repoB);

    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixture.repoA, PROJECT_A);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixture?.cleanup();
  });

  test("overview modal opens and shows every worktree card", async () => {
    const { window } = ctx;

    await window.keyboard.press(`${mod}+Alt+R`);

    const modal = window.locator(SEL.worktree.overviewModal);
    await expect(modal).toBeVisible({ timeout: T_LONG });
    await expect(window.getByRole("dialog", { name: "Worktrees" })).toBeVisible();

    await expect(modal.locator(SEL.worktree.overviewCell)).toHaveCount(WORKTREE_COUNT, {
      timeout: T_LONG,
    });
  });

  test("search filtering narrows displayed worktrees in overview", async () => {
    const { window } = ctx;
    const modal = window.locator(SEL.worktree.overviewModal);
    await expect(modal).toBeVisible({ timeout: T_MEDIUM });

    const cells = modal.locator(SEL.worktree.overviewCell);
    await expect(cells).toHaveCount(WORKTREE_COUNT, { timeout: T_LONG });

    const searchInput = modal.getByRole("textbox", { name: "Search worktrees" });
    await expect(searchInput).toBeVisible({ timeout: T_MEDIUM });

    await searchInput.click();
    await searchInput.fill(FEATURE);
    await expect(cells, "Search should narrow to the feature worktree").toHaveCount(1, {
      timeout: T_MEDIUM,
    });
    await expect(cells.first()).toContainText("test-branch");

    await searchInput.clear();
    await expect(cells).toHaveCount(WORKTREE_COUNT, { timeout: T_MEDIUM });

    // An active query also filters the active worktree (alwaysShowActive only
    // applies without one), so nothing matches.
    await searchInput.fill("nonexistent-branch-xyz-999");
    await expect(cells, "Non-matching search should show no worktree cards").toHaveCount(0, {
      timeout: T_MEDIUM,
    });

    await searchInput.fill("");
    await expect(cells).toHaveCount(WORKTREE_COUNT, { timeout: T_MEDIUM });

    // The overview carries its own filter control onto the same popover.
    await modal.locator(SEL.worktree.filterButton).click();
    const popover = window.locator(SEL.worktree.filterPopover);
    await expect(popover).toBeVisible({ timeout: T_MEDIUM });
    await ensureFilterSectionOpen(popover, "Sort by");
    await expect(popover.getByRole("radio", { name: "Date created" })).toBeChecked();
    await modal.locator(SEL.worktree.filterButton).click();
    await expect(popover).not.toBeVisible({ timeout: T_MEDIUM });

    await window.keyboard.press("Escape");
    await expect(modal).not.toBeVisible({ timeout: T_MEDIUM });
    await expect(window.locator("[data-worktree-branch]").first()).toBeVisible({
      timeout: T_MEDIUM,
    });
  });

  test("overview modal supports Ctrl-click and Shift-click range multi-select", async () => {
    const { window } = ctx;
    const total = `of ${WORKTREE_COUNT} selected`;

    await window.keyboard.press(`${mod}+Alt+R`);
    await expect(window.locator(SEL.worktree.overviewModal)).toBeVisible({ timeout: T_LONG });

    const cells = window.locator(SEL.worktree.overviewCell);
    await expect(cells).toHaveCount(WORKTREE_COUNT, { timeout: T_LONG });

    const first = cells.nth(0);
    const second = cells.nth(1);

    // Ctrl/Cmd-click selects a single cell and surfaces the bulk-action bar.
    await first.click({ modifiers: ["ControlOrMeta"], position: { x: 20, y: 20 } });
    await expect(first).toHaveAttribute("aria-selected", "true", { timeout: T_MEDIUM });
    await expect(window.locator(SEL.worktree.overviewModal)).toContainText(`1 ${total}`);
    await expect(window.locator(SEL.worktree.bulkRemove)).toBeVisible();
    await expect(window.locator(SEL.worktree.bulkCloseSessions)).toBeVisible();

    // Shift-click extends the selection range from the anchor to the target.
    await second.click({ modifiers: ["Shift"], position: { x: 20, y: 20 } });
    await expect(second).toHaveAttribute("aria-selected", "true", { timeout: T_MEDIUM });
    await expect(window.locator(SEL.worktree.overviewModal)).toContainText(`2 ${total}`);

    // Clearing the selection dismisses the bulk-action bar and deselects both cells.
    await window.locator(SEL.worktree.overviewModal).getByRole("button", { name: "Clear" }).click();
    await expect(window.locator(SEL.worktree.bulkRemove)).toHaveCount(0, { timeout: T_MEDIUM });
    await expect(first).toHaveAttribute("aria-selected", "false", { timeout: T_MEDIUM });
    await expect(second).toHaveAttribute("aria-selected", "false", { timeout: T_MEDIUM });

    // Escape first clears the selection, then closes the overview.
    await first.click({ modifiers: ["ControlOrMeta"], position: { x: 20, y: 20 } });
    await expect(window.locator(SEL.worktree.overviewModal)).toContainText(`1 ${total}`);
    await window.keyboard.press("Escape");
    await expect(first).toHaveAttribute("aria-selected", "false", { timeout: T_MEDIUM });
    await expect(window.locator(SEL.worktree.overviewModal)).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(window.locator(SEL.worktree.overviewModal)).toBeHidden({ timeout: T_MEDIUM });
  });

  test("sort order in the filter popover reorders the worktree cards", async () => {
    const { window } = ctx;

    await openFilterPopover(window);
    const popover = window.locator(SEL.worktree.filterPopover);
    await ensureFilterSectionOpen(popover, "Sort by");

    // Default sort is "Date created", newest first.
    await expect(popover.getByRole("radio", { name: "Date created" })).toBeChecked({
      timeout: T_MEDIUM,
    });
    await expect
      .poll(() => sidebarBranchOrder(window), { timeout: T_LONG })
      .toEqual(ORDER_BY_CREATED);

    const recent = popover.getByRole("radio", { name: "Recently updated" });
    const alphabetical = popover.getByRole("radio", { name: "Alphabetical" });

    await recent.click();
    await expect(recent).toBeChecked({ timeout: T_MEDIUM });
    await expect(alphabetical).not.toBeChecked();

    await alphabetical.click();
    await expect(alphabetical).toBeChecked({ timeout: T_MEDIUM });
    await expect(recent).not.toBeChecked();
    await expect
      .poll(() => sidebarBranchOrder(window), { timeout: T_LONG })
      .toEqual(ORDER_ALPHABETICAL);

    // Back to "Date created" restores the creation order...
    const created = popover.getByRole("radio", { name: "Date created" });
    await created.click();
    await expect(created).toBeChecked({ timeout: T_MEDIUM });
    await expect(alphabetical).not.toBeChecked();
    await expect
      .poll(() => sidebarBranchOrder(window), { timeout: T_LONG })
      .toEqual(ORDER_BY_CREATED);

    // ...and Alphabetical is left set for the project-switch test below.
    await alphabetical.click();
    await expect(alphabetical).toBeChecked({ timeout: T_MEDIUM });
    await expect
      .poll(() => sidebarBranchOrder(window), { timeout: T_LONG })
      .toEqual(ORDER_ALPHABETICAL);

    await closeFilterPopover(window);
  });

  test("sort order persists across a project switch", async () => {
    // Serial dependency: relies on the preceding test having set "Alphabetical".
    // orderBy is a global (cross-project) preference persisted to localStorage,
    // so a fresh project view's renderer must read back the Alphabetical choice.
    await switchWorktree(ctx.window, FEATURE);

    ctx.window = await addAndSwitchToProject(ctx.app, ctx.window, fixture!.repoB, PROJECT_B);
    await expect(ctx.window.locator(SEL.worktree.card(FEATURE))).toBeVisible({ timeout: T_LONG });

    await expect
      .poll(() => sidebarBranchOrder(ctx.window), { timeout: T_LONG })
      .toEqual(ORDER_ALPHABETICAL);

    await openFilterPopover(ctx.window);
    const popover = ctx.window.locator(SEL.worktree.filterPopover);
    await ensureFilterSectionOpen(popover, "Sort by");
    await expect(popover.getByRole("radio", { name: "Alphabetical" })).toBeChecked({
      timeout: T_LONG,
    });
    await closeFilterPopover(ctx.window);
  });

  test("active worktree persists after project switch round-trip", async () => {
    // Serial dependency: the preceding test selected the feature worktree in
    // Project A before switching to Project B.
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);

    await expect(ctx.window.locator(SEL.worktree.card(FEATURE))).toBeVisible({ timeout: T_LONG });
    await expect(ctx.window.locator(SEL.worktree.row(FEATURE))).toHaveAttribute(
      "aria-current",
      "true",
      { timeout: T_LONG }
    );
    await expect(ctx.window.locator(SEL.worktree.mainRow)).not.toHaveAttribute(
      "aria-current",
      "true"
    );
  });
});
