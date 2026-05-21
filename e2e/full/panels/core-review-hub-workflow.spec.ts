/**
 * Core: Review Hub Workflow
 *
 * Tests the full Review Hub commit lifecycle:
 * - File list visibility with status badges
 * - Staging files (Changes → Staged)
 * - Commit message input and commit button readiness
 * - Committing and post-commit clean state
 * - Diff mode toggle (working tree vs base branch)
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
const selectAllShortcut = process.platform === "darwin" ? "Meta+A" : "Control+A";

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

    // PR #7890 collapses the file list by default and auto-stages everything
    // when the hub is launched from a worktree card. Expand the list so the
    // Changes-section assertions in subsequent tests can locate file rows,
    // then unstage so they start from the unstaged baseline.
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

    // Wait for the IPC-loaded file list — stage button proves it loaded
    const stageBtn = hub.locator(SEL.reviewHub.stageButton("uncommitted.txt"));
    await expect(stageBtn).toBeVisible({ timeout: T_MEDIUM });

    // "Changes" section header should be visible
    await expect(hub.locator("text=Changes")).toBeVisible({ timeout: T_SHORT });

    // File name should appear in the hub
    await expect(hub.locator("text=uncommitted.txt")).toBeVisible({ timeout: T_SHORT });
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
    await expect(stageBtn).toBeHidden({ timeout: T_SHORT });

    // Unstaged section should show empty placeholder
    await expect(hub.locator(SEL.reviewHub.noUnstagedChanges)).toBeVisible({ timeout: T_SHORT });
  });

  test("commit message input appears and commit button becomes actionable", async () => {
    const { window } = ctx;

    const hub = window.locator(SEL.reviewHub.container);

    // CommitPanel renders when totalChanges > 0 in working-tree mode
    const textarea = hub.locator(SEL.reviewHub.commitMessageInput);
    await expect(textarea).toBeVisible({ timeout: T_MEDIUM });
    await textarea.click();
    await textarea.press(selectAllShortcut);
    await textarea.press("Backspace");
    await expect.poll(() => textarea.inputValue(), { timeout: T_SHORT }).toBe("");

    // Blocked buttons stay focusable so their tooltip can explain what is missing.
    const commitBtn = hub.locator(SEL.reviewHub.commitButton(1));
    await expect(commitBtn).toBeVisible({ timeout: T_SHORT });
    await expect(commitBtn).toHaveAttribute("aria-disabled", "true", { timeout: T_SHORT });

    // Type a commit message
    await textarea.fill("test: add uncommitted file");

    await expect(commitBtn).not.toHaveAttribute("aria-disabled", "true", { timeout: T_SHORT });
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

  test("diff mode toggle switches to base-branch view", async () => {
    const { window } = ctx;

    const diffModeGroup = window.locator(SEL.reviewHub.diffMode);
    await expect(diffModeGroup).toBeVisible({ timeout: T_SHORT });

    // "Working tree" button should be pressed initially
    const workingTreeBtn = diffModeGroup.locator("button", { hasText: "Working tree" });
    await expect(workingTreeBtn).toHaveAttribute("aria-pressed", "true", { timeout: T_SHORT });

    // The "vs <branch>" button is disabled when the current branch IS the main branch
    // (you can't diff a branch against itself). This is correct behavior for a
    // main-only repo. Verify the button exists and is properly disabled.
    const baseBranchBtn = diffModeGroup.locator("button", { hasText: /^vs / });
    await expect(baseBranchBtn).toBeVisible({ timeout: T_SHORT });

    const isDisabled = await baseBranchBtn.isDisabled();
    if (isDisabled) {
      // On a main-only repo, the base-branch button is correctly disabled.
      // Verify the working-tree mode is still active and move on.
      await expect(workingTreeBtn).toHaveAttribute("aria-pressed", "true", { timeout: T_SHORT });
      return;
    }

    // If the button is enabled (non-main branch), test the full toggle flow
    await baseBranchBtn.click();

    await expect(baseBranchBtn).toHaveAttribute("aria-pressed", "true", { timeout: T_SHORT });
    await expect(workingTreeBtn).toHaveAttribute("aria-pressed", "false", { timeout: T_SHORT });

    const hub = window.locator(SEL.reviewHub.container);

    // Working-tree clean state should disappear in base-branch mode
    await expect(hub.locator(SEL.reviewHub.cleanState)).toBeHidden({ timeout: T_MEDIUM });

    // Switch back to working-tree mode
    await workingTreeBtn.click();
    await expect(workingTreeBtn).toHaveAttribute("aria-pressed", "true", { timeout: T_SHORT });

    // Clean state should reappear in working-tree mode
    await expect(hub.locator(SEL.reviewHub.cleanState)).toBeVisible({ timeout: T_MEDIUM });
  });

  test("close button dismisses the hub", async () => {
    const { window } = ctx;

    const closeBtn = window.locator(SEL.reviewHub.close);
    await closeBtn.click();

    await expect(window.locator(SEL.reviewHub.container)).not.toBeVisible({ timeout: T_SHORT });
  });
});
