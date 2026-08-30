/**
 * Core: Review Hub Workflow
 *
 * Tests the full Review Hub commit lifecycle:
 * - File list visibility with status badges
 * - Staging files (Changes → Staged)
 * - Commit message input and commit button readiness
 * - Committing and post-commit clean state
 * - Diff mode toggle (base-branch view disabled on a main-only repo)
 * - Hub close
 *
 * Uses a fixture repo with uncommitted changes (untracked `uncommitted.txt`).
 * Tests are serial — each builds on the state left by the previous test.
 */

import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";

let ctx: AppContext;
let fixtureCleanup: (() => void) | undefined;

test.describe.serial("Core: Review Hub Workflow", () => {
  test.beforeAll(async () => {
    const fixture = createFixtureRepo({
      name: "review-hub-workflow",
      withUncommittedChanges: true,
    });
    fixtureCleanup = fixture.cleanup;
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixture.dir, "Review Hub Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("worktree card shows Review & Commit button", async () => {
    const { window } = ctx;

    const reviewBtn = window.locator(SEL.worktree.reviewHubButton);
    await expect(reviewBtn.first()).toBeVisible({ timeout: T_LONG });
  });

  test("clicking Review & Commit opens the hub overlay", async () => {
    const { window } = ctx;

    const reviewBtn = window.locator(SEL.worktree.reviewHubButton);
    await reviewBtn.first().click();

    const hub = window.locator(SEL.reviewHub.container);
    await expect(hub).toBeVisible({ timeout: T_MEDIUM });

    // PR #7890 auto-stages everything when the hub is launched from a worktree
    // card. The file list is expanded on open, but gate on the toggle rather
    // than assume it, so the Changes-section assertions in subsequent tests can
    // locate file rows; then unstage so they start from the unstaged baseline.
    const fileListToggle = hub.locator(SEL.reviewHub.fileListToggle);
    await expect(fileListToggle).toBeVisible({ timeout: T_MEDIUM });
    if ((await fileListToggle.getAttribute("aria-expanded")) !== "true") {
      await fileListToggle.click();
    }
    await expect(hub.locator(SEL.reviewHub.unstageAllButton)).toBeVisible({ timeout: T_MEDIUM });
    await hub.locator(SEL.reviewHub.unstageAllButton).click();
    await expect(hub.locator(SEL.reviewHub.noStagedFiles)).toBeVisible({ timeout: T_MEDIUM });
  });

  test("file list shows uncommitted.txt in Changes section", async () => {
    const { window } = ctx;

    const hub = window.locator(SEL.reviewHub.container);

    // Wait for the IPC-loaded file list — stage button proves it loaded, and a
    // "Stage" affordance (vs "Unstage") proves the row is in the unstaged
    // Changes section, not Staged.
    const stageBtn = hub.locator(SEL.reviewHub.stageButton("uncommitted.txt"));
    await expect(stageBtn).toBeVisible({ timeout: T_MEDIUM });
    await expect(hub.locator(SEL.reviewHub.unstageButton("uncommitted.txt"))).toBeHidden();

    // "Changes" section header should be visible.
    await expect(hub.locator("text=Changes")).toBeVisible({ timeout: T_SHORT });

    // The row carries the untracked status badge ("?") and the file name.
    const fileRow = hub.locator('[data-testid="file-stage-row-uncommitted.txt"]');
    await expect(fileRow).toContainText("uncommitted.txt", { timeout: T_SHORT });
    await expect(fileRow).toContainText("?", { timeout: T_SHORT });
  });

  test("staging a file moves it to the Staged section", async () => {
    const { window } = ctx;

    const hub = window.locator(SEL.reviewHub.container);

    // Click the stage button for uncommitted.txt
    const stageBtn = hub.locator(SEL.reviewHub.stageButton("uncommitted.txt"));
    await stageBtn.click();

    // Wait for the file to move: unstage button appears (proves it's now staged)
    const unstageBtn = hub.locator(SEL.reviewHub.unstageButton("uncommitted.txt"));
    await expect(unstageBtn).toBeVisible({ timeout: T_MEDIUM });

    // Stage button should be gone
    await expect(stageBtn).toBeHidden({ timeout: T_MEDIUM });

    // Unstaged section should show empty placeholder
    await expect(hub.locator(SEL.reviewHub.noUnstagedChanges)).toBeVisible({ timeout: T_MEDIUM });
  });

  test("commit message input appears and commit button becomes actionable", async () => {
    const { window } = ctx;

    const hub = window.locator(SEL.reviewHub.container);

    // CommitPanel renders when totalChanges > 0 in working-tree mode
    const textarea = hub.locator(SEL.reviewHub.commitMessageInput);
    await expect(textarea).toBeVisible({ timeout: T_MEDIUM });
    await textarea.fill("");
    await expect(textarea).toHaveValue("", { timeout: T_SHORT });

    // Blocked buttons stay focusable so their tooltip can explain what is missing.
    const commitBtn = hub.locator(SEL.reviewHub.commitButton(1));
    await expect(commitBtn).toBeVisible({ timeout: T_SHORT });
    await expect(commitBtn).toHaveAttribute("aria-disabled", "true", { timeout: T_MEDIUM });

    // Type a commit message
    await textarea.fill("test: add uncommitted file");

    await expect(commitBtn).not.toHaveAttribute("aria-disabled", "true", { timeout: T_MEDIUM });
  });

  test("committing clears file list and shows clean state", async () => {
    const { window } = ctx;

    const hub = window.locator(SEL.reviewHub.container);

    // Click the commit button
    const commitBtn = hub.locator(SEL.reviewHub.commitButton(1));
    await commitBtn.click();

    // Wait for commit to complete — commit button disappears (totalChanges drops to 0)
    await expect(commitBtn).toBeHidden({ timeout: T_LONG });

    // Clean state message should appear
    await expect(hub.locator(SEL.reviewHub.cleanState)).toBeVisible({ timeout: T_MEDIUM });

    // CommitPanel should unmount (textarea gone)
    await expect(hub.locator(SEL.reviewHub.commitMessageInput)).toBeHidden({ timeout: T_SHORT });
  });

  test("diff mode toggle disables base-branch view on a main-only repo", async () => {
    const { window } = ctx;

    const diffModeGroup = window.locator(SEL.reviewHub.diffMode);
    await expect(diffModeGroup).toBeVisible({ timeout: T_SHORT });

    // "Working tree" button is pressed initially.
    const workingTreeBtn = diffModeGroup.locator("button", { hasText: "Working tree" });
    await expect(workingTreeBtn).toHaveAttribute("aria-pressed", "true", { timeout: T_SHORT });

    // This fixture is opened on its main worktree, so the current branch IS the
    // base branch — you can't diff a branch against itself. The "vs <branch>"
    // button must be present but disabled, and clicking it must NOT switch modes.
    const baseBranchBtn = diffModeGroup.locator("button", { hasText: /^vs / });
    await expect(baseBranchBtn).toBeVisible({ timeout: T_SHORT });
    await expect(baseBranchBtn).toBeDisabled({ timeout: T_SHORT });
    await expect(baseBranchBtn).toHaveAttribute("aria-pressed", "false", { timeout: T_SHORT });

    // A force-click on the disabled control is inert: working-tree mode stays
    // active and the clean state stays visible.
    await baseBranchBtn.click({ force: true });
    await expect(workingTreeBtn).toHaveAttribute("aria-pressed", "true", { timeout: T_SHORT });

    const hub = window.locator(SEL.reviewHub.container);
    await expect(hub.locator(SEL.reviewHub.cleanState)).toBeVisible({ timeout: T_MEDIUM });
  });

  test("close button dismisses the hub", async () => {
    const { window } = ctx;

    const closeBtn = window.locator(SEL.reviewHub.close);
    await closeBtn.click();

    await expect(window.locator(SEL.reviewHub.container)).not.toBeVisible({ timeout: T_SHORT });
  });
});
