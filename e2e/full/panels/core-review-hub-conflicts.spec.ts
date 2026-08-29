/**
 * Core: Review Hub Conflict Resolution
 *
 * Covers the Review Hub's ConflictPanel against repos left mid-operation:
 *  - merge conflict: panel renders, the Continue gate, and resolving a file
 *    via "Take theirs" (with its confirm dialog),
 *  - merge conflict: abort (cancel keeps the conflict, confirm discards it),
 *  - rebase conflict: progress chip + sequence rail, resolve, then abort.
 *
 * Each describe block owns a fresh fixture + app instance so the in-progress
 * git state is isolated. All conflicts are deterministic (two branches edit
 * the same line).
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
  await reviewItem.click();

  const hub = window.locator(SEL.reviewHub.container);
  await expect(hub).toBeVisible({ timeout: T_MEDIUM });
  await expect(hub.locator(SEL.reviewHub.conflictPanel)).toBeVisible({ timeout: T_LONG });
  return hub;
}

test.describe("Core: Review Hub Conflict Resolution", () => {
  test.describe.serial("Merge conflict — panel and resolution", () => {
    let ctx: AppContext;
    let fixtureCleanup: (() => void) | undefined;

    test.beforeAll(async () => {
      const fixture = createConflictFixtureRepo("merge");
      fixtureCleanup = fixture.cleanup;
      ctx = await launchApp();
      ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixture.dir, "Merge Conflict");
    });

    test.afterAll(async () => {
      if (ctx?.app) await closeApp(ctx.app);
      fixtureCleanup?.();
    });

    test("conflict panel lists the conflicted file", async () => {
      const hub = await openConflictReviewHub(ctx);
      await expect(hub.locator(SEL.reviewHub.conflictTakeTheirs("conflict.txt"))).toBeVisible({
        timeout: T_MEDIUM,
      });
      // Continue is gated until every conflict is resolved.
      await expect(hub.locator(SEL.reviewHub.conflictContinue)).toBeDisabled({ timeout: T_SHORT });
    });

    test("Take theirs resolves the file and enables Continue", async () => {
      const { window } = ctx;
      const hub = window.locator(SEL.reviewHub.container);

      await hub.locator(SEL.reviewHub.conflictTakeTheirs("conflict.txt")).click();
      const checkoutDialog = window.getByRole("alertdialog").filter({ hasText: "Take theirs" });
      await expect(checkoutDialog).toBeVisible({ timeout: T_MEDIUM });
      await window.locator(SEL.confirmDialog.confirm).click();

      // The conflicted row leaves the worklist and Continue unlocks.
      await expect(hub.locator(SEL.reviewHub.conflictTakeTheirs("conflict.txt"))).toBeHidden({
        timeout: T_MEDIUM,
      });
      await expect(hub.locator(SEL.reviewHub.conflictContinue)).toBeEnabled({ timeout: T_MEDIUM });
    });
  });

  test.describe.serial("Merge conflict — abort", () => {
    let ctx: AppContext;
    let fixtureCleanup: (() => void) | undefined;

    test.beforeAll(async () => {
      const fixture = createConflictFixtureRepo("merge");
      fixtureCleanup = fixture.cleanup;
      ctx = await launchApp();
      ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixture.dir, "Merge Abort");
    });

    test.afterAll(async () => {
      if (ctx?.app) await closeApp(ctx.app);
      fixtureCleanup?.();
    });

    test("cancelling the abort dialog keeps the conflict", async () => {
      const hub = await openConflictReviewHub(ctx);
      const { window } = ctx;

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
    let ctx: AppContext;
    let fixtureCleanup: (() => void) | undefined;

    test.beforeAll(async () => {
      const fixture = createConflictFixtureRepo("rebase");
      fixtureCleanup = fixture.cleanup;
      ctx = await launchApp();
      ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixture.dir, "Rebase Conflict");
    });

    test.afterAll(async () => {
      if (ctx?.app) await closeApp(ctx.app);
      fixtureCleanup?.();
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

      await hub.locator(SEL.reviewHub.conflictTakeTheirs("conflict.txt")).click();
      await expect(window.getByRole("alertdialog").filter({ hasText: "Take theirs" })).toBeVisible({
        timeout: T_MEDIUM,
      });
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
