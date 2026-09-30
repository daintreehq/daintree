/**
 * Core: Review Hub Conflict Resolution
 *
 * Covers the Review Hub's ConflictPanel against repos left mid-operation:
 *  - merge conflict: panel renders, the Continue gate, and resolving a file
 *    via "Take theirs" (with its confirm dialog),
 *  - merge conflict: abort (cancel keeps the conflict, confirm discards it),
 *  - rebase conflict: progress chip + sequence rail, resolve, then abort.
 *
 * One app hosts every fixture, each opened as its own project: a merge
 * resolved via "Take theirs", a second merge that is aborted while its
 * conflict is still unresolved, and a rebase. All conflicts are deterministic
 * (two branches edit the same line).
 *
 * Note: these specs exercise resolution and abort, not the "continue the
 * operation" path. Driving `git merge/rebase --continue` from the headless CI
 * Electron host hangs on the commit-message editor handshake even with the
 * non-interactive env overlay, which is tracked separately — abort gives
 * reliable coverage of operation teardown without that flake.
 */

import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createConflictFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { addAndSwitchToProject } from "../../helpers/workflows";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";

async function openConflictReviewHub(ctx: AppContext) {
  const { window } = ctx;

  // The card's inline "Open Review & Commit" button is gated on hasChanges,
  // which is 0 while a merge/rebase is in progress: WorktreeMonitor skips the
  // git status poll during an operation to avoid competing for index.lock
  // (WorktreeMonitor.ts:1421). The actions-menu Review ▸ "Review worktree" item
  // is only gated on the handler being wired, so it's the reliable entry point.
  const card = window.locator(SEL.worktree.mainCard);
  await expect(card).toBeVisible({ timeout: T_LONG });
  await card.locator(SEL.worktree.actionsMenu).click();

  const reviewTrigger = window.getByRole("menuitem", { name: "Review", exact: true });
  await expect(reviewTrigger).toBeVisible({ timeout: T_MEDIUM });
  // Radix SubTriggers open on hover, but a hover dropped by Linux CI never
  // mounts the child — click is the reliable fallback the rest of the suite
  // uses too.
  await reviewTrigger.hover();
  const reviewItem = window.getByRole("menuitem", { name: "Review worktree", exact: true });
  if (!(await reviewItem.isVisible().catch(() => false))) {
    await reviewTrigger.click();
  }
  await expect(reviewItem).toBeVisible({ timeout: T_MEDIUM });
  // Radix can remount the hovered submenu during the pointer-stability check.
  // Keyboard activation uses the same menu action without depending on its geometry.
  await reviewItem.press("Enter");

  const hub = window.locator(SEL.reviewHub.container);
  await expect(hub).toBeVisible({ timeout: T_MEDIUM });
  await expect(hub.locator(SEL.reviewHub.conflictPanel)).toBeVisible({ timeout: T_LONG });
  return hub;
}

async function openTheirsAction(ctx: AppContext, source: "incoming changes" | "incoming commit") {
  const { window } = ctx;
  await window
    .locator(SEL.reviewHub.container)
    .locator(SEL.reviewHub.conflictMoreActions("conflict.txt"))
    .click();
  return window.getByRole("menuitem", {
    name: `Use ${source} for conflict.txt (theirs)`,
    exact: true,
  });
}

// The first group onboards from the welcome screen; later groups add their
// fixture as another project. A group that runs on a relaunched worker (after a
// failure elsewhere) finds no project and onboards instead. The previous
// group's hub is a modal over the toolbar, so close it before switching.
async function openFixtureProject(ctx: AppContext, dir: string, name: string) {
  const hasProject = await ctx.window.evaluate(
    async () => (await globalThis.window.electron.project.getCurrent()) != null
  );
  if (!hasProject) return openAndOnboardProject(ctx.app, ctx.window, dir, name);
  const hub = ctx.window.locator(SEL.reviewHub.container);
  if (await hub.isVisible()) {
    await ctx.window.locator(SEL.reviewHub.close).click();
    await expect(hub).toBeHidden({ timeout: T_SHORT });
  }
  return addAndSwitchToProject(ctx.app, ctx.window, dir, name);
}

let ctx: AppContext;
const fixtureCleanups: Array<() => void> = [];

test.describe("Core: Review Hub Conflict Resolution", () => {
  test.beforeAll(async () => {
    ctx = await launchApp();
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    for (const cleanup of fixtureCleanups.splice(0)) cleanup();
  });

  test.describe.serial("Merge conflict — panel and resolution", () => {
    test.beforeAll(async () => {
      const fixture = createConflictFixtureRepo("merge");
      fixtureCleanups.push(fixture.cleanup);
      ctx.window = await openFixtureProject(ctx, fixture.dir, "Merge Conflict");
    });

    test("conflict panel lists the conflicted file", async () => {
      const hub = await openConflictReviewHub(ctx);
      await expect(hub.locator(SEL.reviewHub.conflictMoreActions("conflict.txt"))).toBeVisible({
        timeout: T_MEDIUM,
      });
      await expect(await openTheirsAction(ctx, "incoming changes")).toBeVisible();
      await ctx.window.keyboard.press("Escape");
      // Continue is gated until every conflict is resolved.
      await expect(hub.locator(SEL.reviewHub.conflictContinue)).toBeDisabled({ timeout: T_SHORT });
    });

    test("Take theirs resolves the file and enables Continue", async () => {
      const { window } = ctx;
      const hub = window.locator(SEL.reviewHub.container);

      await (await openTheirsAction(ctx, "incoming changes")).click();
      const checkoutDialog = window
        .getByRole("alertdialog")
        .filter({ hasText: "Use incoming changes" });
      await expect(checkoutDialog).toBeVisible({ timeout: T_MEDIUM });
      await window.locator(SEL.confirmDialog.confirm).click();

      // The conflicted row leaves the worklist and Continue unlocks.
      await expect(hub.locator(SEL.reviewHub.conflictMoreActions("conflict.txt"))).toBeHidden({
        timeout: T_MEDIUM,
      });
      await expect(hub.locator(SEL.reviewHub.conflictContinue)).toBeEnabled({ timeout: T_MEDIUM });
    });
  });

  test.describe.serial("Merge conflict — abort", () => {
    test.beforeAll(async () => {
      const fixture = createConflictFixtureRepo("merge");
      fixtureCleanups.push(fixture.cleanup);
      ctx.window = await openFixtureProject(ctx, fixture.dir, "Merge Conflict Abort");
      await openConflictReviewHub(ctx);
    });

    test("cancelling the abort dialog keeps the conflict", async () => {
      const { window } = ctx;
      const hub = window.locator(SEL.reviewHub.container);

      await hub.locator(SEL.reviewHub.conflictAbort).click();
      const abortDialog = window.getByRole("alertdialog").filter({ hasText: "Abort" });
      await expect(abortDialog).toBeVisible({ timeout: T_MEDIUM });

      await window.locator(SEL.confirmDialog.cancel).click();
      await expect(abortDialog).toBeHidden({ timeout: T_SHORT });
      await expect(hub.locator(SEL.reviewHub.conflictPanel)).toBeVisible({ timeout: T_SHORT });
    });

    test("confirming the abort discards the merge", async () => {
      const { window } = ctx;
      const hub = window.locator(SEL.reviewHub.container);

      await hub.locator(SEL.reviewHub.conflictAbort).click();
      await expect(window.getByRole("alertdialog").filter({ hasText: "Abort" })).toBeVisible({
        timeout: T_MEDIUM,
      });
      await window.locator(SEL.confirmDialog.confirm).click();

      await expect(hub.locator(SEL.reviewHub.conflictPanel)).toBeHidden({ timeout: T_LONG });
      await expect(hub.locator(SEL.reviewHub.cleanState)).toBeVisible({ timeout: T_MEDIUM });
    });
  });

  test.describe.serial("Rebase conflict — progress, resolution, abort", () => {
    test.beforeAll(async () => {
      const fixture = createConflictFixtureRepo("rebase");
      fixtureCleanups.push(fixture.cleanup);
      ctx.window = await openFixtureProject(ctx, fixture.dir, "Rebase Conflict");
    });

    test("rebase conflict shows progress chip and sequence rail", async () => {
      const hub = await openConflictReviewHub(ctx);
      await expect(hub.locator(SEL.reviewHub.conflictRebaseProgress)).toBeVisible({
        timeout: T_MEDIUM,
      });
      await expect(hub.locator(SEL.reviewHub.conflictRebaseSequence)).toBeVisible({
        timeout: T_MEDIUM,
      });
    });

    test("Take theirs resolves the file and enables Continue", async () => {
      const { window } = ctx;
      const hub = window.locator(SEL.reviewHub.container);

      await (await openTheirsAction(ctx, "incoming commit")).click();
      await expect(
        window.getByRole("alertdialog").filter({ hasText: "Use incoming commit" })
      ).toBeVisible({ timeout: T_MEDIUM });
      await window.locator(SEL.confirmDialog.confirm).click();

      await expect(hub.locator(SEL.reviewHub.conflictContinue)).toBeEnabled({ timeout: T_MEDIUM });
    });

    test("aborting discards the rebase", async () => {
      const { window } = ctx;
      const hub = window.locator(SEL.reviewHub.container);

      await hub.locator(SEL.reviewHub.conflictAbort).click();
      await expect(window.getByRole("alertdialog").filter({ hasText: "Abort" })).toBeVisible({
        timeout: T_MEDIUM,
      });
      await window.locator(SEL.confirmDialog.confirm).click();

      await expect(hub.locator(SEL.reviewHub.conflictPanel)).toBeHidden({ timeout: T_LONG });
    });
  });
});
